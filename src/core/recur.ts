/**
 * Repeat rules for things you tell the secretary.
 *
 * A series is its first due day plus a repeat unit and step. Occurrence `k`
 * is always computed from the first due day, never from the previous
 * occurrence, so "the 31st, monthly" stays on month ends instead of drifting
 * to the 28th after February.
 */

import { bi, pick, type Bi, type Lang } from './i18n.ts'
import { addDays, addMonths, MONTHS_EN, parseDay, weekday } from './time.ts'

export type Repeat = 'none' | 'weekly' | 'monthly' | 'yearly'

export const REPEATS: readonly Repeat[] = ['none', 'weekly', 'monthly', 'yearly']

export type Category = 'document' | 'bill' | 'birthday' | 'renewal' | 'other'

export const CATEGORIES: readonly Category[] = ['document', 'bill', 'birthday', 'renewal', 'other']

export const CATEGORY_LABELS: Record<Category, Bi> = {
  document: bi('证件', 'Document'),
  bill: bi('账单', 'Bill'),
  birthday: bi('生日纪念日', 'Birthday'),
  renewal: bi('续费续保', 'Renewal'),
  other: bi('其他', 'Other'),
}

/** Default lead time per category, in days. Documents take months to renew; gifts need a week. */
export const DEFAULT_LEAD_DAYS: Record<Category, number> = {
  document: 90,
  bill: 3,
  birthday: 7,
  renewal: 7,
  other: 1,
}

export interface RepeatRule {
  firstDue: string
  repeat: Repeat
  /** Every how many weeks / months / years; 1 for `none`. */
  every: number
}

/** Due day of occurrence `k` (0-based); `undefined` once a one-off is used up. */
export function occurrence(rule: RepeatRule, k: number): string | undefined {
  if (k < 0) return undefined
  switch (rule.repeat) {
    case 'none': return k === 0 ? rule.firstDue : undefined
    case 'weekly': return addDays(rule.firstDue, 7 * rule.every * k)
    case 'monthly': return addMonths(rule.firstDue, rule.every * k)
    case 'yearly': return addMonths(rule.firstDue, 12 * rule.every * k)
  }
}

/** First day the occurrence due on `due` should be in front of you. */
export function remindDay(due: string, leadDays: number): string {
  return addDays(due, -leadDays)
}

/** Check a rule; returns the problem, or `undefined` when it is usable. */
export function checkRule(rule: RepeatRule): Bi | undefined {
  if (parseDay(rule.firstDue) === undefined) {
    return bi(`日期 ${rule.firstDue} 不是有效的日期（要 YYYY-MM-DD）`, `${rule.firstDue} is not a valid date (expected YYYY-MM-DD)`)
  }
  if (!REPEATS.includes(rule.repeat)) return bi(`不认识的重复方式：${rule.repeat}`, `unknown repeat: ${rule.repeat}`)
  if (!Number.isInteger(rule.every) || rule.every < 1 || rule.every > 100) {
    return bi(`间隔要是 1 到 100 的整数，收到的是 ${rule.every}`, `every must be a whole number from 1 to 100, got ${rule.every}`)
  }
  if (rule.repeat === 'none' && rule.every !== 1) return bi('不重复的事项，间隔只能是 1', 'a one-off cannot have every other than 1')
  return undefined
}

/** "每月 15 日" / "monthly on day 15" — how the rule reads to a person. */
export function describeRepeat(rule: RepeatRule, lang: Lang): string {
  const day = parseDay(rule.firstDue)!
  const n = rule.every
  const wd = weekday(rule.firstDue, lang)
  const monthEnd = day.d >= 29
  switch (rule.repeat) {
    case 'none':
      return pick(bi('不重复', 'once'), lang)
    case 'weekly':
      return pick(bi(n === 1 ? `每${wd}` : `每 ${n} 周的${wd}`, n === 1 ? `every ${wd}` : `every ${n} weeks on ${wd}`), lang)
    case 'monthly':
      return pick(bi(
        `${n === 1 ? '每月' : `每 ${n} 月`} ${day.d} 日${monthEnd ? '（月份没有这一天时按月底）' : ''}`,
        `${n === 1 ? 'monthly' : `every ${n} months`} on day ${day.d}${monthEnd ? ' (month end when shorter)' : ''}`,
      ), lang)
    case 'yearly':
      return pick(bi(
        `${n === 1 ? '每年' : `每 ${n} 年`} ${day.m} 月 ${day.d} 日`,
        `${n === 1 ? 'yearly' : `every ${n} years`} on ${MONTHS_EN[day.m - 1]} ${day.d}`,
      ), lang)
  }
}
