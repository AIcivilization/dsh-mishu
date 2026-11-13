/**
 * Writing and sending mail.
 *
 * A message is prepared before it is sent: addresses are checked, attachment
 * paths are resolved and measured, and the HTML is reduced to tags a mail
 * client will not choke on. Preparing is separate from sending on purpose —
 * the approval card shows exactly the recipients and files that will leave,
 * and what it shows is what `sendMail` sends.
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { domainToASCII } from 'node:url'
import { createTransport } from 'nodemailer'
import { bi, MishuError } from '../i18n.ts'
import { smtpOf, senderOf, type MailAccount, type MailAddress } from './account.ts'
import { stripHtml, tidy } from './parse.ts'

/** At most this many addresses in one field. */
const MAX_RECIPIENTS = 50
/** At most this many files on one message. */
const MAX_ATTACHMENTS = 20
/** At most this many bytes of attachments on one message. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** A body longer than this is refused rather than silently cut. */
const MAX_BODY_CHARS = 400_000

/** A file to send along, as it will be read at send time. */
export interface OutgoingAttachment {
  /** Absolute path on this machine. */
  path: string
  /** Name the recipient sees. */
  filename: string
  size: number
}

/** A message ready to leave: every field checked, every file measured. */
export interface PreparedMail {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string | null
  attachments: OutgoingAttachment[]
  inReplyTo: string | null
  references: string[]
}

/** What the caller asked to send, before any checking. */
export interface MailCompose {
  to: string
  cc?: string
  bcc?: string
  subject?: string
  text?: string
  html?: string
  /** Attachment paths: absolute, or relative to `cwd`. */
  attachments?: string[]
  inReplyTo?: string | null
  references?: string[]
}

export interface SendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
  response: string
}

/**
 * One address, canonical: `Name <addr@example.com>` or `addr@example.com`.
 *
 * Throws rather than guess: a message that goes to the wrong person cannot be
 * taken back, so a doubtful address stops the whole send.
 */
export function canonicalAddress(raw: string): string {
  const trimmed = raw.trim()
  // `<a@b>` alone loses its wrapper; `Name <a@b>` keeps its angle brackets so
  // the display name and the address can be told apart.
  const value = /^<[^<>]*>$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
  const angled = /^(.*?)<([^<>]+)>$/.exec(value)
  const name = angled === null ? '' : angled[1]!.trim().replace(/^"|"$/g, '')
  const address = (angled === null ? value : angled[2]!).trim().toLowerCase()
  const at = address.lastIndexOf('@')
  if (at <= 0 || at === address.length - 1) throw new MishuError(bi(`不是邮箱地址：${raw.trim() || '（空）'}`, `not an email address: ${raw.trim() || '(empty)'}`))
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  if (Buffer.byteLength(local, 'utf8') > 64) throw new MishuError(bi(`地址的 @ 前面太长了：${raw.trim()}`, `the part before @ is too long: ${raw.trim()}`))
  if (/[\u0000-\u001f\u007f\s]/.test(address)) throw new MishuError(bi(`地址里有空格或控制字符：${raw.trim()}`, `the address has a space or control character: ${raw.trim()}`))
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) throw new MishuError(bi(`地址里的点不对：${raw.trim()}`, `the dots in this address are wrong: ${raw.trim()}`))
  const ascii = domainToASCII(domain)
  if (ascii === '' || ascii.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(ascii)) {
    throw new MishuError(bi(`域名不对：${domain || '（空）'}`, `invalid domain: ${domain || '(empty)'}`))
  }
  const canonical = `${local}@${ascii}`
  if (name === '') return canonical
  const plain = name.replace(/["\\\r\n]/g, '').trim()
  if (plain === '') return canonical
  // A name with a comma, quote or angle bracket must keep its quotes, or the
  // address list reads as two recipients.
  const shown = /[",;:<>@()[\]\\]/.test(plain) ? `"${plain.replace(/"/g, '')}"` : plain
  return `${shown} <${canonical}>`
}

/** The bare address inside a canonical address. */
export function bareAddress(value: string): string {
  const angled = /<([^<>]+)>$/.exec(value)
  return (angled === null ? value : angled[1]!).trim().toLowerCase()
}

/** Split a comma or semicolon separated list and canonicalize each address. */
export function parseAddressList(raw: string | undefined): string[] {
  const text = (raw ?? '').trim()
  if (text === '') return []
  const out: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  const push = (piece: string): void => {
    const value = piece.trim()
    if (value !== '') out.push(canonicalAddress(value))
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') quoted = !quoted
    else if (quoted) continue
    else if (ch === '<') depth++
    else if (ch === '>') depth = Math.max(0, depth - 1)
    else if ((ch === ',' || ch === ';') && depth === 0) {
      push(text.slice(start, i))
      start = i + 1
    }
  }
  push(text.slice(start))
  if (out.length > MAX_RECIPIENTS) throw new MishuError(bi(`一次最多发给 ${MAX_RECIPIENTS} 个地址`, `at most ${MAX_RECIPIENTS} addresses at a time`))
  return out
}

/** Addresses in a list, lower-cased and de-duplicated, keeping the first spelling. */
function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of list) {
    const key = bareAddress(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

const DANGEROUS = /<(script|style|iframe|object|embed|form|input|button|select|textarea|link|meta|base|svg|math)\b[^>]*>[\s\S]*?<\/\1>|<(script|style|iframe|object|embed|form|input|button|select|textarea|link|meta|base|svg|math)\b[^>]*\/?>/gi

/**
 * Outgoing HTML reduced to what a mail client can show: no scripts, no
 * forms, no remote-including tags, no event attributes, no `javascript:`
 * links. Anything else is left as the author wrote it.
 */
export function sanitizeOutgoingHtml(html: string): string {
  return html
    .replace(DANGEROUS, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\sstyle\s*=\s*(?:"[^"]*expression[^"]*"|'[^']*expression[^']*')/gi, '')
    .replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*(?:"\s*data:(?!image\/(?:png|jpe?g|gif|webp))[^"]*"|'\s*data:(?!image\/(?:png|jpe?g|gif|webp))[^']*')/gi, '$1="#"')
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/** Plain text as simple HTML, when the sender wrote no HTML. */
export function textToHtml(text: string): string {
  const paragraphs = tidy(text).split(/\n{2,}/)
  return paragraphs
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

/** The text of an HTML body, for the plain-text alternative. */
export function htmlToText(html: string): string {
  return stripHtml(html)
}

/** Files measured and checked; a missing or oversized file stops the send. */
export async function resolveAttachments(paths: readonly string[], cwd: string): Promise<OutgoingAttachment[]> {
  if (paths.length > MAX_ATTACHMENTS) throw new MishuError(bi(`一次最多带 ${MAX_ATTACHMENTS} 个附件`, `at most ${MAX_ATTACHMENTS} attachments at a time`))
  const out: OutgoingAttachment[] = []
  let total = 0
  for (const raw of paths) {
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new MishuError(bi(`找不到附件：${raw}`, `no such attachment: ${raw}`))
    total += info.size
    if (total > MAX_ATTACHMENT_BYTES) throw new MishuError(bi(`附件总共超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB 了`, `the attachments add up to more than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`))
    out.push({ path, filename: raw.split(/[/\\]/).pop() ?? 'attachment.bin', size: info.size })
  }
  return out
}

/** Check a compose request and return the message that will be sent. */
export async function prepareMail(input: MailCompose, options: { account: MailAccount; cwd: string }): Promise<PreparedMail> {
  const to = dedupe(parseAddressList(input.to))
  const cc = dedupe(parseAddressList(input.cc))
  const bcc = dedupe(parseAddressList(input.bcc))
  if (to.length + cc.length + bcc.length === 0) throw new MishuError(bi('没有收件人', 'there is no recipient'))
  const text = (input.text ?? '').replace(/\r\n?/g, '\n')
  const html = input.html === undefined || input.html.trim() === '' ? null : sanitizeOutgoingHtml(input.html)
  if (text.length > MAX_BODY_CHARS || (html?.length ?? 0) > MAX_BODY_CHARS) throw new MishuError(bi('正文太长了', 'the body is too long'))
  const bodyText = text.trim() === '' && html !== null ? htmlToText(html) : text
  if (bodyText.trim() === '' && (input.attachments ?? []).length === 0) throw new MishuError(bi('正文是空的，也没有附件', 'the body is empty and there is nothing attached'))
  return {
    from: senderOf(options.account),
    to,
    cc,
    bcc,
    subject: (input.subject ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(),
    text: bodyText,
    html,
    attachments: await resolveAttachments(input.attachments ?? [], options.cwd),
    inReplyTo: input.inReplyTo ?? null,
    references: (input.references ?? []).filter(v => v.trim() !== ''),
  }
}

/** One line naming who a message goes to, for an approval card. */
export function describeRecipients(mail: Pick<PreparedMail, 'to' | 'cc' | 'bcc'>): string {
  const parts = [`To: ${mail.to.join(', ') || '—'}`]
  if (mail.cc.length > 0) parts.push(`Cc: ${mail.cc.join(', ')}`)
  if (mail.bcc.length > 0) parts.push(`Bcc: ${mail.bcc.join(', ')}`)
  return parts.join(' · ')
}

/** Send a prepared message through the account's SMTP server. */
export async function sendMail(account: MailAccount, password: string, mail: PreparedMail): Promise<SendResult> {
  const server = smtpOf(account)
  if (server.host === '') throw new MishuError(bi('这个账号还没填 SMTP 服务器，发不了信', 'this account has no SMTP server, so it cannot send'))
  const transport = createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user: account.user, pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  })
  try {
    const files = await Promise.all(mail.attachments.map(async file => ({
      filename: file.filename,
      content: await readFile(file.path),
    })))
    const info = await transport.sendMail({
      from: mail.from,
      to: mail.to,
      cc: mail.cc.length === 0 ? undefined : mail.cc,
      bcc: mail.bcc.length === 0 ? undefined : mail.bcc,
      subject: mail.subject,
      text: mail.text,
      html: mail.html ?? undefined,
      attachments: files,
      inReplyTo: mail.inReplyTo ?? undefined,
      references: mail.references.length === 0 ? undefined : mail.references,
      envelope: {
        from: bareAddress(mail.from),
        to: [...mail.to, ...mail.cc, ...mail.bcc].map(bareAddress),
      },
    })
    return {
      messageId: String(info.messageId ?? ''),
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: String(info.response ?? ''),
    }
  } finally {
    transport.close()
  }
}

/** Check that a password opens the account's SMTP server, without sending anything. */
export async function verifySmtp(account: MailAccount, password: string): Promise<void> {
  const server = smtpOf(account)
  if (server.host === '') throw new MishuError(bi('这个账号还没填 SMTP 服务器', 'this account has no SMTP server'))
  const transport = createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user: account.user, pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  })
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

/** Who a reply goes to: the sender back, everyone else in Cc, never yourself. */
export function replyTargets(original: { from: MailAddress | null; to: readonly MailAddress[]; cc: readonly MailAddress[] }, self: string): { to: string[]; cc: string[] } {
  const mine = self.trim().toLowerCase()
  const from = original.from?.address ?? ''
  const to = from !== '' && from !== mine ? [from] : original.to.map(a => a.address).filter(a => a !== mine).slice(0, 1)
  const cc = [...original.to.map(a => a.address), ...original.cc.map(a => a.address)]
    .filter(a => a !== mine && a !== from && a !== '')
  return { to: dedupe(to), cc: dedupe(cc) }
}

/** "Re: …" with a single prefix, whatever the original already had. */
export function replySubject(subject: string): string {
  const bare = subject.replace(/^\s*((re|aw|sv|答复|回复)\s*:\s*)+/i, '').trim()
  return bare === '' ? 'Re:' : `Re: ${bare}`
}

/** "Fwd: …" with a single prefix. */
export function forwardSubject(subject: string): string {
  const bare = subject.replace(/^\s*((fwd?|wg|转发)\s*:\s*)+/i, '').trim()
  return bare === '' ? 'Fwd:' : `Fwd: ${bare}`
}

/** The quoted body of a forward: the original, marked as quoted. */
export function forwardBody(original: { from: MailAddress | null; date: number; subject: string; text: string }): string {
  const when = new Date(original.date).toISOString().replace('T', ' ').slice(0, 16)
  const from = original.from === null ? '—' : original.from.name === '' ? original.from.address : `${original.from.name} <${original.from.address}>`
  const quoted = original.text.split('\n').map(line => `> ${line}`).join('\n')
  return `---------- Forwarded message ----------\nFrom: ${from}\nDate: ${when}\nSubject: ${original.subject}\n\n${quoted}`
}
