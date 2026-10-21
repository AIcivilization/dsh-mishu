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
import type { MailAccount, MailFetcher, MailMessage } from './account.ts'
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

/** A connection or login failure, said so a person knows what to fix. */
export function describeMailError(error: unknown, account: Pick<MailAccount, 'host' | 'port'>): Bi {
  const raw = (error as { responseText?: string; message?: string }).responseText ?? (error as Error).message ?? String(error)
  const auth = /auth|login|password|credential|AUTHENTICATIONFAILED|LOGIN failed/i.test(raw)
  return auth
    ? bi(`登录失败：服务器不接受这个用户名或密码（${raw}）。多数邮箱要填客户端授权码或应用专用密码，不是网页登录密码。`, `Login failed: the server rejected the user name or password (${raw}). Most providers need an app password, not your web password.`)
    : bi(`连接 ${account.host}:${account.port} 失败：${raw}`, `Could not reach ${account.host}:${account.port}: ${raw}`)
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
