/**
 * One mail sync for one account: list unread mail (read-only), judge each
 * message, fold a thread's messages into one matter.
 *
 * The mailbox is never changed. Mail that is no longer unread was read in
 * your mail client, so its matter closes; mail that only fell out of the
 * time window is left alone.
 */

import { applyVerdict, closeReadElsewhere } from '../fold.ts'
import { bi, type Bi } from '../i18n.ts'
import type { MishuStore } from '../store.ts'
import type { Verdict } from '../github/rules.ts'
import { presetById, type MailAccount, type MailFetcher, type MailMessage } from './account.ts'
import { judgeMail } from './rules.ts'

export const MAIL_SOURCE = 'mail'

export interface MailSyncReport {
  at: number
  account: number
  messages: number
  opened: number
  closed: number
  error?: Bi
}

/** What some providers' refusals mean, in words you can act on. */
const KNOWN_REFUSALS: Array<{ presets: string[]; match: RegExp; text: Bi }> = [
  {
    presets: ['gmail'], match: /application-specific password required/i,
    text: bi('Google 不接受账号的登录密码：这里要填「应用专用密码」（16 位）。按步骤第 1、2 步生成一个，大约一分钟。', 'Google does not take your account password here: it needs an app password (16 characters). Steps 1 and 2 make one in about a minute.'),
  },
  {
    presets: ['gmail'], match: /invalid credentials/i,
    text: bi('Google 不认这个应用专用密码：可能抄错了，或者已经在 Google 账号里删掉了。按步骤第 2 步重新生成一个再试。', 'Google does not accept this app password: it may be mistyped or deleted from your Google account. Make a new one with step 2 and try again.'),
  },
  {
    presets: ['gmail'], match: /web login required|log in via your web browser/i,
    text: bi('Google 拦下了这次登录：先在浏览器里登录一次 Gmail，再回来试。', 'Google blocked this sign-in: sign in to Gmail in a browser once, then try again.'),
  },
  {
    presets: ['qq'], match: /login fail/i,
    text: bi('QQ 邮箱不让登录：最常见是还没开启 IMAP 服务，或者填的是 QQ 密码而不是授权码；改过 QQ 密码后，旧授权码也会失效。', 'QQ Mail refused the sign-in: usually IMAP is not turned on, or this is your QQ password instead of the authorization code; changing your QQ password also expires old codes.'),
  },
  {
    presets: ['163', '126'], match: /unsafe login/i,
    text: bi('网易邮箱拦下了这次登录：确认设置里已开启 IMAP 服务，并且填的是客户端授权码。', 'NetEase Mail blocked this sign-in: check that IMAP is turned on in its settings and that this is the client authorization code.'),
  },
]

/**
 * A connection or login failure, said so a person knows what to fix. With
 * `steps` (the default) a login failure also repeats where the provider's
 * app password comes from; the add-account dialog shows those steps already.
 */
export function describeMailError(error: unknown, account: Pick<MailAccount, 'host' | 'port' | 'preset'>, options: { steps?: boolean } = {}): Bi {
  const raw = (error as { responseText?: string; message?: string }).responseText ?? (error as Error).message ?? String(error)
  const known = KNOWN_REFUSALS.find(k => k.presets.includes(account.preset) && k.match.test(raw))
  const auth = known !== undefined || /auth|login|password|credential|AUTHENTICATIONFAILED|LOGIN failed/i.test(raw)
  if (!auth) return bi(`连接 ${account.host}:${account.port} 失败：${raw}`, `Could not reach ${account.host}:${account.port}: ${raw}`)
  const preset = presetById(account.preset)
  const steps = options.steps !== false && preset.id !== 'custom' ? preset.howTo : undefined
  const what = known?.text ?? bi(
    '登录失败：服务器不接受这个用户名或密码。多数邮箱要先开启 IMAP，再填客户端授权码或应用专用密码，不是网页登录密码。',
    'Login failed: the server rejected the user name or password. Most providers need IMAP turned on and an app password, not your web password.',
  )
  return bi(
    `${what.zh}（服务器原话：${raw}）${steps === undefined ? '' : `\n${preset.label.zh}：${steps.zh}`}`,
    `${what.en} (The server said: ${raw})${steps === undefined ? '' : `\n${preset.label.en}: ${steps.en}`}`,
  )
}

export function mailReportKey(accountId: number): string {
  return `mail.lastSync.${accountId}`
}

export async function syncMail(options: {
  store: MishuStore
  account: MailAccount
  fetcher: MailFetcher
  password: string
  now: number
}): Promise<MailSyncReport> {
  const { store, account, fetcher, password, now } = options
  const report: MailSyncReport = { at: now, account: account.id, messages: 0, opened: 0, closed: 0 }
  let messages: MailMessage[]
  try {
    messages = await fetcher.unread(account, password, account.sinceDays, now)
  } catch (error) {
    report.error = describeMailError(error, account)
    store.set(mailReportKey(account.id), report)
    return report
  }
  report.messages = messages.length

  const byMatter = new Map<string, Array<{ m: MailMessage; v: Verdict }>>()
  for (const m of messages) {
    const v = judgeMail(m, account)
    const list = byMatter.get(v.matterKey) ?? []
    list.push({ m, v })
    byMatter.set(v.matterKey, list)
  }

  store.transaction(() => {
    const counts = { opened: 0, closed: 0 }
    const seen = new Set<string>()
    for (const [key, items] of byMatter) {
      const sorted = [...items].sort((a, b) => b.m.date - a.m.date)
      const pick = sorted.find(x => x.v.status === 'open') ?? sorted[0]!
      applyVerdict(store, MAIL_SOURCE, { ...pick.v, activityAt: sorted[0]!.m.date }, now, counts)
      for (const { m, v } of items) {
        seen.add(m.id)
        store.upsertMessage({
          id: m.id, source: MAIL_SOURCE, matterKey: key, subjectType: 'mail', why: v.reason, repo: account.address,
          title: `${m.from?.address ?? '?'} · ${m.subject}`, updatedAt: m.date, unread: true,
          verdictStatus: v.status, verdictReason: v.reason, seenAt: now,
        })
      }
    }
    // Read in your mail client → closed. Older than the window → left as it was.
    const windowStart = now - account.sinceDays * 86_400_000
    const mine = (id: string) => id.startsWith(`mail:${account.id}:`)
    counts.closed += closeReadElsewhere(store, MAIL_SOURCE, seen, new Set(byMatter.keys()), now, 'read-in-mail',
      message => !mine(message.id) || message.updatedAt < windowStart)
    report.opened = counts.opened
    report.closed = counts.closed
  })
  store.set(mailReportKey(account.id), report)
  return report
}
