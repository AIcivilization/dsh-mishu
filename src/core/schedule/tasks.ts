/**
 * DSH's own scheduled tasks, seen from the secretary's side.
 *
 * DSH keeps a Schedule service (`@deepseek-ai/dsh-schedule`) that delivers a
 * prompt to a Session at a wall-clock time: the "自动化任务" page. This module
 * only describes what that service returns — it never imports DSH, so the
 * wording, the time formatting and the check for "is this the brief task"
 * stay testable without a host.
 *
 * The one task the secretary creates itself is the daily brief: same content
 * as the desktop notification, delivered into a conversation instead, so it
 * reaches you when DSH is open but you are not looking at the board.
 */

import { bi, pick, type Lang } from '../i18n.ts'
import { localClock } from '../notify.ts'

/** Where the notebook remembers the brief task it created, so it can be updated instead of duplicated. */
export const BRIEF_TASK_KEY = 'schedule.briefTask'

/** Marks the prompt the secretary writes, so a task edited by hand is still recognisable. */
export const BRIEF_MARK = '[dsh-mishu brief]'

export type ScheduleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule'

/**
 * One task as the Schedule service hands it out: its rule fields are spread
 * onto the entry, so which ones are present says what kind it is.
 */
export interface ScheduleEntry {
  id: string
  kind: ScheduleKind
  title: string
  prompt: string
  /** Next occurrence, RFC 3339 in UTC. */
  scheduledAt?: string
  afterSeconds?: number
  everySeconds?: number
  /** Local wall-clock time, `HH:mm:ss.SSS`. */
  time?: string
  timeZone?: string
  /** ISO weekdays, 1 = Monday. */
  weekdays?: number[]
  expression?: string
  rrule?: string
  status?: 'active' | 'paused' | 'ended' | 'inactive'
  createdAt?: string
  updatedAt?: string
  executionActive?: boolean
  lastDelivery?: { at?: string }
}

/** One task, worded for the settings page. */
export interface ScheduleTaskView {
  id: string
  title: string
  /** The rule, in words: "每天 08:30" / "every 15 minutes". */
  when: string
  /** Next occurrence, `11-12 08:30` in the task's own zone; null once it has ended. */
  next: string | null
  status: 'active' | 'paused' | 'ended'
  /** What the task tells the session, shortened for a tooltip. */
  prompt: string
  /** Created by the secretary itself (the daily brief). */
  mine: boolean
  running: boolean
  lastDelivery: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `HH:mm:ss.SSS` → `HH:mm`, or the raw value when it is not a clock time. */
export function clockText(time: string | undefined): string {
  if (time === undefined) return ''
  const match = /^(\d{2}):(\d{2})/.exec(time)
  return match === null ? time : `${match[1]}:${match[2]}`
}

/** An RFC 3339 instant as a local day and clock time, `11-12 08:30`. */
export function instantText(iso: string | undefined, timeZone: string, lang: Lang): string {
  if (iso === undefined) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  let clock: { day: string; minutes: number }
  try {
    clock = localClock(at, timeZone)
  } catch {
    clock = localClock(at, '')
  }
  const [year, month, day] = clock.day.split('-')
  const now = new Date()
  const sameYear = Number(year) === now.getFullYear()
  return `${sameYear ? '' : `${year}-`}${month}-${day} ${pad(Math.floor(clock.minutes / 60))}:${pad(clock.minutes % 60)}`
}

const WEEKDAY_ZH = ['一', '二', '三', '四', '五', '六', '日']
const WEEKDAY_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** The rule in words. Every branch names the unit a person set, never a cron string alone. */
export function describeTiming(entry: ScheduleEntry, lang: Lang): string {
  const zh = lang === 'zh'
  const zone = entry.timeZone === undefined || entry.timeZone === '' ? '' : entry.timeZone
  switch (entry.kind) {
    case 'after': {
      const seconds = entry.afterSeconds ?? 0
      if (seconds % 3600 === 0 && seconds >= 3600) return zh ? `${seconds / 3600} 小时后一次` : `once in ${seconds / 3600} h`
      if (seconds % 60 === 0 && seconds >= 60) return zh ? `${seconds / 60} 分钟后一次` : `once in ${seconds / 60} min`
      return zh ? `${seconds} 秒后一次` : `once in ${seconds} s`
    }
    case 'at':
      return zh ? `只跑一次，${instantText(entry.scheduledAt, zone, lang)}` : `once, ${instantText(entry.scheduledAt, zone, lang)}`
    case 'every': {
      const seconds = entry.everySeconds ?? 0
      if (seconds % 3600 === 0) return zh ? `每 ${seconds / 3600} 小时` : `every ${seconds / 3600} h`
      return zh ? `每 ${Math.max(1, Math.round(seconds / 60))} 分钟` : `every ${Math.max(1, Math.round(seconds / 60))} min`
    }
    case 'daily':
      return zh ? `每天 ${clockText(entry.time)}` : `daily at ${clockText(entry.time)}`
    case 'weekly': {
      const days = (entry.weekdays ?? []).slice().sort((a, b) => a - b)
      const names = zh ? days.map(d => WEEKDAY_ZH[d - 1] ?? String(d)) : days.map(d => WEEKDAY_EN[d - 1] ?? String(d))
      const list = zh ? names.join('、') : names.join(', ')
      return zh ? `每${list} ${clockText(entry.time)}` : `${list} at ${clockText(entry.time)}`
    }
    case 'cron':
      return zh ? `按规则 ${entry.expression ?? ''}` : `on the rule ${entry.expression ?? ''}`
    case 'rrule': {
      const first = (entry.rrule ?? '').split('\n').find(line => line.toUpperCase().startsWith('RRULE:')) ?? entry.rrule ?? ''
      return first.replace(/^RRULE:/i, '')
    }
  }
}

/** One entry, as the settings page shows it. */
export function taskView(entry: ScheduleEntry, lang: Lang, briefTaskId: string | undefined): ScheduleTaskView {
  const status = entry.status === undefined || entry.status === 'inactive' ? 'ended' : entry.status
  const zone = entry.timeZone ?? ''
  return {
    id: entry.id,
    title: entry.title,
    when: describeTiming(entry, lang),
    next: status === 'ended' ? null : instantText(entry.scheduledAt, zone, lang) || null,
    status,
    prompt: entry.prompt.replace(BRIEF_MARK, '').trim().slice(0, 400),
    mine: entry.id === briefTaskId || entry.prompt.includes(BRIEF_MARK),
    running: entry.executionActive === true,
    lastDelivery: entry.lastDelivery?.at === undefined ? null : instantText(entry.lastDelivery.at, zone, lang) || null,
  }
}

/** Sorted for reading: what still runs first, then what has ended. */
export function sortTasks(tasks: ScheduleTaskView[]): ScheduleTaskView[] {
  const rank = (t: ScheduleTaskView) => (t.status === 'active' ? 0 : t.status === 'paused' ? 1 : 2)
  return [...tasks].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
}

/** The prompt the brief task carries: what the agent should do at that hour. */
export function briefPrompt(lang: Lang): string {
  return lang === 'zh'
    ? [
        BRIEF_MARK,
        '现在是小秘书的每日简报时间。',
        '用 mishu_list 读出看板，然后用三句话说清楚：今天要处理什么（最多五件，按紧急程度），哪些快到期限，有没有哪个来源同步失败了。',
        '不要重复卡片原文，也不要替我做事，只把需要我决定的说出来。没有要处理的事就直接说"今天没有要处理的"。',
      ].join('\n')
    : [
        BRIEF_MARK,
        'It is time for the secretary\'s daily brief.',
        'Read the board with mishu_list, then say in three sentences: what needs me today (at most five, most urgent first), what is coming up, and whether any source failed to sync.',
        'Do not repeat the cards verbatim and do not act for me — only surface what needs my decision. If nothing is waiting, just say "nothing needs you today".',
      ].join('\n')
}

/** Title of the brief task, in the language it was created in. */
export function briefTitle(lang: Lang): string {
  return pick(bi('小秘书 · 每日简报', 'Secretary · daily brief'), lang)
}

export interface BriefTiming {
  time: string
  time_zone: string
}

/**
 * The daily rule for the brief, from a `HH:mm` setting and a zone. Seconds are
 * zero so the task fires on the minute; the zone falls back to this computer's
 * when the settings page has not picked one yet.
 */
export function briefTiming(time: string, timeZone: string): BriefTiming {
  const match = /^(\d{2}):(\d{2})$/.exec(time.trim())
  const clock = match === null ? '08:30' : `${match[1]}:${match[2]}`
  let zone = timeZone.trim()
  if (zone === '') {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
    } catch {
      zone = ''
    }
  }
  return { time: `${clock}:00.000`, time_zone: zone === '' ? 'UTC' : zone }
}

/** Whether a task already is the brief for this notebook. */
export function isBriefTask(entry: ScheduleEntry, briefTaskId: string | undefined): boolean {
  return entry.id === briefTaskId || entry.prompt.includes(BRIEF_MARK)
}
