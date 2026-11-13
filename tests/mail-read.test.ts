import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  MailAccount, MailBody, MailFetcher, MailFolder, MailListOptions, MailListPage, MailMarkAction,
  MailSearchOptions, MailSearchResult, MailSummary,
} from '../src/core/mail/account.ts'
import { collectParts, matchesQuery, toSummary } from '../src/core/mail/imap.ts'
import {
  canonicalAddress, forwardSubject, htmlToText, parseAddressList, prepareMail, replySubject, replyTargets,
  sanitizeOutgoingHtml, textToHtml, type PreparedMail,
} from '../src/core/mail/send.ts'
import { claimDraft, draftToCompose, editDraft, MAX_DRAFTS, saveDraft, type DraftView } from '../src/core/mail/draft.ts'
import { cancelSchedule, isScheduled, scheduledTime, scheduleDraft } from '../src/core/mail/schedule.ts'
import { decodeEntities, sanitizeFilename, shortSubject, stripHtml, truncateText, uniqueFilename } from '../src/core/mail/parse.ts'
import { bi, MishuError } from '../src/core/i18n.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { MishuStore } from '../src/core/store.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { mailApproval, pageText, bodyText } from '../src/dsh/mail-tools.ts'
import { Runtime } from '../src/dsh/runtime.ts'
import { ACCOUNT, MAIL_NOW } from './fixtures/synthetic-mail.ts'

const summary = (uid: number, over: Partial<MailSummary> = {}): MailSummary => ({
  id: `mail:1:${uid}`, uid, messageId: `<m${uid}@mail.example>`, subject: `Message ${uid}`,
  date: MAIL_NOW - uid * 60_000, from: { name: 'Alice', address: 'alice@example.org' }, to: [], cc: [],
  size: 1024, seen: false, flagged: false, answered: false, hasAttachments: false, hasCalendar: false,
  folder: 'INBOX', ...over,
})

const bodyOf = (uid: number, over: Partial<MailBody> = {}): MailBody => ({
  ...summary(uid), text: `Body of ${uid}`, html: null, attachments: [], truncated: false, ...over,
})

/** What the person would read: a MishuError carries both languages, and we check the Chinese. */
const zhOf = (error: unknown): string => (error instanceof MishuError ? error.text.zh : (error as Error).message)

/** Assert that something refuses, and that its Chinese sentence says `pattern`. */
function throwsZh(run: () => unknown, pattern: RegExp): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  assert.notEqual(caught, undefined, `expected a refusal matching ${pattern}`)
  assert.match(zhOf(caught), pattern)
}

async function rejectsZh(run: Promise<unknown> | (() => Promise<unknown>), pattern: RegExp): Promise<void> {
  let caught: unknown
  try {
    await (typeof run === 'function' ? run() : run)
  } catch (error) {
    caught = error
  }
  assert.notEqual(caught, undefined, `expected a refusal matching ${pattern}`)
  assert.match(zhOf(caught), pattern)
}

/** A mailbox that answers without a network, and remembers what it was asked. */
function fakeMailbox(options: { list?: MailSummary[]; body?: MailBody; search?: MailSearchResult } = {}) {
  const calls: string[] = []
  const listed = options.list ?? [summary(3), summary(2), summary(1)]
  const fetcher: MailFetcher = {
    unread: async () => [],
    list: async (_a, _p, o: MailListOptions): Promise<MailListPage> => {
      calls.push(`list ${o.folder ?? 'INBOX'} ${o.limit ?? ''} ${o.offset ?? ''} ${o.unreadOnly === true}`)
      return { folder: o.folder ?? 'INBOX', total: listed.length, messages: listed }
    },
    read: async (_a, _p, folder, uid): Promise<MailBody> => {
      calls.push(`read ${folder} ${uid}`)
      return options.body ?? bodyOf(uid)
    },
    search: async (_a, _p, o: MailSearchOptions): Promise<MailSearchResult> => {
      calls.push(`search ${o.query}`)
      return options.search ?? { folder: 'INBOX', source: 'server', scanned: 3, messages: [summary(2)] }
    },
    mark: async (_a, _p, folder, uid, action: MailMarkAction, destination): Promise<{ uid: number; newUid: number | null; folder: string }> => {
      calls.push(`mark ${action} ${uid} ${destination ?? ''}`)
      return { uid, newUid: action === 'move' ? 99 : null, folder: destination ?? folder }
    },
    folders: async (): Promise<MailFolder[]> => [
      { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: [], messages: 12, unread: 3 },
      { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: null, flags: [] },
    ],
  }
  return { fetcher, calls }
}

function runtimeWith(fetcher: MailFetcher, home = mkdtempSync(join(tmpdir(), 'mishu-mail-'))) {
  const store = MishuStore.open(':memory:')
  store.set('mail.accounts', [ACCOUNT])
  const secrets = new MemorySecrets()
  void secrets.set('mail:1', 'app-password')
  const runtime = new Runtime(Config({ home }), { info() {}, warn() {} }, secrets, fetcher)
  runtime.store = store
  return { runtime, store, home, secrets }
}

test('an HTML body becomes text with its paragraphs; a long body says how long it was', () => {
  const html = '<html><head><title>t</title><style>p{}</style></head><body><p>Hello &amp; welcome</p><p>Second<br>line</p><script>x()</script></body></html>'
  assert.equal(stripHtml(html), 'Hello & welcome\n\nSecond\nline')
  assert.equal(decodeEntities('&lt;b&gt; &amp; &#65; &#x42; &unknown;'), '<b> & A B &unknown;')
  const long = truncateText('a'.repeat(50) + '\n' + 'b'.repeat(50), 60)
  assert.equal(long.truncated, true)
  assert.match(long.text, /正文过长，已截断，共 101 字/)
  assert.equal(truncateText('short', 60).truncated, false)
  assert.equal(shortSubject('   '), '（无标题）')
  assert.equal(shortSubject('x'.repeat(100), 10).length, 10)
})

test('a filename is made safe, and a second copy gets a number', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFilename('a:b*c?.pdf'), 'a_b_c_.pdf')
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt')
  assert.equal(sanitizeFilename('   '), 'attachment.bin')
  assert.equal(sanitizeFilename(`${'x'.repeat(200)}.pdf`).endsWith('.pdf'), true)
  assert.equal(uniqueFilename('report.pdf', new Set()), 'report.pdf')
  assert.equal(uniqueFilename('report.pdf', new Set(['report.pdf'])), 'report (2).pdf')
})

test('an address is checked rather than guessed; a list splits on commas outside angle brackets', () => {
  assert.equal(canonicalAddress(' Me@Example.COM '), 'me@example.com')
  assert.equal(canonicalAddress('Alice <Alice@Example.org>'), 'Alice <alice@example.org>')
  throwsZh(() => canonicalAddress('not-an-address'), /不是邮箱地址/)
  throwsZh(() => canonicalAddress('a@'), /不是邮箱地址/)
  throwsZh(() => canonicalAddress('.a@example.com'), /点不对/)
  throwsZh(() => canonicalAddress('a@exa mple.com'), /空格或控制字符/)
  assert.deepEqual(parseAddressList('a@example.com, "Doe, J" <b@example.org>; c@example.net'), [
    'a@example.com', '"Doe, J" <b@example.org>', 'c@example.net',
  ])
  assert.deepEqual(parseAddressList('  '), [])
})

test('outgoing HTML loses scripts, forms and javascript: links; text becomes paragraphs', () => {
  const dirty = '<p onclick="x()">hi</p><script>bad()</script><a href="javascript:alert(1)">t</a><form><input></form>'
  const clean = sanitizeOutgoingHtml(dirty)
  assert.doesNotMatch(clean, /script|onclick|javascript:|<form|<input/)
  assert.match(clean, /<p>hi<\/p>/)
  assert.equal(textToHtml('one\n\ntwo'), '<p>one</p>\n<p>two</p>')
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\n\nb')
})

test('a reply answers the sender, keeps the others in Cc and never writes to yourself', () => {
  const original = {
    from: { name: 'Alice', address: 'alice@example.org' },
    to: [{ name: 'Me', address: 'me@example.com' }],
    cc: [{ name: 'Bob', address: 'bob@example.org' }],
  }
  assert.deepEqual(replyTargets(original, 'me@example.com'), { to: ['alice@example.org'], cc: ['bob@example.org'] })
  assert.equal(replySubject('Re: Re: Contract draft'), 'Re: Contract draft')
  assert.equal(replySubject(''), 'Re:')
  assert.equal(forwardSubject('Fwd: Fwd: Contract'), 'Fwd: Contract')
})

test('preparing a message checks recipients, body and files before anything leaves', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mishu-send-'))
  try {
    writeFileSync(join(home, 'note.txt'), 'hello')
    const mail = await prepareMail(
      { to: 'Alice <alice@example.org>', cc: 'bob@example.org', subject: 'Hi\n there', text: 'Body', attachments: ['note.txt'] },
      { account: ACCOUNT, cwd: home },
    )
    assert.equal(mail.from, '工作邮箱 <me@example.com>')
    assert.deepEqual(mail.to, ['Alice <alice@example.org>'])
    assert.deepEqual(mail.cc, ['bob@example.org'])
    assert.equal(mail.subject, 'Hi there', 'a newline in the subject is flattened')
    assert.deepEqual(mail.attachments.map(a => a.filename), ['note.txt'])
    assert.equal(mail.attachments[0]!.size, 5)

    await rejectsZh(prepareMail({ to: '', text: 'x' }, { account: ACCOUNT, cwd: home }), /没有收件人/)
    await rejectsZh(prepareMail({ to: 'a@example.org', text: '  ' }, { account: ACCOUNT, cwd: home }), /正文是空的/)
    await rejectsZh(prepareMail({ to: 'a@example.org', text: 'x', attachments: ['missing.txt'] }, { account: ACCOUNT, cwd: home }), /找不到附件/)
    const withHtml = await prepareMail({ to: 'a@example.org', html: '<p>only html</p>' }, { account: ACCOUNT, cwd: home })
    assert.equal(withHtml.text, 'only html', 'an HTML-only message still gets a text part')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a draft is saved, edited at its revision, claimed once, and survives a restart', () => {
  const store = MishuStore.open(':memory:')
  const draft = saveDraft(store, ACCOUNT, { to: 'alice@example.org', subject: 'Draft', text: 'one' }, MAIL_NOW, 'd-1')
  assert.equal(draft.revision, 1)
  assert.equal(draft.state, 'draft')

  const edited = editDraft(store, ACCOUNT, 'd-1', 1, { text: 'two' }, MAIL_NOW + 1)
  assert.equal(edited.revision, 2)
  assert.equal(edited.text, 'two')
  throwsZh(() => editDraft(store, ACCOUNT, 'd-1', 1, { text: 'stale' }, MAIL_NOW + 2), /别处改过了/)

  const claimed = claimDraft(store, ACCOUNT, 'd-1', 2, MAIL_NOW + 3)
  assert.equal(claimed.state, 'sending')
  throwsZh(() => claimDraft(store, ACCOUNT, 'd-1', 3, MAIL_NOW + 4), /已经发过了/)
  store.markDraftSent('d-1', MAIL_NOW + 5)
  assert.equal(store.draftById('d-1')!.state, 'sent')
  assert.equal(store.drafts(ACCOUNT.id, 'draft').length, 0)

  assert.deepEqual(draftToCompose(draft), { to: 'alice@example.org', cc: '', bcc: '', subject: 'Draft', text: 'one', html: undefined, attachments: [] })
})

test('the draft box refuses to grow without bound', () => {
  const store = MishuStore.open(':memory:')
  for (let i = 0; i < MAX_DRAFTS; i++) saveDraft(store, ACCOUNT, { to: 'a@example.org', text: `${i}` }, MAIL_NOW, `d-${i}`)
  throwsZh(() => saveDraft(store, ACCOUNT, { to: 'a@example.org', text: 'one more' }, MAIL_NOW), /草稿箱里有 50 封/)
})

test('a listing, a body and a folder list read the way a person would say them', () => {
  const page: MailListPage = { folder: 'INBOX', total: 12, messages: [summary(3, { hasAttachments: true }), summary(2, { seen: true })] }
  const zh = pageText(page, 'zh')
  assert.match(zh, /^INBOX：共 12 封，这里 2 封/)
  assert.match(zh, /uid 3 · 未读\/有附件/)
  assert.match(pageText({ folder: 'INBOX', total: 0, messages: [] }, 'en'), /nothing in this range/)

  const body = bodyText(bodyOf(4, { to: [{ name: '', address: 'me@example.com' }], attachments: [{ index: 0, filename: 'a.pdf', contentType: 'application/pdf', size: 10, contentId: null }] }), 'en')
  assert.match(body, /^Subject: Message 4/)
  assert.match(body, /Attachments: 1\. a\.pdf/)
  assert.match(body, /Body of 4$/)
})

test('a fetcher that only lists unread mail says so instead of pretending', async () => {
  const { runtime } = runtimeWith({ unread: async () => [] })
  await rejectsZh(runtime.mailList(1), /这个版本读不了邮件列表/)
  await rejectsZh(runtime.mailRead(1, 'INBOX', 1), /这个版本读不了邮件正文/)
  await rejectsZh(runtime.mailSearch(1, { query: 'x' }), /这个版本搜不了邮件/)
  await rejectsZh(runtime.mailMark(1, 'INBOX', 1, 'read'), /这个版本改不了邮件状态/)
})

test('every reading operation goes through the account, and a transport error becomes a sentence', async () => {
  const { fetcher, calls } = fakeMailbox()
  const { runtime, secrets } = runtimeWith(fetcher)
  const page = await runtime.mailList(1, { folder: 'Archive', limit: 5, offset: 10, unreadOnly: true })
  assert.equal(page.total, 3)
  assert.equal(calls[0], 'list Archive 5 10 true')
  assert.equal((await runtime.mailRead(1, 'INBOX', 3)).text, 'Body of 3')
  assert.equal((await runtime.mailSearch(1, { query: 'invoice' })).source, 'server')
  assert.equal((await runtime.mailMark(1, 'INBOX', 3, 'move', 'Archive')).newUid, 99)
  assert.equal((await runtime.mailFolders(1)).length, 2)
  await rejectsZh(runtime.mailList(9), /没有这个邮箱/)

  const broken = new Runtime(Config({}), { info() {}, warn() {} }, secrets, {
    unread: async () => [],
    list: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1993') },
  })
  broken.store = runtime.store
  await rejectsZh(broken.mailList(1), /连接 imap\.gmail\.com:993 失败/)
})

test('a summary knows which parts are attachments, and a query looks where it is told', () => {
  const parts = collectParts({
    type: 'multipart/mixed',
    childNodes: [
      { type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }, { type: 'text/html' }] },
      { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' }, size: 10 },
      { type: 'image/png', parameters: { name: 'inline.png' }, id: '<cid1>' },
    ],
  })
  assert.deepEqual(parts.map(p => p.part), ['1.1', '1.2', '2', '3'])
  assert.deepEqual(parts.filter(p => p.isAttachment).map(p => p.filename), ['a.pdf', 'inline.png'])

  const s = summary(1, { subject: 'Invoice for March', from: { name: 'Billing', address: 'bill@example.org' } })
  assert.equal(matchesQuery(s, 'invoice', ['subject']), true)
  assert.equal(matchesQuery(s, 'bill@', ['from']), true)
  assert.equal(matchesQuery(s, 'invoice', ['to']), false)
  assert.equal(matchesQuery(s, 'anything', ['body']), false, 'the body is never in a header')
})

test('the mail tools read, search, move and keep drafts; sending asks first', async () => {
  const { fetcher } = fakeMailbox()
  const { runtime, store, home } = runtimeWith(fetcher)
  try {
    const { registerMailTools } = await import('../src/dsh/mail-tools.ts')
    const registered: Array<{ name: string; execute: (args: unknown) => Promise<{ text: string }> }> = []
    const deps = {
      lang: () => 'zh' as const,
      accounts: () => runtime.accounts(),
      list: (id: number, options: { folder?: string; limit?: number; offset?: number; unreadOnly?: boolean }) => runtime.mailList(id, options),
      read: (id: number, folder: string, uid: number, maxChars?: number) => runtime.mailRead(id, folder, uid, maxChars),
      search: (id: number, options: { query: string; folder?: string; fields?: string[]; limit?: number }) => runtime.mailSearch(id, options as never),
      mark: (id: number, folder: string, uid: number, action: 'read' | 'unread' | 'star' | 'unstar' | 'move' | 'delete' | 'purge', destination?: string) => runtime.mailMark(id, folder, uid, action, destination),
      markMany: (id: number, folder: string, uids: number[], action: 'read' | 'unread' | 'star' | 'unstar' | 'move' | 'delete' | 'purge', destination?: string) => runtime.mailMarkMany(id, folder, uids, action, destination),
      folders: (id: number) => runtime.mailFolders(id),
      createFolder: (id: number, path: string) => runtime.mailCreateFolder(id, path),
      renameFolder: (id: number, from: string, to: string) => runtime.mailRenameFolder(id, from, to),
      deleteFolder: (id: number, path: string) => runtime.mailDeleteFolder(id, path),
      attachment: async () => ({ filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('x') }),
      prepare: (id: number, compose: Parameters<typeof prepareMail>[0]) => runtime.prepareMail(id, compose),
      send: async () => ({ messageId: '<m@x>', accepted: ['a@example.org'], rejected: [], response: 'ok' }),
      drafts: (id: number) => runtime.drafts(id),
      saveDraft: (id: number, input: Parameters<typeof runtime.saveDraft>[1]) => runtime.saveDraft(id, input),
      editDraft: (id: number, draftId: string, revision: number, patch: never) => runtime.editDraft(id, draftId, revision, patch),
      sendDraft: async () => ({ messageId: '<m@x>', accepted: [], rejected: [], response: '' }),
      deleteDraft: (draftId: string) => { runtime.deleteDraft(draftId) },
      scheduleDraft: (id: number, draftId: string, revision: number, sendAt: unknown) => runtime.scheduleDraft(id, draftId, revision, sendAt),
      cancelSchedule: (draftId: string, revision: number) => runtime.cancelSchedule(draftId, revision),
      inboxDir: home,
    }
    await registerMailTools({ register: (def: unknown) => registered.push(def as never) }, deps)
    const tool = (name: string) => registered.find(t => t.name === name)!

    assert.match((await tool('mishu_mail_list').execute({})).text, /INBOX：共 3 封/)
    assert.match((await tool('mishu_mail_read').execute({ uid: 3 })).text, /Body of 3/)
    assert.match((await tool('mishu_mail_search').execute({ query: 'invoice' })).text, /找到 1 封（服务器，看了 3 封）/)
    assert.match((await tool('mishu_mail_mark').execute({ uid: 3, action: 'move', destination: 'Archive' })).text, /新的 uid 是 99/)
    assert.match((await tool('mishu_mail_mark').execute({ uids: [1, 2], action: 'read' })).text, /2 封标为已读/)
    await rejectsZh(tool('mishu_mail_mark').execute({ action: 'read' }), /uid 或 uids/)
    // Deleting for good is the one mark that earns a card; flags and moves do not.
    assert.equal(await mailApproval('mishu_mail_mark', { action: 'delete', uid: 3 }, deps), undefined)
    const purgeCard = await mailApproval('mishu_mail_mark', { action: 'purge', uids: [1, 2], folder: 'Trash' }, deps)
    assert.match(purgeCard!.zh, /彻底删掉/)
    assert.match(purgeCard!.zh, /2 封/)
    assert.match(purgeCard!.zh, /「Trash」/)
    assert.match((await tool('mishu_mail_folders').execute({})).text, /INBOX \[Inbox\] · 12 \(3 未读\)/)

    const saved = await tool('mishu_mail_draft').execute({ action: 'new', to: 'alice@example.org', subject: 'Later', text: 'hi' })
    assert.match(saved.text, /草稿存好了/)
    assert.match((await tool('mishu_mail_draft').execute({ action: 'list' })).text, /Later/)
    assert.equal(store.drafts(1).length, 1)
    const kept = store.drafts(1)[0]!
    assert.match((await tool('mishu_mail_draft').execute({ action: 'show', draft_id: kept.id.slice(0, 8) })).text, /Later/)
    const changed = await tool('mishu_mail_draft').execute({ action: 'update', draft_id: kept.id, revision: kept.revision, subject: 'Later still' })
    assert.match(changed.text, /Later still/)
    await rejectsZh(tool('mishu_mail_draft').execute({ action: 'show', draft_id: 'nope' }), /没有这封草稿/)

    // Scheduling a draft is a send with a delay: same card, plus the time.
    const when = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const live = store.draftById(kept.id)!
    const scheduledCard = await mailApproval('mishu_mail_draft', { action: 'schedule', draft_id: kept.id, send_at: when }, deps)
    assert.match(scheduledCard!.zh, /排进定时/)
    assert.match(scheduledCard!.zh, new RegExp(`定时：${when.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    await rejectsZh(tool('mishu_mail_draft').execute({ action: 'schedule', draft_id: kept.id }), /send_at|要说清什么时候发/)
    const booked = await tool('mishu_mail_draft').execute({ action: 'schedule', draft_id: kept.id, revision: live.revision, send_at: when })
    assert.match(booked.text, /定好了/)
    assert.match(booked.text, /定时: /)
    assert.equal(store.draftById(kept.id)!.state, 'scheduled')
    const cancelled = await tool('mishu_mail_draft').execute({ action: 'cancel', draft_id: kept.id, revision: store.draftById(kept.id)!.revision })
    assert.match(cancelled.text, /定时取消了/)
    assert.equal(store.draftById(kept.id)!.state, 'draft')

    // The card is built from the same preparation the send uses.
    const card = await mailApproval('mishu_mail_send', { to: 'alice@example.org', subject: 'Hi', text: 'Body' }, deps)
    assert.match(card!.zh, /^小秘书要发一封新邮件（从 工作邮箱 <me@example.com>），请核对：\nTo: alice@example\.org/)
    assert.match(card!.en, /^The secretary will send a new message from 工作邮箱/)
    assert.equal(await mailApproval('mishu_mail_list', {}, deps), undefined, 'reading is never gated')
    assert.equal(await mailApproval('mishu_mail_draft', { action: 'list' }, deps), undefined, 'only sending a draft asks')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the API answers for reading, searching, moving, drafts and sending', async () => {
  const { fetcher } = fakeMailbox()
  const { runtime, store, home } = runtimeWith(fetcher)
  try {
    const api = apiHandlers(runtime, () => MAIL_NOW)
    const listed = await api['/mail/list']!({ lang: 'zh', folder: 'INBOX', limit: 2 }) as { page: MailListPage }
    assert.equal(listed.page.messages.length, 3)
    const read = await api['/mail/read']!({ lang: 'zh', uid: 3 }) as { message: MailBody }
    assert.equal(read.message.uid, 3)
    await rejectsZh(api['/mail/read']!({ lang: 'zh', uid: 0 }), /要说清是哪一封/)
    const found = await api['/mail/search']!({ lang: 'zh', query: 'invoice', fields: ['subject'] }) as { found: MailSearchResult }
    assert.equal(found.found.messages.length, 1)
    await rejectsZh(api['/mail/search']!({ lang: 'zh', query: ' ' }), /要搜什么/)
    const moved = await api['/mail/mark']!({ lang: 'zh', uid: 3, action: 'move', destination: 'Archive' }) as { result: { newUid: number } }
    assert.equal(moved.result.newUid, 99)
    await rejectsZh(api['/mail/mark']!({ lang: 'zh', uid: 3, action: 'explode' }), /不认识这个操作/)
    const batch = await api['/mail/mark/many']!({ lang: 'zh', uids: [1, 2], action: 'read' }) as { results: { uid: number }[] }
    assert.deepEqual(batch.results.map(row => row.uid), [1, 2])
    await rejectsZh(api['/mail/mark/many']!({ lang: 'zh', uids: [], action: 'read' }), /要选一封邮件/)
    const folders = await api['/mail/folders']!({ lang: 'zh' }) as { folders: MailFolder[] }
    assert.equal(folders.folders.length, 2)

    const saved = await api['/mail/draft/save']!({ lang: 'zh', to: 'alice@example.org', subject: 'Later', text: 'hi' }) as { draft: { id: string; revision: number } }
    assert.equal(saved.draft.revision, 1)
    const edited = await api['/mail/draft/edit']!({ lang: 'zh', id: saved.draft.id, revision: 1, to: 'alice@example.org', subject: 'Later still', text: 'hi' }) as { draft: { revision: number; subject: string } }
    assert.equal(edited.draft.revision, 2)
    assert.equal(edited.draft.subject, 'Later still')
    await rejectsZh(api['/mail/draft/edit']!({ lang: 'zh', id: saved.draft.id, revision: 1, text: 'stale' }), /别处改过了/)
    const drafts = await api['/mail/draft/list']!({ lang: 'zh' }) as { drafts: unknown[] }
    assert.equal(drafts.drafts.length, 1)
    await api['/mail/draft/delete']!({ lang: 'zh', id: saved.draft.id })
    assert.equal(store.drafts(1).length, 0)

    const view = await api['/settings']!({ lang: 'zh' }) as { view: { presets: Array<{ id: string; smtp: { host: string } }> } }
    assert.equal(view.view.presets.find(p => p.id === 'qq')!.smtp.host, 'smtp.qq.com')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('sending and answering go out with the recipients the original implies', async () => {
  const { fetcher } = fakeMailbox({
    body: bodyOf(7, {
      subject: 'Contract draft',
      from: { name: 'Alice', address: 'alice@example.org' },
      to: [{ name: 'Me', address: 'me@example.com' }],
      cc: [{ name: 'Bob', address: 'bob@example.org' }],
    }),
  })
  // Downloading an attachment is part of the same mailbox, and a reply that
  // carries one must still reach the thread.
  fetcher.attachment = async () => ({ filename: '../passwd', contentType: 'text/plain', content: Buffer.from('secret') })
  const { runtime, home } = runtimeWith(fetcher)
  const sent: PreparedMail[] = []
  // SMTP is the one thing a test cannot fake at the socket, so the send itself
  // is stubbed; everything before it (checking, recipients, threading) is real.
  runtime.sendMail = async (_id, mail) => {
    sent.push(mail)
    return { messageId: '<sent@example.com>', accepted: mail.to, rejected: [], response: '250 ok' }
  }
  try {
    const api = apiHandlers(runtime, () => MAIL_NOW)

    const plain = await api['/mail/send']!({ lang: 'zh', to: 'bob@example.org', subject: 'Hi', text: 'Body' }) as { sent: { messageId: string }; mail: { to: string[] } }
    assert.equal(plain.sent.messageId, '<sent@example.com>')
    assert.deepEqual(plain.mail.to, ['bob@example.org'])
    assert.equal(sent[0]!.inReplyTo, null, 'a new message starts no thread')
    await rejectsZh(api['/mail/send']!({ lang: 'zh', to: '', text: 'Body' }), /没有收件人/)

    const answered = await api['/mail/reply']!({ lang: 'zh', uid: 7, mode: 'reply-all', text: 'Thanks' }) as { mail: { to: string[]; cc: string[]; subject: string } }
    assert.deepEqual(answered.mail.to, ['alice@example.org'])
    assert.deepEqual(answered.mail.cc, ['bob@example.org'], 'reply-all keeps the others on Cc')
    assert.equal(answered.mail.subject, 'Re: Contract draft')
    assert.equal(sent[1]!.inReplyTo, '<m7@mail.example>', 'the reply joins the thread')
    assert.deepEqual(sent[1]!.references, ['<m7@mail.example>'])

    // A typed address wins, so a reply can be redirected before it leaves.
    const redirected = await api['/mail/reply']!({ lang: 'zh', uid: 7, mode: 'reply', text: 'x', to: 'carol@example.net' }) as { mail: { to: string[] } }
    assert.deepEqual(redirected.mail.to, ['carol@example.net'])
    assert.equal(sent[2]!.inReplyTo, '<m7@mail.example>')

    // A blind copy is never derived from the original, so what you typed is
    // the only source — losing it would reach fewer people than you named.
    const blind = await api['/mail/reply']!({ lang: 'zh', uid: 7, mode: 'reply', text: 'x', bcc: 'audit@example.org' }) as { mail: { bcc: string[] } }
    assert.deepEqual(blind.mail.bcc, ['audit@example.org'])

    await rejectsZh(api['/mail/reply']!({ lang: 'zh', uid: 7, mode: 'forward', text: 'x' }), /没有可回复的地址/)

    const file = await api['/mail/attachment']!({ lang: 'zh', uid: 7, index: 0 }) as { file: { filename: string; size: number; path: string } }
    assert.equal(file.file.filename, '../passwd')
    assert.equal(file.file.path, join(home, 'attachments', 'passwd'), 'the path is flattened, never escaped')
    assert.equal(readFileSync(file.file.path, 'utf8'), 'secret')
    await rejectsZh(api['/mail/attachment']!({ lang: 'zh', uid: 0, index: 0 }), /要说清是哪一封/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a draft saved from a reply still joins the thread when it is sent later', async () => {
  const { fetcher } = fakeMailbox({
    body: bodyOf(9, {
      subject: 'Quarterly plan',
      from: { name: 'Alice', address: 'alice@example.org' },
      to: [{ name: 'Me', address: 'me@example.com' }],
      cc: [],
    }),
  })
  const { runtime, store, home } = runtimeWith(fetcher)
  const sent: PreparedMail[] = []
  runtime.sendMail = async (_id, mail) => {
    sent.push(mail)
    return { messageId: '<later@example.com>', accepted: mail.to, rejected: [], response: '250 ok' }
  }
  try {
    // The editor keeps the reply as a draft; the original is only read again
    // when the draft actually goes out.
    const draft = runtime.saveDraft(1, {
      to: 'alice@example.org',
      subject: 'Re: Quarterly plan',
      text: 'Sounds good',
      reply: { folder: 'INBOX', uid: 9, mode: 'reply' },
    })
    assert.equal(draft.reply?.uid, 9)
    const result = await runtime.sendDraft(1, draft.id, draft.revision)
    assert.equal(result.messageId, '<later@example.com>')
    assert.equal(sent[0]!.inReplyTo, '<m9@mail.example>', 'the draft answers the message it was written for')
    assert.deepEqual(sent[0]!.references, ['<m9@mail.example>'])
    assert.equal(store.draftById(draft.id)!.state, 'sent')

    // A draft whose original has gone still sends; it just starts a new thread.
    const orphan = runtime.saveDraft(1, { to: 'alice@example.org', subject: 'Re: gone', text: 'hi', reply: { folder: 'INBOX', uid: 404, mode: 'reply' } })
    const broken = fakeMailbox()
    broken.fetcher.read = async () => { throw new MishuError({ zh: '没这封', en: 'no such message' }) }
    runtime.fetcher.read = broken.fetcher.read
    await runtime.sendDraft(1, orphan.id, orphan.revision)
    assert.equal(sent[1]!.inReplyTo, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the mailbox\'s own folders are not ours to rename or delete', async () => {
  const { fetcher } = fakeMailbox()
  const made: string[] = []
  fetcher.createFolder = async (_a, _p, path) => { made.push(`create ${path}`) }
  fetcher.renameFolder = async (_a, _p, from, to) => { made.push(`rename ${from} -> ${to}`) }
  fetcher.deleteFolder = async (_a, _p, path) => { made.push(`delete ${path}`) }
  fetcher.folders = async (): Promise<MailFolder[]> => [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: [], messages: 12, unread: 3 },
    { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive', flags: [], messages: 4 },
    { path: 'Receipts', name: 'Receipts', delimiter: '/', specialUse: null, flags: [], messages: 0 },
    { path: 'Tax', name: 'Tax', delimiter: '/', specialUse: null, flags: [], messages: 2 },
  ]
  const { runtime, home } = runtimeWith(fetcher)
  try {
    // Refused by what the server says a folder is, not just by its name.
    await rejectsZh(runtime.mailCreateFolder(1, 'INBOX'), /邮箱自己的文件夹/)
    await rejectsZh(runtime.mailRenameFolder(1, 'Archive', 'Old mail'), /邮箱自己的文件夹/)
    await rejectsZh(runtime.mailDeleteFolder(1, 'INBOX'), /邮箱自己的文件夹/)
    // Even a label the person made, if the server marks it special, stays out of reach.
    await rejectsZh(runtime.mailDeleteFolder(1, 'Archive'), /邮箱自己的文件夹/)
    // A folder with mail in it is not silently destroyed.
    await rejectsZh(runtime.mailDeleteFolder(1, 'Tax'), /还有 2 封信/)
    await rejectsZh(runtime.mailCreateFolder(1, 'Receipts'), /已经有/)
    await rejectsZh(runtime.mailCreateFolder(1, '  '), /要填文件夹名/)
    await rejectsZh(runtime.mailCreateFolder(1, 'a//b'), /空的/)
    assert.deepEqual(made, [], 'nothing reached the server')

    const rows = await runtime.mailCreateFolder(1, 'Receipts/2026')
    assert.equal(rows.length, 4, 'the answer is the folder list after the change')
    assert.deepEqual(made, ['create Receipts/2026'])
    await runtime.mailRenameFolder(1, 'Receipts', 'Bills')
    await runtime.mailDeleteFolder(1, 'Receipts')
    assert.deepEqual(made, ['create Receipts/2026', 'rename Receipts -> Bills', 'delete Receipts'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a scheduled send needs a time with a zone, and the clock only sends what is due', async () => {
  const store = MishuStore.open(':memory:')
  const hour = 60 * 60 * 1000
  // A time without a zone is refused rather than guessed: "09:00" is nine
  // o'clock somewhere, and a message that goes an hour early is worse than one
  // that never went.
  throwsZh(() => scheduledTime('2026-11-20T09:00:00', MAIL_NOW), /要带时区/)
  throwsZh(() => scheduledTime('tomorrow', MAIL_NOW), /要带时区/)
  // Matches the shape but is not a date; a rollover like Feb 30 is left to the
  // calendar, since refusing it here would only guess at what was meant.
  throwsZh(() => scheduledTime('2026-13-45T09:00:00Z', MAIL_NOW), /不是一个时间/)
  assert.equal(scheduledTime(new Date(MAIL_NOW + hour).toISOString(), MAIL_NOW), MAIL_NOW + hour)
  throwsZh(() => scheduledTime(new Date(MAIL_NOW + 1000).toISOString(), MAIL_NOW), /30 秒以后/)
  throwsZh(() => scheduledTime(new Date(MAIL_NOW + 400 * 24 * hour).toISOString(), MAIL_NOW), /一年以内/)

  const draft = saveDraft(store, ACCOUNT, { to: 'alice@example.org', subject: 'Later', text: 'later' }, MAIL_NOW, 's-1')
  // Something with no recipients can be timed, but it would fail on the hour.
  const empty = saveDraft(store, ACCOUNT, { subject: 'Nobody', text: 'x' }, MAIL_NOW, 's-empty')
  throwsZh(() => scheduleDraft(store, ACCOUNT, 's-empty', empty.revision, MAIL_NOW + hour, MAIL_NOW), /还没有收件人/)
  throwsZh(() => scheduleDraft(store, ACCOUNT, 's-1', 99, MAIL_NOW + hour, MAIL_NOW), /别处改过了/)

  const scheduled = scheduleDraft(store, ACCOUNT, 's-1', draft.revision, MAIL_NOW + hour, MAIL_NOW)
  assert.equal(scheduled.state, 'scheduled')
  assert.equal(scheduled.sendAt, MAIL_NOW + hour)
  assert.equal(isScheduled(scheduled), true)
  assert.equal(store.dueDrafts(MAIL_NOW + hour / 2).length, 0, 'not yet')
  assert.deepEqual(store.dueDrafts(MAIL_NOW + hour).map(d => d.id), ['s-1'], 'due at its minute')

  // Cancelling puts it back, so the ordinary send works again.
  throwsZh(() => cancelSchedule(store, 's-empty', empty.revision, MAIL_NOW), /没有定时/)
  const back = cancelSchedule(store, 's-1', scheduled.revision, MAIL_NOW + 1)
  assert.equal(back.state, 'draft')
  assert.equal(back.sendAt, null)
  assert.equal(store.dueDrafts(MAIL_NOW + hour).length, 0)
})

test('the secretary sends what is due, and a failure comes back as a draft with the reason', async () => {
  const { fetcher } = fakeMailbox()
  const { runtime, home } = runtimeWith(fetcher)
  const sent: PreparedMail[] = []
  runtime.sendMail = async (_id, mail) => {
    if (mail.to.includes('broken@example.org')) throw new MishuError(bi('收件人地址不存在', 'no such recipient'))
    sent.push(mail)
    return { messageId: '<due@example.com>', accepted: mail.to, rejected: [], response: '250 ok' }
  }
  try {
    const api = apiHandlers(runtime, () => MAIL_NOW)
    const store = runtime.store!

    const ok = await api['/mail/draft/save']!({ lang: 'zh', to: 'alice@example.org', subject: 'Due', text: 'now' }) as { draft: DraftView }
    const bad = await api['/mail/draft/save']!({ lang: 'zh', to: 'broken@example.org', subject: 'Broken', text: 'now' }) as { draft: DraftView }
    const later = await api['/mail/draft/save']!({ lang: 'zh', to: 'carol@example.org', subject: 'Later', text: 'later' }) as { draft: DraftView }

    // Nothing is due before its time, even when the tick runs.
    const early = await api['/mail/due']!({ lang: 'zh' }) as { result: { sent: number; failed: number } }
    assert.deepEqual({ sent: early.result.sent, failed: early.result.failed }, { sent: 0, failed: 0 })

    const at = new Date(Date.now() + 60_000).toISOString()
    await api['/mail/draft/schedule']!({ lang: 'zh', id: ok.draft.id, revision: ok.draft.revision, sendAt: at })
    await api['/mail/draft/schedule']!({ lang: 'zh', id: bad.draft.id, revision: bad.draft.revision, sendAt: at })
    const far = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    await api['/mail/draft/schedule']!({ lang: 'zh', id: later.draft.id, revision: later.draft.revision, sendAt: far })
    // A scheduled draft is not an ordinary draft: the plain send refuses it.
    await rejectsZh(api['/mail/draft/send']!({ lang: 'zh', id: ok.draft.id, revision: (store.draftById(ok.draft.id)!).revision }), /定过时/)

    // Move the two near ones into the past so the tick sees them; the third stays out.
    const live = store.draftById(ok.draft.id)!
    store.updateDraft(ok.draft.id, live.revision, { sendAt: Date.now() - 1000 }, Date.now())
    const liveBad = store.draftById(bad.draft.id)!
    store.updateDraft(bad.draft.id, liveBad.revision, { sendAt: Date.now() - 1000 }, Date.now())

    const result = await runtime.sendDueMail()
    assert.equal(result.sent, 1)
    assert.equal(result.failed, 1)
    assert.deepEqual(sent.map(mail => mail.to), [['alice@example.org']])

    const sentRow = store.draftById(ok.draft.id)!
    assert.equal(sentRow.state, 'sent')
    const failedRow = store.draftById(bad.draft.id)!
    assert.equal(failedRow.state, 'draft', 'a failed one comes back, not stuck in sending')
    assert.equal(failedRow.sendAt, null, 'and it is off the clock, so it does not retry forever')
    // Stored in whichever language the secretary speaks, so the panel and the
    // person read the same sentence they would have got from a manual send.
    assert.match(failedRow.error ?? '', /收件人地址不存在|no such recipient/)
    assert.equal(store.draftById(later.draft.id)!.state, 'scheduled', 'the far one is untouched')

    // The reason is visible in the draft list, so the person can fix it.
    const listed = await api['/mail/draft/list']!({ lang: 'zh' }) as { drafts: DraftView[] }
    assert.match(listed.drafts.find(d => d.id === bad.draft.id)!.error ?? '', /收件人地址不存在|no such recipient/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('deleting means the Trash folder, and only Trash loses mail for good', async () => {
  const { fetcher, calls } = fakeMailbox()
  const { runtime, home } = runtimeWith(fetcher)
  try {
    // The action reaches the fetcher untouched: delete and purge are ordinary
    // marks as far as the runtime is concerned, and the folder logic that picks
    // Trash lives in the IMAP layer where a real server can answer for it.
    const deleted = await runtime.mailMark(1, 'INBOX', 3, 'delete')
    assert.equal(deleted.uid, 3)
    assert.equal(calls.at(-1), 'mark delete 3 ')

    const trashed: MailFetcher & { folders: NonNullable<MailFetcher['folders']> } = {
      ...fetcher,
      folders: async (): Promise<MailFolder[]> => [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: [], messages: 3, unread: 1 },
        { path: 'Trash', name: 'Trash', delimiter: '/', specialUse: '\\Trash', flags: [], messages: 0 },
      ],
      mark: async (_a, _p, folder, uid, action, destination): Promise<{ uid: number; newUid: number | null; folder: string }> => {
        calls.push(`mark ${action} ${folder} ${uid} ${destination ?? ''}`)
        return { uid, newUid: action === 'delete' ? 77 : null, folder: action === 'delete' ? 'Trash' : folder }
      },
      markMany: async (_a, _p, folder, uids, action, destination): Promise<{ uid: number; newUid: number | null; folder: string }[]> =>
        uids.map(uid => {
          calls.push(`many ${action} ${folder} ${uid} ${destination ?? ''}`)
          return { uid, newUid: null, folder }
        }),
    }
    const second = runtimeWith(trashed)
    try {
      const gone = await second.runtime.mailMark(1, 'INBOX', 3, 'delete')
      assert.equal(gone.folder, 'Trash', 'a delete lands in the mailbox\'s own Trash')
      assert.equal(gone.newUid, 77)

      // Inside Trash the same button has to mean "for good", or it would be a no-op.
      const purged = await second.runtime.mailMark(1, 'Trash', 3, 'purge')
      assert.equal(purged.uid, 3)
      assert.equal(calls.at(-1), 'mark purge Trash 3 ')

      // Batches: one call per uid, and the fetcher's own batch is preferred.
      const results = await second.runtime.mailMarkMany(1, 'Trash', [4, 5], 'purge')
      assert.deepEqual(results.map(row => row.uid), [4, 5])
      assert.equal(calls.filter(call => call.startsWith('many purge')).length, 2)

      // The fallback is the same work one uid at a time.
      const { markMany: _drop, ...oneByOne } = trashed
      const third = runtimeWith(oneByOne as MailFetcher)
      try {
        const rows = await third.runtime.mailMarkMany(1, 'INBOX', [1, 2, 3], 'read')
        assert.deepEqual(rows.map(row => row.uid), [1, 2, 3])
      } finally {
        rmSync(third.home, { recursive: true, force: true })
      }

      await rejectsZh(second.runtime.mailMarkMany(1, 'INBOX', [], 'read'), /要选一封邮件|pick at least one/)
      await rejectsZh(second.runtime.mailMarkMany(1, 'INBOX', Array.from({ length: 21 }, (_, i) => i + 1), 'read'), /一次最多 20 封|at most 20/)
    } finally {
      rmSync(second.home, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
