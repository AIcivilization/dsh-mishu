/**
 * Calendar days in local time, as `YYYY-MM-DD` strings.
 *
 * Due dates are days, not instants: "rent on the 15th" means the whole local
 * day. Keeping them as strings avoids every DST and midnight off-by-one.
 */

import { bi, MishuError, type Lang } from './i18n.ts'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export interface DayParts {
  y: number
  m: number
  d: number
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** Parse a `YYYY-MM-DD` day; `undefined` when it is not a real calendar day. */
export function parseDay(day: string): DayParts | undefined {
  const match = DAY_RE.exec(day.trim())
  if (match === null) return undefined
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return undefined
  return { y, m, d }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatDay(parts: DayParts): string {
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`
}

function mustParse(day: string): DayParts {
  const parts = parseDay(day)
  if (parts === undefined) throw new MishuError(bi(`不是有效的日期：${day}`, `not a valid date: ${day}`))
  return parts
}

/** The local calendar day containing `ms`. */
export function dayOf(ms: number): string {
  const date = new Date(ms)
  return formatDay({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() })
}

/** Local midnight at the start of `day`. */
export function dayStart(day: string): number {
  const { y, m, d } = mustParse(day)
  return new Date(y, m - 1, d).getTime()
}

export function addDays(day: string, n: number): string {
  const { y, m, d } = mustParse(day)
  const date = new Date(y, m - 1, d + n)
  return formatDay({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() })
}

/**
 * `anchor` moved by `n` months, keeping the anchor's day of month and clamping
 * it to the target month's length (the 31st becomes the 30th in April, Feb 29
 * becomes Feb 28 in other years).
 */
export function addMonths(anchor: string, n: number): string {
  const { y, m, d } = mustParse(anchor)
  const index = y * 12 + (m - 1) + n
  const ty = Math.floor(index / 12)
  const tm = index - ty * 12 + 1
  return formatDay({ y: ty, m: tm, d: Math.min(d, daysInMonth(ty, tm)) })
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  const pa = mustParse(a)
  const pb = mustParse(b)
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000)
}

const WEEKDAYS: Record<Lang, readonly string[]> = {
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
}

export const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function weekday(day: string, lang: Lang): string {
  const { y, m, d } = mustParse(day)
  return WEEKDAYS[lang][new Date(y, m - 1, d).getDay()]!
}

/** A day as people say it relative to `today`: 今天 / today, 3 天后 / in 3 days, 已过 2 天 / 2 days ago. */
export function relativeDay(day: string, today: string, lang: Lang): string {
  const n = daysBetween(today, day)
  if (lang === 'zh') {
    if (n === 0) return '今天'
    if (n === 1) return '明天'
    if (n === 2) return '后天'
    if (n === -1) return '昨天'
    return n > 0 ? `${n} 天后` : `已过 ${-n} 天`
  }
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}

/** `MM-DD HH:MM` for a moment, with the year when it is not this year. */
export function formatMoment(ms: number, now: number): string {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${sameYear ? '' : `${date.getFullYear()}-`}${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `MM-DD` for a moment. */
export function shortDay(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
