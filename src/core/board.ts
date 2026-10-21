/**
 * The board: a summary on top and three columns.
 *
 *   要你处理 / To handle     what needs you today
 *   我记着   / I'm keeping   snoozed items and things not due for a reminder yet
 *   替你办了 / Done for you  what was closed in the last 7 days, grouped by reason
 *
 * Built here from the notebook as plain data, in one language, so the page
 * only lays it out and every number can be tested without a browser.
 */

import { reasonLabel, sortOpen } from './brief.ts'
import type { GithubSyncReport, MarkReadMode } from './github/sync.ts'
import { decode, type Lang } from './i18n.ts'
import { manualExplain, storedExplain, type CardExplain } from './explain.ts'
import { isActive } from './matters.ts'
import { mailReportKey, type MailSyncReport } from './mail/sync.ts'
import { CATEGORY_LABELS, describeRepeat, occurrence, remindDay, type Category } from './recur.ts'
import type { Matter, MishuStore } from './store.ts'
import { addDays, dayOf, dayStart, daysBetween, formatMoment, relativeDay, weekday } from './time.ts'

export type CardAction = 'open' | 'done' | 'snooze' | 'dismiss' | 'unsnooze' | 'reopen' | 'stop'

export interface BoardCard {
  /** Matter id, or series id for a series card. */
  id: number
  target: 'matter' | 'series'
  source: 'github' | 'mail' | 'manual'
  title: string
  /** One short line: when it is due, or why it is here. */
  meta: string
  note: string | null
  url: string | null
  tone: 'danger' | 'warn' | 'normal'
  actions: CardAction[]
  /** What this is, why it is here (or why it was closed), what to do. */
  explain: CardExplain | null
}

export interface DoneGroup {
  reason: string
  label: string
  items: BoardCard[]
}

export interface BoardData {
  lang: Lang
  at: number
  summary: string
  metrics: { handle: number; overdue: number; dueSoon: number; closedToday: number; shadow: number }
  sources: {
    github: { state: 'off' | 'never' | 'ok' | 'error'; text: string }
    manual: { series: number }
    mail: Array<{ id: number; label: string; state: 'never' | 'ok' | 'error'; text: string }>
  }
  markRead: MarkReadMode
  columns: { handle: BoardCard[]; remember: BoardCard[]; done: { total: number; groups: DoneGroup[] } }
}

export interface BoardOptions {
  now: number
  lang: Lang
  github: { enabled: boolean; markRead: MarkReadMode }
  /** How far back "done for you" looks. */
  doneDays?: number
  /** Mail accounts, for their status line. */
  mailAccounts?: Array<{ id: number; label: string }>
}

const zhOr = (lang: Lang, zh: string, en: string) => (lang === 'zh' ? zh : en)

function dueText(due: string, today: string, lang: Lang): string {
  const overdue = -daysBetween(today, due)
  if (overdue > 0) return zhOr(lang, `${due.slice(5)} 到期 · 已过 ${overdue} 天`, `due ${due.slice(5)} · ${overdue} days overdue`)
  return zhOr(lang, `${due.slice(5)}（${weekday(due, lang)}）到期 · ${relativeDay(due, today, lang)}`, `due ${due.slice(5)} (${weekday(due, lang)}) · ${relativeDay(due, today, lang)}`)
}

function matterCard(store: MishuStore, m: Matter, today: string, now: number, lang: Lang, column: 'handle' | 'remember' | 'done'): BoardCard {
  const manual = m.source === 'manual'
  const title = decode(m.title, lang)
  const note = decode(m.note, lang)
  let meta: string
  let tone: BoardCard['tone'] = 'normal'
  if (column === 'remember' && m.snoozeUntil !== null) {
    meta = zhOr(lang, `稍后 · ${m.snoozeUntil.slice(5)} 再提醒`, `snoozed · back ${m.snoozeUntil.slice(5)}`)
  } else if (column === 'done') {
    meta = reasonLabel(m.reason, lang)
  } else if (manual && m.dueDay !== null) {
    meta = dueText(m.dueDay, today, lang)
    if (daysBetween(today, m.dueDay) < 0) tone = 'danger'
    else if (daysBetween(today, m.dueDay) <= 1) tone = 'warn'
  } else {
    const label = CATEGORY_LABELS[m.kind as Category]
    const where = m.source === 'mail' ? zhOr(lang, '邮件', 'Mail') : 'GitHub'
    meta = manual && label !== undefined ? label[lang] : `${where} · ${reasonLabel(m.reason, lang)}`
  }
  const actions: CardAction[] = column === 'handle'
    ? [...m.url === null ? [] : ['open' as const], 'done', 'snooze', 'dismiss']
    : column === 'remember'
      ? ['unsnooze', 'done']
      : [...m.url === null ? [] : ['open' as const], 'reopen']
  const explain = manual ? manualExplain(store, m, today, now, lang) : storedExplain(m, lang) ?? null
  if (explain !== null && column === 'done' && !manual && m.closedBy === 'user' && m.closedAt !== null) {
    const at = formatMoment(m.closedAt, now)
    explain.why = zhOr(lang, `你在 ${at} ${m.status === 'done' ? '标了完成' : '标了忽略'}。之前的情况：${explain.why}`, `You ${m.status === 'done' ? 'marked it done' : 'dismissed it'} at ${at}. Before that: ${explain.why}`)
    explain.fix = null
  }
  if (explain !== null && column === 'remember' && !manual && m.snoozeUntil !== null) {
    explain.why += zhOr(lang, `你说了"明天再说"，${m.snoozeUntil} 会回到"要你处理"。`, ` You put it off; it comes back on ${m.snoozeUntil}.`)
  }
  // The open button says what it opens ("Turn off Actions", "Open the failing log").
  return { id: m.id, target: 'matter', source: manual ? 'manual' : m.source === 'mail' ? 'mail' : 'github', title, meta, note: note === '' ? null : note, url: explain?.link?.url ?? m.url, tone, actions, explain }
}

export function buildBoard(store: MishuStore, options: BoardOptions): BoardData {
  const { now, lang } = options
  const today = dayOf(now)
  const open = sortOpen(store.openMatters())
  const handle = open.filter(m => isActive(m, today))
  const snoozed = open.filter(m => !isActive(m, today)).sort((a, b) => (a.snoozeUntil ?? '').localeCompare(b.snoozeUntil ?? ''))

  // Every active series whose next occurrence is not on the list yet.
  const seriesCards: Array<{ due: string; card: BoardCard }> = []
  for (const series of store.activeSeries()) {
    const due = occurrence(series, series.nextK)
    if (due === undefined) continue
    const remind = remindDay(due, series.leadDays)
    const repeat = series.repeat === 'none' ? '' : ` · ${describeRepeat(series, lang)}`
    seriesCards.push({
      due,
      card: {
        id: series.id, target: 'series', source: 'manual', title: series.title,
        meta: zhOr(lang, `${due} 到期 · ${remind.slice(5)} 提醒${repeat}`, `due ${due} · reminder ${remind.slice(5)}${repeat}`),
        note: series.note, url: null, tone: 'normal', actions: ['stop'],
        explain: {
          what: zhOr(lang, `你交代的${CATEGORY_LABELS[series.category][lang]}：${series.title}`, `Something you told me (${CATEGORY_LABELS[series.category][lang]}): ${series.title}`),
          why: zhOr(lang, `${due} 到期，还没到提醒的时候；${remind} 起会出现在"要你处理"。`, `Due ${due}; not time to remind you yet. It moves to "To handle" on ${remind}.`),
          fix: null,
        },
      },
    })
  }
  seriesCards.sort((a, b) => a.due.localeCompare(b.due))

  const doneSince = now - (options.doneDays ?? 7) * 86_400_000
  const closed = store.closedSince(doneSince)
  const groups = new Map<string, Matter[]>()
  for (const m of closed) {
    const key = m.closedBy === 'user' ? 'done-by-you' : (m.reason ?? '')
    if (m.status === 'dismissed') continue
    const list = groups.get(key) ?? []
    list.push(m)
    groups.set(key, list)
  }
  const doneGroups: DoneGroup[] = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([reason, items]) => ({ reason, label: reasonLabel(reason, lang), items: items.map(m => matterCard(store, m, today, now, lang, 'done')) }))

  const overdue = handle.filter(m => m.dueDay !== null && daysBetween(today, m.dueDay) < 0).length
  const soonLimit = addDays(today, 7)
  const dueSoon = handle.filter(m => m.dueDay !== null && m.dueDay >= today && m.dueDay <= soonLimit).length
    + seriesCards.filter(s => s.due >= today && s.due <= soonLimit).length
  const closedToday = closed.filter(m => m.closedBy !== 'user' && (m.closedAt ?? 0) >= dayStart(today)).length
  const shadow = options.github.enabled && options.github.markRead === 'shadow' ? store.wouldMarkReadCount('github') : 0

  const last = store.get<GithubSyncReport>('github.lastSync')
  const mail: BoardData['sources']['mail'] = (options.mailAccounts ?? []).map((account) => {
    const report = store.get<MailSyncReport>(mailReportKey(account.id))
    if (report === undefined) return { id: account.id, label: account.label, state: 'never', text: zhOr(lang, `${account.label} 还没收过`, `${account.label} not checked yet`) }
    if (report.error !== undefined) return { id: account.id, label: account.label, state: 'error', text: zhOr(lang, `${account.label}：${report.error.zh}`, `${account.label}: ${report.error.en}`) }
    return { id: account.id, label: account.label, state: 'ok', text: zhOr(lang, `${account.label} ${formatMoment(report.at, now)} 收信`, `${account.label} checked ${formatMoment(report.at, now)}`) }
  })
  const github: BoardData['sources']['github'] = !options.github.enabled
    ? { state: 'off', text: zhOr(lang, 'GitHub 未开启', 'GitHub off') }
    : last === undefined
      ? { state: 'never', text: zhOr(lang, 'GitHub 还没同步', 'GitHub not synced yet') }
      : last.error !== undefined
        ? { state: 'error', text: zhOr(lang, `GitHub 同步失败：${last.error.zh}`, `GitHub sync failed: ${last.error.en}`) }
        : { state: 'ok', text: zhOr(lang, `GitHub ${formatMoment(last.at, now)} 同步`, `GitHub synced ${formatMoment(last.at, now)}`) }

  const parts: string[] = []
  if (handle.length === 0) parts.push(zhOr(lang, '现在没有要你处理的事。', 'Nothing needs you right now.'))
  else {
    const first = decode(handle[0]!.title, lang)
    parts.push(overdue > 0
      ? zhOr(lang, `有 ${handle.length} 件要你处理，其中 ${overdue} 件已经过期，先看「${first}」。`, `${handle.length} to handle, ${overdue} overdue; start with "${first}".`)
      : zhOr(lang, `有 ${handle.length} 件要你处理，先看「${first}」。`, `${handle.length} to handle; start with "${first}".`))
  }
  if (closedToday > 0) parts.push(zhOr(lang, `今天替你关掉了 ${closedToday} 件，理由都在右栏。`, `Closed ${closedToday} for you today; the reasons are on the right.`))
  if (github.state === 'error') parts.push(zhOr(lang, 'GitHub 这次没同步成。', 'The last GitHub sync failed.'))
  for (const box of mail.filter(b => b.state === 'error')) parts.push(zhOr(lang, `邮箱「${box.label}」这次没收成。`, `Mail "${box.label}" could not be checked.`))

  return {
    lang,
    at: now,
    summary: parts.join(lang === 'zh' ? '' : ' '),
    metrics: { handle: handle.length, overdue, dueSoon, closedToday, shadow },
    sources: { github, manual: { series: store.activeSeries().length }, mail },
    markRead: options.github.markRead,
    columns: {
      handle: handle.map(m => matterCard(store, m, today, now, lang, 'handle')),
      remember: [...snoozed.map(m => matterCard(store, m, today, now, lang, 'remember')), ...seriesCards.map(s => s.card)],
      done: { total: doneGroups.reduce((n, g) => n + g.items.length, 0), groups: doneGroups },
    },
  }
}

export interface MatterDetail {
  id: number
  title: string
  status: 'open' | 'done' | 'dismissed'
  reason: string
  explain: CardExplain | null
  /** What the secretary did about it, in order. */
  did: string[]
  /** The notifications folded into this item, newest first. */
  messages: Array<{ title: string; at: string; why: string | null }>
}

/** Everything behind one card: the explanation, what was done, and the notifications it came from. */
export function buildDetail(store: MishuStore, id: number, options: { now: number; lang: Lang; markRead: MarkReadMode }): MatterDetail | undefined {
  const { now, lang } = options
  const m = store.matterById(id)
  if (m === undefined) return undefined
  const today = dayOf(now)
  const messages = store.messagesOfMatter(m.key)
  const did: string[] = []
  const at = (ms: number | null) => (ms === null ? '' : formatMoment(ms, now))
  if (m.status !== 'open') {
    if (m.closedBy === 'rule') did.push(zhOr(lang, `${at(m.closedAt)} 小秘书按上面的理由，在自己的清单里把它关掉了。`, `At ${at(m.closedAt)} the secretary closed it on its own list, for the reason above.`))
    else if (m.closedBy === 'source') did.push(zhOr(lang, `${at(m.closedAt)} 这些通知已经在 GitHub（或邮件）里被看过，小秘书跟着关掉了。`, `At ${at(m.closedAt)} these notifications had been read on GitHub (or by email), so the secretary closed it too.`))
    else did.push(zhOr(lang, `你在 ${at(m.closedAt)} ${m.status === 'done' ? '标了完成' : '标了忽略'}。`, `You ${m.status === 'done' ? 'marked it done' : 'dismissed it'} at ${at(m.closedAt)}.`))
  } else if (m.overrideAt !== null) {
    did.push(zhOr(lang, `你在 ${at(m.overrideAt)} 改过它的状态。`, `You changed it at ${at(m.overrideAt)}.`))
  }
  if (m.source === 'github') {
    const marked = messages.filter(x => x.markedReadAt !== null)
    const would = messages.filter(x => x.unread && x.wouldMarkRead).length
    if (marked.length > 0) did.push(zhOr(lang, `已在 GitHub 上把其中 ${marked.length} 条通知标成已读。`, `Marked ${marked.length} of its notifications read on GitHub.`))
    else if (would > 0 && options.markRead === 'shadow') did.push(zhOr(lang, `GitHub 上没有改动。影子模式：打开自动标已读后，会把其中 ${would} 条通知标成已读。`, `Nothing changed on GitHub. Shadow mode: once marking read is on, ${would} of its notifications would be marked read.`))
    else did.push(zhOr(lang, 'GitHub 上没有改动。', 'Nothing changed on GitHub.'))
  }
  return {
    id: m.id,
    title: decode(m.title, lang),
    status: m.status,
    reason: reasonLabel(m.reason, lang),
    explain: m.source === 'manual' ? manualExplain(store, m, today, now, lang) : storedExplain(m, lang) ?? null,
    did,
    messages: messages.map(x => ({ title: x.title, at: formatMoment(x.updatedAt, now), why: x.why })),
  }
}
