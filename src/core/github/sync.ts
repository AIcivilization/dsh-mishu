/**
 * One GitHub sync: pull every unread notification, look up what is true now,
 * judge it, and fold the verdicts into matters.
 *
 * Marking read on GitHub is off by default and has a shadow mode: the sync
 * records what it *would* mark, so you can check before turning it on. A
 * matter you set by hand stays as you left it until newer activity arrives.
 */

import { applyVerdict, closeReadElsewhere, mapLimit } from '../fold.ts'
import { bi, type Bi } from '../i18n.ts'
import { isDemoted, type DemotionPolicy } from '../matters.ts'
import type { MishuStore } from '../store.ts'
import type { GitHubClient, Notification } from './client.ts'
import { gatherFacts, Lookups } from './facts.ts'
import { CLOSING_REASONS, judge, type Verdict } from './rules.ts'

export type MarkReadMode = 'off' | 'shadow' | 'on'

export interface GithubSyncOptions {
  store: MishuStore
  gh: GitHubClient
  now: number
  markRead: MarkReadMode
  /** Reasons allowed to mark read (only closing reasons are honoured). */
  markReadReasons: readonly string[]
  demotion?: DemotionPolicy
}

export interface GithubSyncReport {
  at: number
  notifications: number
  /** Matters this sync opened or reopened. */
  opened: number
  /** Matters this sync closed (by rule or because you read them on GitHub). */
  closed: number
  wouldMarkRead: number
  markedRead: number
  checkFailures: number
  apiCalls: number
  error?: Bi
}

export const SOURCE = 'github'

/** Fold the verdicts of one matter's messages: open if anything is open; otherwise the newest closing verdict. */
function combine(verdicts: Array<{ n: Notification; v: Verdict }>): Verdict & { activityAt: number } {
  const sorted = [...verdicts].sort((a, b) => Date.parse(b.n.updated_at) - Date.parse(a.n.updated_at))
  const pick = sorted.find(x => x.v.status === 'open') ?? sorted[0]!
  return { ...pick.v, activityAt: Date.parse(sorted[0]!.n.updated_at) }
}

export async function syncGithub(options: GithubSyncOptions): Promise<GithubSyncReport> {
  const { store, gh, now } = options
  const report: GithubSyncReport = { at: now, notifications: 0, opened: 0, closed: 0, wouldMarkRead: 0, markedRead: 0, checkFailures: 0, apiCalls: 0 }
  const callsBefore = gh.calls
  let notifications: Notification[]
  try {
    notifications = await gh.notifications()
  } catch (error) {
    const message = (error as Error).message
    report.error = bi(message, message)
    report.apiCalls = gh.calls - callsBefore
    store.set('github.lastSync', report)
    return report
  }
  report.notifications = notifications.length

  const lookups = new Lookups(gh)
  const judged = await mapLimit(notifications, 6, async (n) => {
    const facts = await gatherFacts(n, lookups, now)
    let v = judge(n, facts)
    if (v.status === 'done' && isDemoted(store, v.reason, options.demotion)) {
      const demoted = bi(`「${v.reason}」这条规则被你纠正得多，已降级，先交给你看`, `the "${v.reason}" rule was corrected often and is demoted, so this is handed to you`)
      v = {
        ...v,
        status: 'open',
        note: v.note === null ? demoted : bi(`${v.note.zh}（${demoted.zh}）`, `${v.note.en} (${demoted.en})`),
        explain: {
          ...v.explain,
          why: bi(`${v.explain.why.zh}（${demoted.zh}。）`, `${v.explain.why.en} (${demoted.en}.)`),
          fix: bi('规则认为它已经结束，但这条规则最近错得多：打开确认一下，确实结束了就点"办完了"。', 'The rule says it is over, but this rule has been wrong often lately: check, and mark it done if it really is.'),
        },
      }
    }
    return { n, v }
  })
  report.checkFailures = judged.filter(x => x.v.reason === 'check-failed').length

  const byMatter = new Map<string, Array<{ n: Notification; v: Verdict }>>()
  for (const item of judged) {
    const list = byMatter.get(item.v.matterKey) ?? []
    list.push(item)
    byMatter.set(item.v.matterKey, list)
  }

  const allowMarkRead = new Set(options.markReadReasons.filter(r => (CLOSING_REASONS as readonly string[]).includes(r)))
  const toMark: string[] = []

  store.transaction(() => {
    const counts = { opened: 0, closed: 0 }
    const seen = new Set<string>()
    for (const [key, items] of byMatter) {
      const matter = applyVerdict(store, SOURCE, combine(items), now, counts)
      for (const { n, v } of items) {
        seen.add(n.id)
        store.upsertMessage({
          id: n.id,
          source: SOURCE,
          matterKey: key,
          subjectType: n.subject.type,
          why: n.reason,
          repo: n.repository.full_name,
          title: n.subject.title,
          updatedAt: Date.parse(n.updated_at),
          unread: n.unread,
          verdictStatus: v.status,
          verdictReason: v.reason,
          seenAt: now,
        })
        const eligible = matter.status === 'done' && matter.closedBy === 'rule' && v.status === 'done' && allowMarkRead.has(v.reason)
        store.setWouldMarkRead(n.id, eligible && options.markRead !== 'off')
        if (eligible && options.markRead === 'on') toMark.push(n.id)
      }
    }

    // Threads that left the unread list were read somewhere else (on GitHub, by email).
    counts.closed += closeReadElsewhere(store, SOURCE, seen, new Set(byMatter.keys()), now, 'read-on-github')
    report.opened = counts.opened
    report.closed = counts.closed
  })

  for (const id of toMark) {
    try {
      await gh.markThreadRead(id)
      store.setMarkedRead(id, now)
      store.log(now, 'github-mark-read', { thread: id })
      report.markedRead++
    } catch (error) {
      store.log(now, 'github-mark-read-failed', { thread: id, error: (error as Error).message })
    }
  }
  report.wouldMarkRead = store.wouldMarkReadCount(SOURCE)
  report.apiCalls = gh.calls - callsBefore
  store.set('github.lastSync', report)
  return report
}
