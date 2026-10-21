/**
 * The brief: what needs you now, what is coming, and what was closed for you.
 *
 * Closed matters are counted by reason, never hidden: "26 closed" without
 * the reasons would ask you to trust blindly.
 */

import { bi, decode, pick, type Bi, type Lang } from './i18n.ts'
import { upcoming } from './manual.ts'
import { isActive } from './matters.ts'
import { CATEGORY_LABELS, type Category } from './recur.ts'
import type { Matter, MishuStore } from './store.ts'
import type { GithubSyncReport, MarkReadMode } from './github/sync.ts'
import { dayOf, daysBetween, formatMoment, relativeDay, weekday } from './time.ts'

export const REASON_LABELS: Record<string, Bi> = {
  merged: bi('已合并', 'merged'),
  closed: bi('已关闭', 'closed'),
  recovered: bi('已恢复', 'recovered'),
  superseded: bi('已被取代', 'superseded'),
  'ref-gone': bi('分支已删除', 'branch deleted'),
  'info-release': bi('只是通知', 'just a notice'),
  'read-on-github': bi('你在 GitHub 上看过了', 'read on GitHub'),
  'fork-upstream-schedule': bi('fork 跑上游的定时任务', 'fork runs parent schedules'),
  'ci-failing': bi('CI 还在失败', 'CI still failing'),
  'review-requested': bi('等你审查', 'review requested'),
  mentioned: bi('@了你', 'mentioned you'),
  assigned: bi('指派给你', 'assigned to you'),
  'your-pr': bi('你的 PR 有新动态', 'activity on your PR'),
  'pr-activity': bi('PR 有新动态', 'PR activity'),
  'issue-activity': bi('issue 有新动态', 'issue activity'),
  'commit-comment': bi('提交有新评论', 'commit comment'),
  'check-failed': bi('没查成', 'check failed'),
  unclassified: bi('规则还不认识', 'not recognised'),
  manual: bi('你交代的', 'you told me'),
  reopened: bi('你重新打开的', 'reopened by you'),
  'done-by-you': bi('你标了完成', 'done by you'),
  'dismissed-by-you': bi('你标了忽略', 'dismissed by you'),
}

export function reasonLabel(reason: string | null, lang: Lang): string {
  if (reason === null) return ''
  const label = REASON_LABELS[reason]
  return label === undefined ? reason : pick(label, lang)
}

/** GitHub matters in the order they usually deserve attention. */
const GITHUB_PRIORITY = ['review-requested', 'mentioned', 'assigned', 'your-pr', 'commit-comment', 'ci-failing', 'fork-upstream-schedule', 'check-failed', 'unclassified']

function priority(m: Matter): number {
  const index = GITHUB_PRIORITY.indexOf(m.reason ?? '')
  return index === -1 ? GITHUB_PRIORITY.length : index
}

/** Manual matters first by due day (overdue on top), then GitHub by priority. */
export function sortOpen(matters: Matter[]): Matter[] {
  const manual = matters.filter(m => m.source === 'manual').sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? '') || a.id - b.id)
  const others = matters.filter(m => m.source !== 'manual').sort((a, b) => priority(a) - priority(b) || a.id - b.id)
  return [...manual, ...others]
}

function sourceTag(m: Matter, lang: Lang): string {
  if (m.source === 'manual') {
    const label = CATEGORY_LABELS[m.kind as Category]
    return `${pick(bi('交代', 'Noted'), lang)}·${label === undefined ? m.kind : pick(label, lang)}`
  }
  if (m.source === 'github') return 'GitHub'
  return m.source
}

/** One matter as a few lines. */
export function renderMatter(m: Matter, today: string, lang: Lang): string {
  const lines: string[] = []
  const title = decode(m.title, lang)
  if (m.source === 'manual' && m.dueDay !== null) {
    const overdueDays = -daysBetween(today, m.dueDay)
    const wd = weekday(m.dueDay, lang)
    const when = overdueDays > 0
      ? pick(bi(`到期，已过 ${overdueDays} 天 ⚠`, `due, ${overdueDays} days overdue ⚠`), lang)
      : relativeDay(m.dueDay, today, lang)
    lines.push(lang === 'zh'
      ? `#${m.id} [${sourceTag(m, lang)}] ${title} · ${m.dueDay}（${wd}）${when}`
      : `#${m.id} [${sourceTag(m, lang)}] ${title} · ${m.dueDay} (${wd}) ${when}`)
  } else {
    lines.push(`#${m.id} [${sourceTag(m, lang)}] ${title}`)
  }
  const why = m.source === 'manual' ? null : reasonLabel(m.reason, lang)
  const note = [why, decode(m.note, lang)].filter(x => x !== null && x !== '').join(lang === 'zh' ? '：' : ': ')
  if (note !== '') lines.push(`    ${note}`)
  if (m.url !== null) lines.push(`    ${m.url}`)
  return lines.join('\n')
}

export interface BriefOptions {
  now: number
  lang: Lang
  github?: { enabled: boolean; markRead: MarkReadMode }
  /** How far ahead "coming up" looks. */
  upcomingDays?: number
}

function countByReason(matters: Matter[], lang: Lang): string {
  const counts = new Map<string, number>()
  for (const m of matters) counts.set(m.reason ?? '', (counts.get(m.reason ?? '') ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r, n]) => `${reasonLabel(r, lang)} ${n}`).join(lang === 'zh' ? '、' : ', ')
}

export function renderBrief(store: MishuStore, options: BriefOptions): string {
  const { now, lang } = options
  const zh = lang === 'zh'
  const today = dayOf(now)
  const days = options.upcomingDays ?? 30
  const out: string[] = [`${zh ? '小秘书' : 'Secretary'} · ${formatMoment(now, now)}`, '']

  const all = sortOpen(store.openMatters())
  const open = all.filter(m => isActive(m, today))
  const snoozed = all.filter(m => !isActive(m, today))
  if (open.length === 0) {
    out.push(zh ? '要处理：没有。' : 'To handle: nothing.')
  } else {
    out.push(zh ? `要处理（${open.length}）` : `To handle (${open.length})`)
    for (const m of open) out.push(renderMatter(m, today, lang))
  }

  if (snoozed.length > 0) {
    out.push('', zh ? `稍后再提醒（${snoozed.length}）` : `Snoozed (${snoozed.length})`)
    for (const m of snoozed) out.push(`- #${m.id} ${decode(m.title, lang)} · ${zh ? `${m.snoozeUntil} 再提醒` : `back ${m.snoozeUntil}`}`)
  }

  const coming = upcoming(store, today, days)
  if (coming.length > 0) {
    out.push('', zh ? `快到了（${days} 天内，还没到提醒的时候）` : `Coming up (next ${days} days, not yet due for a reminder)`)
    for (const c of coming) {
      const wd = weekday(c.due, lang)
      const rel = relativeDay(c.due, today, lang)
      out.push(zh ? `- ${c.series.title} · ${c.due}（${wd}，${rel}），${c.remind} 开始提醒` : `- ${c.series.title} · ${c.due} (${wd}, ${rel}), reminding from ${c.remind}`)
    }
  }

  const closed = store.closedSince(now - 24 * 60 * 60 * 1000).filter(m => m.closedBy !== 'user')
  if (closed.length > 0) {
    const reasons = countByReason(closed, lang)
    out.push('', zh
      ? `最近 24 小时替你关掉 ${closed.length} 件：${reasons}。明细：/mishu 已关闭`
      : `Closed for you in the last 24 hours: ${closed.length} (${reasons}). Details: /mishu closed`)
  }

  if (options.github?.enabled === true) {
    out.push('')
    if (options.github.markRead === 'shadow') {
      const would = store.wouldMarkReadCount('github')
      if (would > 0) {
        out.push(zh
          ? `影子模式：如果打开自动标已读，会把 GitHub 上 ${would} 条已判定结束的通知标成已读。现在一条也没标。`
          : `Shadow mode: with marking read on, ${would} resolved GitHub notifications would be marked read. None has been.`)
      }
    }
    const last = store.get<GithubSyncReport>('github.lastSync')
    if (last === undefined) {
      out.push(zh ? 'GitHub：还没同步过。' : 'GitHub: not synced yet.')
    } else if (last.error !== undefined) {
      out.push(zh ? `GitHub：${formatMoment(last.at, now)} 同步失败：${last.error.zh}` : `GitHub: sync failed at ${formatMoment(last.at, now)}: ${last.error.en}`)
    } else {
      const failed = last.checkFailures > 0
        ? (zh ? `，其中 ${last.checkFailures} 条没查成，已交给你看` : `, ${last.checkFailures} could not be checked and were handed to you`)
        : ''
      out.push(zh
        ? `GitHub：${formatMoment(last.at, now)} 同步，${last.notifications} 条未读通知${failed}，用了 ${last.apiCalls} 次 API。`
        : `GitHub: synced ${formatMoment(last.at, now)}, ${last.notifications} unread notifications${failed}, ${last.apiCalls} API calls.`)
    }
  }
  return out.join('\n')
}

/** Recently closed matters with reasons, so a wrong closure can be reopened. */
export function renderClosed(store: MishuStore, now: number, lang: Lang, days = 3): string {
  const zh = lang === 'zh'
  const closed = store.closedSince(now - days * 24 * 60 * 60 * 1000)
  if (closed.length === 0) return zh ? `最近 ${days} 天没有关掉任何事项。` : `Nothing closed in the last ${days} days.`
  const lines = [
    zh
      ? `最近 ${days} 天关掉的事项（${closed.length}）。判错了就用 /mishu 恢复 <编号> 重新打开，规则会记下这次纠正。`
      : `Closed in the last ${days} days (${closed.length}). If one is wrong, reopen it with /mishu reopen <id>; the rule records the correction.`,
    '',
  ]
  for (const m of closed) {
    const by = m.closedBy === 'user' ? bi('你', 'you') : m.closedBy === 'source' ? bi('来源', 'the source') : bi('规则', 'a rule')
    const note = decode(m.note, lang)
    const at = m.closedAt === null ? '' : ` · ${formatMoment(m.closedAt, now)}`
    lines.push(`#${m.id} ${decode(m.title, lang)}`)
    lines.push(zh
      ? `    ${by.zh}关闭 · ${reasonLabel(m.reason, lang)}${note ? `：${note}` : ''}${at}`
      : `    closed by ${by.en} · ${reasonLabel(m.reason, lang)}${note ? `: ${note}` : ''}${at}`)
  }
  return lines.join('\n')
}
