/**
 * Mail tools for the agent: read a mailbox, search it, move things around,
 * and — through an approval card — write and send.
 *
 * Nothing that leaves the machine happens on the model's word alone: sending
 * and replying are turned into an approval card by `mailApproval()` (wired to
 * `tools/pre-execute` in the shell), and the card shows the recipients, the
 * subject and the files that will actually go, because it is built from the
 * same `prepareMail()` the send itself uses.
 */

import { writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  bi, describeRecipients, errorText, MishuError, forwardSubject, htmlToText, parseAddressList, replySubject, replyTargets,
  sanitizeFilename, shortSubject, truncateText, uniqueFilename,
  type DraftView, type Lang, type MailAccount, type MailBody, type MailCompose, type MailFolder, type MailListPage,
  type MailSearchField, type MailSearchResult, type MailSummary, type PreparedMail,
} from '../core/index.ts'
import { loadDefineTool } from './tools.ts'

/** The mail tools that need an approval card before they run. */
export const MAIL_APPROVAL_TOOLS = ['mishu_mail_send', 'mishu_mail_reply', 'mishu_mail_draft', 'mishu_mail_mark'] as const

const ANY_JSON = { type: 'json' } as const

const textResult = {
  schema: ANY_JSON,
  render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
}

/** What the mail tools need from the running secretary. */
export interface MailToolDeps {
  lang: () => Lang
  /** Every account, for "which account is this?" and "only one? use it". */
  accounts: () => MailAccount[]
  list: (id: number, options: { folder?: string; limit?: number; offset?: number; unreadOnly?: boolean }) => Promise<MailListPage>
  read: (id: number, folder: string, uid: number, maxChars?: number) => Promise<MailBody>
  search: (id: number, options: { query: string; folder?: string; fields?: MailSearchField[]; limit?: number }) => Promise<MailSearchResult>
  mark: (id: number, folder: string, uid: number, action: 'read' | 'unread' | 'star' | 'unstar' | 'move' | 'delete' | 'purge', destination?: string) => Promise<{ uid: number; newUid: number | null; folder: string }>
  markMany: (id: number, folder: string, uids: number[], action: 'read' | 'unread' | 'star' | 'unstar' | 'move' | 'delete' | 'purge', destination?: string) => Promise<{ uid: number; newUid: number | null; folder: string }[]>
  folders: (id: number) => Promise<MailFolder[]>
  createFolder: (id: number, path: string) => Promise<MailFolder[]>
  renameFolder: (id: number, from: string, to: string) => Promise<MailFolder[]>
  deleteFolder: (id: number, path: string) => Promise<MailFolder[]>
  attachment: (id: number, folder: string, uid: number, index: number) => Promise<{ filename: string; contentType: string; content: Buffer }>
  /** Check a compose request without sending. */
  prepare: (id: number, compose: MailCompose) => Promise<PreparedMail>
  send: (id: number, mail: PreparedMail) => Promise<{ messageId: string; accepted: string[]; rejected: string[]; response: string }>
  drafts: (id: number) => DraftView[]
  saveDraft: (id: number, input: Partial<MailCompose> & { reply?: DraftView['reply'] }) => DraftView
  editDraft: (id: number, draftId: string, revision: number, patch: Record<string, unknown>) => DraftView
  sendDraft: (id: number, draftId: string, revision: number) => Promise<{ messageId: string }>
  scheduleDraft: (id: number, draftId: string, revision: number, sendAt: unknown) => DraftView
  cancelSchedule: (draftId: string, revision: number) => DraftView
  deleteDraft: (draftId: string) => void
  /** Where downloaded attachments are written. */
  inboxDir: string
}

/** "工作邮箱 (me@example.com)" — how an account is named in a tool result. */
const accountName = (account: MailAccount): string => `${account.label} <${account.address}>`

/**
 * The account a call means. One account is the default; with several, the
 * model must say which (`account` is the id from the settings page).
 */
export function pickAccount(accounts: readonly MailAccount[], id: number | undefined, lang: Lang): MailAccount {
  if (id !== undefined) {
    const found = accounts.find(a => a.id === id)
    if (found === undefined) throw new Error(lang === 'zh' ? `没有 #${id} 这个邮箱` : `there is no mail account #${id}`)
    return found
  }
  const enabled = accounts.filter(a => a.enabled)
  if (enabled.length === 1) return enabled[0]!
  if (accounts.length === 0) throw new Error(lang === 'zh' ? '还没有配置邮箱。在设置页加一个。' : 'no mail account is set up yet. Add one on the settings page.')
  const list = accounts.map(a => `#${a.id} ${accountName(a)}`).join(lang === 'zh' ? '；' : '; ')
  throw new Error(lang === 'zh' ? `有好几个邮箱，要说清是哪个：${list}` : `there are several accounts; say which one: ${list}`)
}

/** One listing row as a line: "2026-03-04 · Alice <a@x> · Subject · #12 (2 attachments)". */
export function summaryLine(m: MailSummary, lang: Lang): string {
  const when = new Date(m.date).toISOString().slice(0, 16).replace('T', ' ')
  const from = m.from === null ? '—' : m.from.name === '' ? m.from.address : `${m.from.name} <${m.from.address}>`
  const marks: string[] = []
  if (!m.seen) marks.push(lang === 'zh' ? '未读' : 'unread')
  if (m.flagged) marks.push(lang === 'zh' ? '星标' : 'starred')
  if (m.hasAttachments) marks.push(lang === 'zh' ? '有附件' : 'attachment')
  if (m.hasCalendar) marks.push(lang === 'zh' ? '日历' : 'calendar')
  const tail = marks.length === 0 ? '' : ` · ${marks.join('/')}`
  return `${when} · ${from} · ${shortSubject(m.subject)} · uid ${m.uid}${tail}`
}

/** A listing as text, with a heading that says where it is and how much. */
export function pageText(page: MailListPage, lang: Lang): string {
  const head = lang === 'zh'
    ? `${page.folder}：共 ${page.total} 封，这里 ${page.messages.length} 封`
    : `${page.folder}: ${page.total} messages, ${page.messages.length} here`
  if (page.messages.length === 0) return `${head}\n${lang === 'zh' ? '（这个范围里没有邮件）' : '(nothing in this range)'}`
  return `${head}\n${page.messages.map(m => summaryLine(m, lang)).join('\n')}`
}

/** One message as text: header lines, then the body, then the attachment list. */
export function bodyText(body: MailBody, lang: Lang): string {
  const from = body.from === null ? '—' : body.from.name === '' ? body.from.address : `${body.from.name} <${body.from.address}>`
  const lines = [
    lang === 'zh' ? `主题：${shortSubject(body.subject, 200)}` : `Subject: ${shortSubject(body.subject, 200)}`,
    lang === 'zh' ? `发件人：${from}` : `From: ${from}`,
    lang === 'zh' ? `时间：${new Date(body.date).toISOString().slice(0, 16).replace('T', ' ')}` : `Date: ${new Date(body.date).toISOString().slice(0, 16).replace('T', ' ')}`,
    lang === 'zh' ? `位置：${body.folder} · uid ${body.uid}` : `Folder: ${body.folder} · uid ${body.uid}`,
  ]
  if (body.to.length > 0) lines.push(`${lang === 'zh' ? '收件人' : 'To'}: ${body.to.map(a => a.address).join(', ')}`)
  if (body.cc.length > 0) lines.push(`Cc: ${body.cc.map(a => a.address).join(', ')}`)
  if (body.attachments.length > 0) {
    const files = body.attachments.map(a => `${a.index + 1}. ${a.filename} (${a.contentType}, ${a.size} B)`).join('; ')
    lines.push(lang === 'zh' ? `附件：${files}` : `Attachments: ${files}`)
  }
  return `${lines.join('\n')}\n\n${body.text}`
}

/** A folder listing as text. */
export function foldersText(folders: readonly MailFolder[], lang: Lang): string {
  if (folders.length === 0) return lang === 'zh' ? '这个邮箱没有文件夹' : 'this account has no folders'
  const lines = folders.map(f => {
    const special = f.specialUse === null ? '' : ` [${f.specialUse.replace(/^\\/, '')}]`
    const counts = f.messages === undefined ? '' : ` · ${f.messages}${f.unread === undefined ? '' : ` (${f.unread} ${lang === 'zh' ? '未读' : 'unread'})`}`
    return `${f.path}${special}${counts}`
  })
  return `${lang === 'zh' ? '文件夹' : 'Folders'}:\n${lines.join('\n')}`
}

/** A draft as text, so the model can show it before sending. */
export function draftText(draft: DraftView, lang: Lang): string {
  const lines = [
    `#${draft.id.slice(0, 8)} · ${lang === 'zh' ? '第' : 'revision '}${draft.revision}${lang === 'zh' ? '版' : ''}`,
    `${lang === 'zh' ? '发件' : 'From'}: ${draft.from}`,
    `${lang === 'zh' ? '收件人' : 'To'}: ${draft.to || '—'}`,
  ]
  if (draft.cc !== '') lines.push(`Cc: ${draft.cc}`)
  if (draft.bcc !== '') lines.push(`Bcc: ${draft.bcc}`)
  lines.push(`${lang === 'zh' ? '主题' : 'Subject'}: ${draft.subject || (lang === 'zh' ? '（无标题）' : '(no subject)')}`)
  if (draft.attachments.length > 0) lines.push(`${lang === 'zh' ? '附件' : 'Attachments'}: ${draft.attachments.join(', ')}`)
  if (draft.state === 'scheduled' && draft.sendAt !== null) {
    const when = new Date(draft.sendAt).toISOString()
    lines.push(`${lang === 'zh' ? '定时' : 'Scheduled'}: ${when}`)
  }
  if (draft.error !== null && draft.error !== '') lines.push(`${lang === 'zh' ? '上次没发出去' : 'Last attempt failed'}: ${draft.error}`)
  const body = draft.text.trim() !== '' ? draft.text : draft.html === null ? '' : htmlToText(draft.html)
  const cut = truncateText(body, 4000)
  return `${lines.join('\n')}\n\n${cut.text}`
}

/** Compose the approval card for a tool call, or `undefined` when nothing needs approving. */
export async function mailApproval(
  name: string,
  args: Record<string, unknown>,
  deps: MailToolDeps,
): Promise<{ zh: string; en: string } | undefined> {
  if (!(MAIL_APPROVAL_TOOLS as readonly string[]).includes(name)) return undefined
  const lang = deps.lang()
  try {
    // Every other mark is a flag or a move, both of which the person can undo.
    // Removing mail for good is the one action worth a card of its own.
    if (name === 'mishu_mail_mark') {
      if (String(args.action ?? '') !== 'purge') return undefined
      const account = pickAccount(deps.accounts(), Number(args.account) || undefined, lang)
      const count = Array.isArray(args.uids) ? args.uids.length : 1
      const folder = String(args.folder ?? 'INBOX')
      return {
        zh: `小秘书要把${count} 封从「${folder}」里彻底删掉，删了就找不回来了。\n账号：${account.label || account.address}`,
        en: `The secretary will remove ${count} message(s) from "${folder}" for good — there is no undo.\nAccount: ${account.label || account.address}`,
      }
    }
    if (name === 'mishu_mail_draft') {
      const action = String(args.action ?? '')
      if (action !== 'send' && action !== 'schedule') return undefined
      const id = Number(args.account)
      const account = pickAccount(deps.accounts(), Number.isInteger(id) ? id : undefined, lang)
      const draft = deps.drafts(account.id).find(d => d.id === String(args.draft_id ?? '') || d.id.startsWith(String(args.draft_id ?? '')))
      if (draft === undefined) return undefined
      const mail = await deps.prepare(account.id, {
        to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject,
        text: draft.text, html: draft.html ?? undefined, attachments: draft.attachments,
      })
      // Scheduling is a send with a delay, so it earns the same card — with the
      // time in it, because that is the part a person would want to check.
      if (action === 'schedule') {
        const card = composeCard(mail, account, 'schedule', draft.id.slice(0, 8))
        const when = String(args.send_at ?? '')
        return {
          zh: `${card.zh}\n\n定时：${when}（到点小秘书自己发，要在 DSH 里等着）`,
          en: `${card.en}\n\nScheduled: ${when} (the secretary sends it on its own, while DSH is running)`,
        }
      }
      return composeCard(mail, account, 'draft', draft.id.slice(0, 8))
    }
    const account = pickAccount(deps.accounts(), Number(args.account) || undefined, lang)
    if (name === 'mishu_mail_send') {
      const mail = await deps.prepare(account.id, composeOf(args))
      return composeCard(mail, account, 'send')
    }
    // mishu_mail_reply: the recipients come from the original, so the card
    // has to read it first — exactly what the send will do.
    const folder = String(args.folder ?? 'INBOX')
    const uid = Number(args.uid)
    if (!Number.isInteger(uid)) return undefined
    const original = await deps.read(account.id, folder, uid, 2000)
    const mode = String(args.mode ?? 'reply') as 'reply' | 'reply-all' | 'forward'
    // The card has to show the recipients the send will really use, so it
    // applies the same rule: typed beats derived.
    const typed = parseAddressList(String(args.to ?? ''))
    const typedCc = args.cc === undefined ? undefined : parseAddressList(String(args.cc))
    const derived = replyTargets(original, account.address)
    const targets = {
      to: typed.length > 0 ? typed : mode === 'forward' ? [] as string[] : derived.to,
      cc: typedCc ?? (mode === 'reply-all' ? derived.cc : [] as string[]),
    }
    const subject = mode === 'forward' ? forwardSubject(original.subject) : replySubject(original.subject)
    const mail = await deps.prepare(account.id, {
      to: targets.to.join(', '),
      cc: targets.cc.join(', '),
      bcc: parseAddressList(String(args.bcc ?? '')).join(', '),
      subject,
      text: String(args.text ?? ''),
      attachments: attachmentPaths(args.attachments),
    })
    return composeCard(mail, account, mode)
  } catch {
    // An invalid call is refused by execute() with a sentence; the card would say nothing useful.
    return undefined
  }
}

/** The compose fields of a `mishu_mail_send` call. */
export function composeOf(args: Record<string, unknown>): MailCompose {
  return {
    to: String(args.to ?? ''),
    cc: args.cc === undefined ? '' : String(args.cc),
    bcc: args.bcc === undefined ? '' : String(args.bcc),
    subject: args.subject === undefined ? '' : String(args.subject),
    text: args.text === undefined ? '' : String(args.text),
    html: args.html === undefined ? undefined : String(args.html),
    attachments: attachmentPaths(args.attachments),
  }
}

function attachmentPaths(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map(String).filter(v => v.trim() !== '')
  return String(value).split(/[\n;]+/).map(v => v.trim()).filter(v => v !== '')
}

/** The card: who it goes to, what it says, what it carries. */
function composeCard(mail: PreparedMail, account: MailAccount, mode: string, draftId?: string): { zh: string; en: string } {
  const files = mail.attachments.length === 0 ? '' : `\n${mail.attachments.map(a => `📎 ${a.filename} (${Math.round(a.size / 1024)} KB)`).join('\n')}`
  const body = truncateText(mail.text, 600).text
  const what: Record<string, { zh: string; en: string }> = {
    send: { zh: '发一封新邮件', en: 'send a new message' },
    reply: { zh: '回复这封邮件', en: 'reply to this message' },
    'reply-all': { zh: '回复全部', en: 'reply to everyone' },
    forward: { zh: '转发这封邮件', en: 'forward this message' },
    draft: { zh: `发出草稿 #${draftId ?? ''}`, en: `send draft #${draftId ?? ''}` },
    schedule: { zh: `把草稿 #${draftId ?? ''} 排进定时`, en: `schedule draft #${draftId ?? ''}` },
  }
  const label = what[mode] ?? { zh: '发邮件', en: 'send mail' }
  return {
    zh: `小秘书要${label.zh}（从 ${accountName(account)}），请核对：\n${describeRecipients(mail)}\n主题：${mail.subject || '（无标题）'}${files}\n\n${body}`,
    en: `The secretary will ${label.en} from ${accountName(account)}. Please check:\n${describeRecipients(mail)}\nSubject: ${mail.subject || '(no subject)'}${files}\n\n${body}`,
  }
}

/** Register the mail tools on a DSH tools registry. */
export async function registerMailTools(tools: { register(definition: unknown): unknown }, deps: MailToolDeps): Promise<void> {
  const defineTool = await loadDefineTool()
  const lang = () => deps.lang()
  const fail = (error: unknown): never => { throw new Error(errorText(error, lang())) }
  const accountOf = (id: unknown): MailAccount => pickAccount(deps.accounts(), Number(id) || undefined, lang())
  const run = async <T>(body: () => Promise<T>): Promise<T> => {
    try {
      return await body()
    } catch (error) {
      return fail(error)
    }
  }

  tools.register(defineTool({
    name: 'mishu_mail_list',
    description: [
      'List the newest messages in one folder of the user\'s mailbox (headers only, no bodies).',
      'Returns one line per message with its date, sender, subject, uid, and whether it is unread, starred or carries attachments.',
      'Use the uid with mishu_mail_read / mishu_mail_mark. Newest first.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id from the settings page; omit when there is only one' },
      folder: { type: 'string', description: 'Folder path, INBOX by default (see mishu_mail_folders)' },
      limit: { type: 'integer', description: 'How many messages, 1-100 (default 20)' },
      offset: { type: 'integer', description: 'Skip this many of the newest messages, for paging' },
      unread_only: { type: 'boolean', description: 'Only unread messages' },
    },
    output: textResult,
    execute: (args: { account?: number; folder?: string; limit?: number; offset?: number; unread_only?: boolean }) => run(async () => {
      const account = accountOf(args.account)
      const page = await deps.list(account.id, {
        ...args.folder === undefined ? {} : { folder: args.folder },
        ...args.limit === undefined ? {} : { limit: Number(args.limit) },
        ...args.offset === undefined ? {} : { offset: Number(args.offset) },
        ...args.unread_only === undefined ? {} : { unreadOnly: args.unread_only },
      })
      return { text: pageText(page, lang()) }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_read',
    description: [
      'Read one message in full: header lines, the plain-text body (HTML is converted), and the attachment list.',
      'Reading never marks it read; use mishu_mail_mark for that. Very long bodies are cut with a note saying how long they were.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      uid: { type: 'integer', required: true, description: 'Message uid from mishu_mail_list' },
      folder: { type: 'string', description: 'Folder path, INBOX by default' },
      max_chars: { type: 'integer', description: 'Cut the body after this many characters (default 20000)' },
    },
    output: textResult,
    execute: (args: { account?: number; uid: number; folder?: string; max_chars?: number }) => run(async () => {
      const account = accountOf(args.account)
      const body = await deps.read(account.id, args.folder ?? 'INBOX', Number(args.uid), args.max_chars === undefined ? 20_000 : Number(args.max_chars))
      return { text: bodyText(body, lang()) }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_search',
    description: [
      'Search one folder of the mailbox. Headers first (subject, from, to, cc); with fields including "body" it also opens recent bodies.',
      'The result says where the hits came from (the server, a local header scan, or a body scan) and how many messages were looked at.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      query: { type: 'string', required: true, description: 'What to look for' },
      folder: { type: 'string', description: 'Folder path, INBOX by default' },
      fields: { type: 'string', description: 'Comma separated: subject, from, to, cc, body (default subject, from, to)' },
      limit: { type: 'integer', description: 'How many hits, 1-100 (default 20)' },
    },
    output: textResult,
    execute: (args: { account?: number; query: string; folder?: string; fields?: string; limit?: number }) => run(async () => {
      const account = accountOf(args.account)
      const fields = (args.fields ?? '').split(',').map(f => f.trim()).filter((f): f is MailSearchField => ['subject', 'from', 'to', 'cc', 'body'].includes(f))
      const found = await deps.search(account.id, {
        query: String(args.query),
        ...args.folder === undefined ? {} : { folder: args.folder },
        ...fields.length === 0 ? {} : { fields },
        ...args.limit === undefined ? {} : { limit: Number(args.limit) },
      })
      const where = { server: '服务器', 'local-headers': '本地扫描标题', 'local-body': '本地扫描正文' }
      const whereEn = { server: 'the server', 'local-headers': 'a local header scan', 'local-body': 'a local body scan' }
      const head = lang() === 'zh'
        ? `${found.folder}：找到 ${found.messages.length} 封（${where[found.source]}，看了 ${found.scanned} 封）`
        : `${found.folder}: ${found.messages.length} hits (${whereEn[found.source]}, ${found.scanned} messages looked at)`
      const lines = found.messages.map(m => summaryLine(m, lang())).join('\n')
      return { text: found.messages.length === 0 ? head : `${head}\n${lines}` }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_mark',
    description: [
      'Change messages: mark read or unread, star or unstar, move them to another folder, or delete them.',
      'delete moves a message into the Trash folder; purge removes it for good and only works inside Trash.',
      'Pass one uid, or uids to do the same thing to several at once (at most 20).',
      'Moving gives the message a new uid in the destination folder, which is returned; use that uid afterwards.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      uid: { type: 'integer', description: 'One message uid' },
      uids: { type: 'array', items: { type: 'integer' }, description: 'Several message uids, at most 20' },
      action: { type: 'string', enum: ['read', 'unread', 'star', 'unstar', 'move', 'delete', 'purge'], required: true, description: 'read, unread, star, unstar, move, delete or purge' },
      folder: { type: 'string', description: 'Folder the messages are in, INBOX by default' },
      destination: { type: 'string', description: 'Folder to move them to (required for move)' },
    },
    output: textResult,
    execute: (args: { account?: number; uid?: number; uids?: number[]; action: 'read' | 'unread' | 'star' | 'unstar' | 'move' | 'delete' | 'purge'; folder?: string; destination?: string }) => run(async () => {
      const account = accountOf(args.account)
      const folder = args.folder ?? 'INBOX'
      const many = Array.isArray(args.uids) && args.uids.length > 0
      const uids = many ? args.uids!.map(Number) : args.uid === undefined ? [] : [Number(args.uid)]
      if (uids.length === 0) throw new MishuError(bi('要说清是哪几封（uid 或 uids）', 'name the messages (uid or uids)'))
      const results = many
        ? await deps.markMany(account.id, folder, uids, args.action, args.destination)
        : [await deps.mark(account.id, folder, uids[0]!, args.action, args.destination)]
      const words: Record<string, { zh: string; en: string }> = {
        read: { zh: '标为已读', en: 'marked read' },
        unread: { zh: '标为未读', en: 'marked unread' },
        star: { zh: '加了星标', en: 'starred' },
        unstar: { zh: '去掉了星标', en: 'unstarred' },
        move: { zh: '移到了', en: 'moved to' },
        delete: { zh: '移进了废纸篓', en: 'moved to Trash' },
        purge: { zh: '彻底删了', en: 'removed for good' },
      }
      const word = words[args.action] ?? { zh: '改好了', en: 'done' }
      const where = args.action === 'move' ? ` ${results[0]?.folder ?? ''}` : ''
      if (many) {
        return { text: lang() === 'zh' ? `${results.length} 封${word.zh}${where}` : `${results.length} messages ${word.en}${where}` }
      }
      const one = results[0]!
      const newUid = one.newUid === null ? '' : lang() === 'zh' ? `，新的 uid 是 ${one.newUid}` : `, new uid ${one.newUid}`
      return { text: lang() === 'zh' ? `uid ${one.uid} 已${word.zh}${where}${newUid}` : `uid ${one.uid} ${word.en}${where}${newUid}` }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_folders',
    description: [
      'List the mailbox\'s folders with their message and unread counts, so folder paths can be used elsewhere.',
      'Without action it only lists. action=create makes a new folder, action=rename renames one, action=delete removes an empty one.',
      'The mailbox\'s own folders (Inbox, Sent, Drafts, Trash, Junk, Archive) cannot be renamed or deleted, and a folder that still holds messages is not deleted either.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      action: { type: 'string', enum: ['list', 'create', 'rename', 'delete'], description: 'list (default), create, rename or delete' },
      path: { type: 'string', description: 'Folder path, for create and delete' },
      from: { type: 'string', description: 'For rename: the folder as it is now' },
      to: { type: 'string', description: 'For rename: the new name' },
    },
    output: textResult,
    execute: (args: { account?: number; action?: 'list' | 'create' | 'rename' | 'delete'; path?: string; from?: string; to?: string }) => run(async () => {
      const account = accountOf(args.account)
      const action = args.action ?? 'list'
      if (action === 'list') return { text: foldersText(await deps.folders(account.id), lang()) }
      const rows = action === 'create'
        ? await deps.createFolder(account.id, String(args.path ?? ''))
        : action === 'rename'
          ? await deps.renameFolder(account.id, String(args.from ?? ''), String(args.to ?? ''))
          : await deps.deleteFolder(account.id, String(args.path ?? ''))
      const done = {
        create: { zh: `建好了「${String(args.path ?? '')}」`, en: `created "${String(args.path ?? '')}"` },
        rename: { zh: `「${String(args.from ?? '')}」改成了「${String(args.to ?? '')}」`, en: `renamed "${String(args.from ?? '')}" to "${String(args.to ?? '')}"` },
        delete: { zh: `「${String(args.path ?? '')}」删掉了`, en: `deleted "${String(args.path ?? '')}"` },
      }[action]
      return { text: `${done[lang()]}\n${foldersText(rows, lang())}` }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_attachment',
    description: [
      'Download one attachment of a message into the secretary\'s folder on this machine and return its path.',
      'Use the index from mishu_mail_read (1 is the first attachment). Nothing is opened or run.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      uid: { type: 'integer', required: true, description: 'Message uid' },
      index: { type: 'integer', required: true, description: 'Which attachment, 1 for the first' },
      folder: { type: 'string', description: 'Folder the message is in, INBOX by default' },
    },
    output: textResult,
    execute: (args: { account?: number; uid: number; index: number; folder?: string }) => run(async () => {
      const account = accountOf(args.account)
      const file = await deps.attachment(account.id, args.folder ?? 'INBOX', Number(args.uid), Math.max(0, Number(args.index) - 1))
      const name = sanitizeFilename(file.filename)
      const target = join(deps.inboxDir, uniqueFilename(name, new Set()))
      await writeFile(target, file.content)
      const shown = isAbsolute(target) ? target : join(deps.inboxDir, target)
      return { text: lang() === 'zh' ? `已存到 ${shown}（${file.content.length} 字节）` : `saved to ${shown} (${file.content.length} bytes)` }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_send',
    description: [
      'Write and send a new email from one of the user\'s accounts.',
      'The user sees the recipients, subject, body and attachments and approves before anything leaves, so pass exactly what they asked for.',
      'Attachments are paths on this machine (absolute, or relative to the mishu home).',
      'To keep something for later instead, use mishu_mail_draft.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      to: { type: 'string', required: true, description: 'Recipients, comma separated' },
      cc: { type: 'string', description: 'Cc, comma separated' },
      bcc: { type: 'string', description: 'Bcc, comma separated' },
      subject: { type: 'string', description: 'Subject line' },
      text: { type: 'string', description: 'Body, plain text' },
      html: { type: 'string', description: 'Body as HTML, when the user asked for formatting' },
      attachments: { type: 'string', description: 'File paths, comma or newline separated' },
    },
    output: textResult,
    execute: (args: Record<string, unknown>) => run(async () => {
      const account = accountOf(args.account)
      const mail = await deps.prepare(account.id, composeOf(args))
      const sent = await deps.send(account.id, mail)
      const count = sent.accepted.length
      return {
        text: lang() === 'zh'
          ? `发出去了（${count} 个收件人${sent.rejected.length > 0 ? `，${sent.rejected.length} 个被拒` : ''}）。${mail.subject === '' ? '' : `主题「${mail.subject}」。`}`
          : `Sent (${count} recipients${sent.rejected.length > 0 ? `, ${sent.rejected.length} rejected` : ''}).${mail.subject === '' ? '' : ` Subject "${mail.subject}".`}`,
      }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_reply',
    description: [
      'Reply to, reply to all of, or forward one message.',
      'For reply and reply-all the recipients come from the original (the sender back, everyone else in Cc, never the user\'s own address); for forward they are given.',
      'The subject gets a single Re: or Fwd: prefix and the thread headers are kept, so it lands in the same conversation.',
      'The user approves the recipients before it leaves.',
    ].join(' '),
    parameters: {
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      uid: { type: 'integer', required: true, description: 'uid of the message being answered' },
      mode: { type: 'string', enum: ['reply', 'reply-all', 'forward'], description: 'reply (default), reply-all or forward' },
      text: { type: 'string', required: true, description: 'What to write; the original is not quoted automatically, so include what matters' },
      to: { type: 'string', description: 'For forward: the recipients; for a reply it overrides the sender' },
      cc: { type: 'string', description: 'Extra Cc addresses; reply-all adds the original Cc to them' },
      bcc: { type: 'string', description: 'Blind copies, never taken from the original' },
      folder: { type: 'string', description: 'Folder the original is in, INBOX by default' },
      attachments: { type: 'string', description: 'File paths to attach, comma or newline separated' },
    },
    output: textResult,
    execute: (args: { account?: number; uid: number; mode?: 'reply' | 'reply-all' | 'forward'; text: string; to?: string; cc?: string; bcc?: string; folder?: string; attachments?: string }) => run(async () => {
      const account = accountOf(args.account)
      const folder = args.folder ?? 'INBOX'
      const original = await deps.read(account.id, folder, Number(args.uid), 4000)
      const mode = args.mode ?? 'reply'
      // A typed address wins over a derived one, the same rule the panel and
      // the API follow: what you said beats what the original implied.
      const typed = parseAddressList(args.to ?? '')
      const typedCc = args.cc === undefined ? undefined : parseAddressList(args.cc)
      const derived = replyTargets(original, account.address)
      const targets = {
        to: typed.length > 0 ? typed : mode === 'forward' ? [] as string[] : derived.to,
        cc: typedCc ?? (mode === 'reply-all' ? derived.cc : [] as string[]),
      }
      if (targets.to.length === 0) throw new Error(lang() === 'zh' ? '这封邮件没有可回复的地址' : 'this message has no address to answer')
      const subject = mode === 'forward' ? forwardSubject(original.subject) : replySubject(original.subject)
      const mail = await deps.prepare(account.id, {
        to: targets.to.join(', '),
        cc: targets.cc.join(', '),
        bcc: parseAddressList(args.bcc ?? '').join(', '),
        subject,
        text: args.text,
        attachments: attachmentPaths(args.attachments),
        inReplyTo: original.messageId,
        references: original.messageId === null ? [] : [original.messageId],
      })
      const sent = await deps.send(account.id, mail)
      return {
        text: lang() === 'zh'
          ? `${mode === 'forward' ? '转发' : mode === 'reply-all' ? '回复全部' : '回复'}发出去了（${sent.accepted.length} 个收件人）。`
          : `${mode === 'forward' ? 'Forwarded' : mode === 'reply-all' ? 'Replied to all' : 'Replied'} (${sent.accepted.length} recipients).`,
      }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_mail_draft',
    description: [
      'Keep a message as a draft in the secretary\'s notebook instead of sending it, and later send or delete it.',
      'action=new saves a new draft; action=list shows the drafts; action=show shows one; action=update changes one (needs its revision); action=send sends one (the user approves the recipients first); action=delete throws one away.',
      'action=schedule puts a draft on the clock: send_at must be an ISO 8601 time WITH its timezone (2026-11-20T09:00:00+08:00), at least 30 seconds and at most a year ahead, and the draft must already have recipients. action=cancel takes it off the clock again. A scheduled message is sent by the secretary itself while DSH is running; if that send fails the draft comes back with the reason attached instead of retrying on its own.',
      'A draft survives restarts and never appears in the mailbox\'s Drafts folder.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['new', 'list', 'show', 'update', 'send', 'delete', 'schedule', 'cancel'], required: true, description: 'new, list, show, update, send, delete, schedule or cancel' },
      send_at: { type: 'string', description: 'For schedule: an ISO 8601 time with its timezone, e.g. 2026-11-20T09:00:00+08:00' },
      account: { type: 'integer', description: 'Account id; omit when there is only one' },
      draft_id: { type: 'string', description: 'Draft id (its first characters are enough)' },
      revision: { type: 'integer', description: 'For update and send: the revision the user saw' },
      to: { type: 'string', description: 'Recipients, comma separated' },
      cc: { type: 'string', description: 'Cc' },
      bcc: { type: 'string', description: 'Bcc' },
      subject: { type: 'string', description: 'Subject' },
      text: { type: 'string', description: 'Body' },
      attachments: { type: 'string', description: 'File paths, comma or newline separated' },
    },
    output: textResult,
    execute: (args: Record<string, unknown>) => run(async () => {
      const action = String(args.action)
      const account = accountOf(args.account)
      const lang_ = lang()
      const find = (raw: unknown): DraftView => {
        const key = String(raw ?? '')
        if (key === '') throw new Error(lang_ === 'zh' ? '要说清是哪封草稿（draft_id）' : 'say which draft (draft_id)')
        const found = deps.drafts(account.id).find(d => d.id === key || d.id.startsWith(key))
        if (found === undefined) throw new Error(lang_ === 'zh' ? `没有这封草稿：${key}` : `no such draft: ${key}`)
        return found
      }
      if (action === 'new') {
        const draft = deps.saveDraft(account.id, {
          to: args.to === undefined ? '' : String(args.to),
          cc: args.cc === undefined ? '' : String(args.cc),
          bcc: args.bcc === undefined ? '' : String(args.bcc),
          subject: args.subject === undefined ? '' : String(args.subject),
          text: args.text === undefined ? '' : String(args.text),
          attachments: attachmentPaths(args.attachments),
        })
        return { text: lang_ === 'zh' ? `草稿存好了。\n${draftText(draft, lang_)}` : `Draft saved.\n${draftText(draft, lang_)}` }
      }
      if (action === 'list') {
        const list = deps.drafts(account.id)
        if (list.length === 0) return { text: lang_ === 'zh' ? '草稿箱是空的' : 'there are no drafts' }
        return { text: list.map(d => draftText(d, lang_)).join('\n\n———\n\n') }
      }
      if (action === 'show') return { text: draftText(find(args.draft_id), lang_) }
      if (action === 'delete') {
        const draft = find(args.draft_id)
        deps.deleteDraft(draft.id)
        return { text: lang_ === 'zh' ? `草稿 #${draft.id.slice(0, 8)} 删掉了` : `draft #${draft.id.slice(0, 8)} deleted` }
      }
      const draft = find(args.draft_id)
      const revision = args.revision === undefined ? draft.revision : Number(args.revision)
      if (action === 'send') {
        const sent = await deps.sendDraft(account.id, draft.id, revision)
        return {
          text: lang_ === 'zh'
            ? `草稿 #${draft.id.slice(0, 8)} 发出去了。${sent.messageId === '' ? '' : ` Message-ID ${sent.messageId}`}`
            : `draft #${draft.id.slice(0, 8)} sent.${sent.messageId === '' ? '' : ` Message-ID ${sent.messageId}`}`,
        }
      }
      if (action === 'schedule') {
        if (args.send_at === undefined) throw new Error(lang_ === 'zh' ? '要说清什么时候发（send_at，带时区）' : 'say when it should go (send_at, with its timezone)')
        const next = deps.scheduleDraft(account.id, draft.id, revision, args.send_at)
        return { text: lang_ === 'zh' ? `定好了，到点会发。\n${draftText(next, lang_)}` : `Scheduled.\n${draftText(next, lang_)}` }
      }
      if (action === 'cancel') {
        const next = deps.cancelSchedule(draft.id, revision)
        return { text: lang_ === 'zh' ? `定时取消了，草稿还在。\n${draftText(next, lang_)}` : `Schedule cancelled; the draft stays.\n${draftText(next, lang_)}` }
      }
      const patch: Record<string, unknown> = {}
      for (const field of ['to', 'cc', 'bcc', 'subject', 'text'] as const) {
        if (args[field] !== undefined) patch[field] = String(args[field])
      }
      if (args.attachments !== undefined) patch.attachments = attachmentPaths(args.attachments)
      const next = deps.editDraft(account.id, draft.id, revision, patch)
      return { text: lang_ === 'zh' ? `草稿改好了（第 ${next.revision} 版）。\n${draftText(next, lang_)}` : `Draft updated (revision ${next.revision}).\n${draftText(next, lang_)}` }
    }),
  }))
}

/** The sentence a tool result uses for a mail account, exported for the API's view. */
export const mailAccountLabel = (account: MailAccount): string => accountName(account)

/** A one-line description of what a card would say, for tests. */
export function cardSummary(card: { zh: string; en: string }, lang: Lang): string {
  return pick(card, lang)
}

function pick(card: { zh: string; en: string }, lang: Lang): string {
  return lang === 'zh' ? card.zh : card.en
}

/** Bilingual helper kept next to its only user, so the tools file stays free of wording. */
export const mailError = (zh: string, en: string) => bi(zh, en)
