import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBoard } from '../src/core/board.ts'
import { decode } from '../src/core/i18n.ts'
import type { MailAccount, MailFetcher, MailMessage } from '../src/core/mail/account.ts'
import { parseHeaders, toMailMessage } from '../src/core/mail/imap.ts'
import { judgeMail } from '../src/core/mail/rules.ts'
import { syncMail } from '../src/core/mail/sync.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { deleteMailAccount, effectiveSettings, mailAccounts, saveMailAccount, saveSettings } from '../src/core/settings.ts'
import { MishuStore } from '../src/core/store.ts'
import { DEFAULT_LEAD_DAYS } from '../src/core/recur.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'
import {
  ACCOUNT, BILL, BILL_ZH, CC_ONLY, CODE, CONTRACT, CONTRACT_REPLY, GITHUB, INBOX, INVITE, MAIL_NOW, NEWSLETTER, SHIPPED,
} from './fixtures/synthetic-mail.ts'

const fetcherOf = (messages: MailMessage[]): MailFetcher & { calls: Array<{ password: string; sinceDays: number }> } => {
  const calls: Array<{ password: string; sinceDays: number }> = []
  return { calls, unread: async (_a, password, sinceDays) => { calls.push({ password, sinceDays }); return messages } }
}

test('each mail rule, judged from headers only', () => {
  const reason = (m: MailMessage) => judgeMail(m, ACCOUNT).reason
  assert.equal(reason(CONTRACT), 'mail-to-you')
  assert.equal(reason(NEWSLETTER), 'mail-newsletter')
  assert.equal(reason(SHIPPED), 'mail-automated')
  assert.equal(reason(CODE), 'mail-code')
  assert.equal(reason(GITHUB), 'mail-github')
  assert.equal(reason(INVITE), 'mail-invite')
  assert.equal(reason(BILL), 'mail-bill', 'a bill stays even when it is bulk mail')
  assert.equal(reason(BILL_ZH), 'mail-bill', 'a bill stays even when it is automated')
  assert.equal(reason(CC_ONLY), 'mail-cc')

  const v = judgeMail(CONTRACT, ACCOUNT)
  assert.equal(v.explain.what.zh, '工作邮箱 收到 Alice Example <alice@example.org> 在 10-20 发来的邮件：「Contract draft」')
  assert.match(v.explain.why.zh, /直接写给你的邮件，没有群发或自动发送的标记，可能在等你回复/)
  assert.equal(v.explain.link!.label.zh, '打开邮件')
  assert.match(v.explain.link!.url, /^https:\/\/mail\.google\.com\/mail\/u\/0\/#search\/rfc822msgid:/)
  assert.match(judgeMail(BILL_ZH, ACCOUNT).explain.why.zh, /标题里有「账单」/)
  assert.equal(judgeMail(CONTRACT_REPLY, ACCOUNT).title, 'Contract draft', 'Re: is dropped from the title')
})

test('a sync folds a thread into one item, keeps what needs you and closes the rest', async () => {
  const store = MishuStore.open(':memory:')
  const fetcher = fetcherOf(INBOX)
  const report = await syncMail({ store, account: ACCOUNT, fetcher, password: 'app-password', now: MAIL_NOW })
  assert.deepEqual(fetcher.calls, [{ password: 'app-password', sinceDays: 14 }])
  assert.equal(report.error, undefined)
  assert.equal(report.messages, 10)
  assert.equal(report.opened, 4)
  assert.equal(report.closed, 5)

  const open = store.openMatters()
  assert.deepEqual(open.map(m => m.reason).sort(), ['mail-bill', 'mail-bill', 'mail-invite', 'mail-to-you'])
  const contract = open.find(m => m.reason === 'mail-to-you')!
  assert.equal(store.messagesOfMatter(contract.key).length, 2, 'the reply joined its thread')
  assert.equal(decode(contract.title, 'zh'), 'Contract draft')

  const board = buildBoard(store, { now: MAIL_NOW, lang: 'zh', github: { enabled: false, markRead: 'shadow' }, mailAccounts: [ACCOUNT] })
  assert.ok(board.columns.handle.every(c => c.source === 'mail'))
  assert.match(board.columns.handle.find(c => c.title === 'Contract draft')!.meta, /^邮件 · 写给你的邮件$/)
  assert.equal(board.sources.mail[0]!.state, 'ok')
})

test('mail read in your mail client closes; mail that only aged out of the window does not', async () => {
  const store = MishuStore.open(':memory:')
  await syncMail({ store, account: ACCOUNT, fetcher: fetcherOf(INBOX), password: 'p', now: MAIL_NOW })
  const later = MAIL_NOW + 3_600_000
  const second = await syncMail({ store, account: ACCOUNT, fetcher: fetcherOf([INVITE]), password: 'p', now: later })
  assert.equal(second.closed, 3, 'the contract thread and both bills were read')
  const contract = store.mattersOfSource('mail').find(m => m.reason === 'read-in-mail' && decode(m.title, 'en') === 'Contract draft')
  assert.ok(contract !== undefined)
  assert.deepEqual(store.openMatters().map(m => m.reason), ['mail-invite'])

  // A month later the invitation is outside the 14-day window: not seen, but not "read" either.
  const aged = await syncMail({ store, account: ACCOUNT, fetcher: fetcherOf([]), password: 'p', now: MAIL_NOW + 30 * 86_400_000 })
  assert.equal(aged.closed, 0)
  assert.deepEqual(store.openMatters().map(m => m.reason), ['mail-invite'])
})

test('a rejected login explains app passwords; nothing is half-written', async () => {
  const store = MishuStore.open(':memory:')
  const failing: MailFetcher = { unread: async () => { throw Object.assign(new Error('Command failed'), { responseText: 'Invalid credentials (Failure)' }) } }
  const report = await syncMail({ store, account: ACCOUNT, fetcher: failing, password: 'wrong', now: MAIL_NOW })
  assert.match(report.error!.zh, /^登录失败：服务器不接受这个用户名或密码（Invalid credentials \(Failure\)）。多数邮箱要先开启 IMAP，再填客户端授权码或应用专用密码/)
  assert.match(report.error!.zh, /\nGmail：Google 账号先开启两步验证/, 'says where this provider\'s app password comes from')
  assert.equal(store.openMatters().length, 0)
  const unreachable: MailFetcher = { unread: async () => { throw new Error('getaddrinfo ENOTFOUND imap.gmail.com') } }
  assert.match((await syncMail({ store, account: ACCOUNT, fetcher: unreachable, password: 'p', now: MAIL_NOW })).error!.en, /^Could not reach imap\.gmail\.com:993/)
})

test('headers are unfolded and threads, calendars and lists are recognised', () => {
  const headers = parseHeaders('List-Unsubscribe: <https://x.example/u>,\r\n <mailto:u@x.example>\r\nReferences: <root@x.example>\r\n\t<mid@x.example>\r\nAuto-Submitted: auto-generated\r\n')
  assert.equal(headers.get('list-unsubscribe'), '<https://x.example/u>, <mailto:u@x.example>')
  const m = toMailMessage({
    uid: 7,
    envelope: { subject: 'Re: plan', messageId: '<new@x.example>', date: new Date(MAIL_NOW), from: [{ name: 'X', address: 'X@Example.org' }], to: [{ address: 'me@example.com' }] },
    headers: Buffer.from('References: <root@x.example> <mid@x.example>\r\nList-Id: <team.x.example>\r\n'),
    bodyStructure: { type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }, { type: 'text/calendar' }] },
  }, 1)
  assert.equal(m.threadRoot, '<root@x.example>')
  assert.equal(m.from!.address, 'x@example.org', 'addresses are compared lower-case')
  assert.equal(m.listId, '<team.x.example>')
  assert.equal(m.hasCalendar, true)
  assert.match(m.id, /^mail:1:[0-9a-f]{16}$/)
})

test('accounts keep their password in the keychain only; removing one closes its open items', async () => {
  const store = MishuStore.open(':memory:')
  const secrets = new MemorySecrets()
  await assert.rejects(saveMailAccount(store, secrets, { preset: 'qq', address: 'me@example.com' }, undefined, MAIL_NOW), /a new account needs its password/)
  await assert.rejects(saveMailAccount(store, secrets, { preset: 'outlook', address: 'me@example.com' }, 'p', MAIL_NOW), /not supported yet/)
  await assert.rejects(saveMailAccount(store, secrets, { preset: 'custom', address: 'me@example.com', host: '1993' }, 'p', MAIL_NOW), /invalid IMAP server: 1993/)
  await assert.rejects(saveMailAccount(store, secrets, { preset: 'custom', address: 'me@example.com', host: '' }, 'p', MAIL_NOW), /invalid IMAP server: \(empty\)/)
  const account = await saveMailAccount(store, secrets, { preset: 'qq', address: 'Me@Example.com', label: '私人' }, 'qq-auth-code', MAIL_NOW)
  assert.deepEqual(account, { id: 1, label: '私人', address: 'me@example.com', preset: 'qq', host: 'imap.qq.com', port: 993, secure: true, user: 'me@example.com', enabled: true, sinceDays: 14 })
  assert.equal(await secrets.get('mail:1'), 'qq-auth-code')
  assert.ok(!JSON.stringify(mailAccounts(store)).includes('qq-auth-code'), 'the notebook never holds the password')

  await saveMailAccount(store, secrets, { id: 1, sinceDays: 30 }, undefined, MAIL_NOW)
  assert.equal(mailAccounts(store)[0]!.sinceDays, 30)
  assert.equal(await secrets.get('mail:1'), 'qq-auth-code', 'editing without a password keeps the old one')

  await syncMail({ store, account: { ...ACCOUNT, id: 1 }, fetcher: fetcherOf(INBOX), password: 'p', now: MAIL_NOW })
  assert.equal(store.openMatters().length, 4)
  assert.equal(await deleteMailAccount(store, secrets, 1, MAIL_NOW), true)
  assert.equal(await secrets.get('mail:1'), undefined)
  assert.equal(store.openMatters().length, 0)
  assert.ok(store.mattersOfSource('mail').some(m => m.reason === 'account-removed'))
})

test('settings from the page override the config; bad values are refused', () => {
  const store = MishuStore.open(':memory:')
  const defaults = { language: 'auto' as const, githubEnabled: true, markRead: 'shadow' as const, leadDays: DEFAULT_LEAD_DAYS }
  saveSettings(store, { language: 'en', markRead: 'off', leadDays: { bill: 5 } }, MAIL_NOW)
  assert.deepEqual(effectiveSettings(store, defaults), { language: 'en', githubEnabled: true, markRead: 'off', leadDays: { ...DEFAULT_LEAD_DAYS, bill: 5 } })
  assert.throws(() => saveSettings(store, { markRead: 'always' as never }, MAIL_NOW), /mark read must be off, shadow or on/)
  assert.throws(() => saveSettings(store, { leadDays: { bill: -1 } }, MAIL_NOW), /lead days/)
})

test('the settings API takes a password in and never gives it back', async () => {
  const store = MishuStore.open(':memory:')
  const secrets = new MemorySecrets()
  const fetcher = fetcherOf([CONTRACT])
  const runtime = new Runtime(Config({ github: { enabled: false, useGhCli: false, tokenEnv: 'DSH_MISHU_TEST_NO_TOKEN' } }), { info() {}, warn() {} }, secrets, fetcher)
  runtime.store = store
  const api = apiHandlers(runtime, () => MAIL_NOW)
  const secret = 'S3cret-app-password'

  const tested = await api['/mail/test']!({ lang: 'en', account: { preset: 'gmail', address: 'me@example.com' }, password: secret }) as { unread: number }
  assert.equal(tested.unread, 1)
  assert.equal(fetcher.calls.at(-1)!.password, secret)
  assert.equal(store.get('mail.accounts'), undefined, 'testing saves nothing')

  const saved = await api['/mail/save']!({ lang: 'zh', account: { preset: 'gmail', address: 'me@example.com' }, password: secret })
  assert.ok(!JSON.stringify(saved).includes(secret))
  const view = await api['/settings']!({ lang: 'zh' }) as { view: { accounts: Array<{ hasPassword: boolean; envName: string }>; secrets: { kind: string; available: boolean }; github: { token: { found: boolean } } } }
  assert.ok(!JSON.stringify(view).includes(secret))
  assert.equal(view.view.accounts[0]!.hasPassword, true)
  assert.equal(view.view.accounts[0]!.envName, 'DSH_MISHU_SECRET_MAIL_1')
  assert.deepEqual(view.view.secrets, { kind: 'memory', available: true })
  assert.equal(view.view.github.token.found, false)

  const synced = await api['/mail/sync']!({ lang: 'zh', id: 1 }) as { report: { messages: number } }
  assert.equal(synced.report.messages, 1)
  assert.equal(fetcher.calls.at(-1)!.password, secret, 'the sync read the password from the keychain')
  await assert.rejects(api['/mail/test']!({ lang: 'zh', account: { preset: 'gmail', address: 'me@example.com' } }), /先填密码/)
  const after = await api['/mail/delete']!({ lang: 'zh', id: 1 }) as { view: { accounts: unknown[] } }
  assert.equal(after.view.accounts.length, 0)
})

test('a missing password is reported on the account, in both languages', async () => {
  const store = MishuStore.open(':memory:')
  const runtime = new Runtime(Config({}), { info() {}, warn() {} }, new MemorySecrets(), fetcherOf([]))
  runtime.store = store
  store.set('mail.accounts', [ACCOUNT satisfies MailAccount])
  const report = await runtime.syncMailAccount(ACCOUNT)
  assert.match(report!.error!.zh, /没有找到这个邮箱的密码/)
  assert.match(report!.error!.en, /No password/)
})

test('the connection test explains failures the same way a sync does', async () => {
  const store = MishuStore.open(':memory:')
  const refused: MailFetcher = { unread: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1993') } }
  const runtime = new Runtime(Config({}), { info() {}, warn() {} }, new MemorySecrets(), refused)
  runtime.store = store
  const api = apiHandlers(runtime, () => MAIL_NOW)
  const account = { preset: 'custom', host: '127.0.0.1', port: 1993, address: 'tester@example.com' }
  await assert.rejects(api['/mail/test']!({ lang: 'zh', account, password: 'x' }), /^Error: Could not reach 127\.0\.0\.1:1993: connect ECONNREFUSED/)
  await assert.rejects(api['/mail/test']!({ lang: 'zh', account, password: 'x' }), (e: { text?: { zh: string } }) => e.text?.zh === '连接 127.0.0.1:1993 失败：connect ECONNREFUSED 127.0.0.1:1993')
})
