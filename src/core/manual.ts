/**
 * Things you tell the secretary: "passport expires 2027-03-10", "rent on the
 * 15th every month".
 *
 * A series becomes a matter when its reminder day arrives. Marking that
 * matter done closes only this occurrence; the next one appears by itself
 * when its own reminder day comes.
 */

import { bi, MishuError, pick, type Lang } from './i18n.ts'
import {
  CATEGORIES, CATEGORY_LABELS, DEFAULT_LEAD_DAYS, checkRule, describeRepeat, occurrence, remindDay,
  type Category, type Repeat,
} from './recur.ts'
import type { Matter, MishuStore, Series } from './store.ts'
import { daysBetween, relativeDay, weekday } from './time.ts'

export interface SeriesInput {
  title: string
  /** First due day, `YYYY-MM-DD`. */
  due: string
  repeat?: Repeat
  every?: number
  category?: Category
  /** Days before each due day to start reminding; defaults by category. */
  leadDays?: number
  note?: string
}

export interface ResolvedSeries {
  title: string
  category: Category
  firstDue: string
  repeat: Repeat
  every: number
  leadDays: number
  note: string | null
}

/** Defaults filled in and checked; throws a `MishuError` a person can act on. */
export function resolveSeries(input: SeriesInput, leadDefaults: Record<Category, number> = DEFAULT_LEAD_DAYS): ResolvedSeries {
  const title = String(input.title ?? '').trim()
  if (title === '') throw new MishuError(bi('事项内容是空的', 'the item has no title'))
  const category = input.category ?? 'other'
  if (!CATEGORIES.includes(category)) throw new MishuError(bi(`不认识的类别：${category}`, `unknown category: ${category}`))
  const resolved: ResolvedSeries = {
    title,
    category,
    firstDue: String(input.due ?? '').trim(),
    repeat: input.repeat ?? 'none',
    every: input.every ?? 1,
    leadDays: input.leadDays ?? leadDefaults[category],
    note: input.note?.trim() || null,
  }
  const problem = checkRule(resolved)
  if (problem !== undefined) throw new MishuError(problem)
  if (!Number.isInteger(resolved.leadDays) || resolved.leadDays < 0 || resolved.leadDays > 366) {
    throw new MishuError(bi(
      `提前天数要是 0 到 366 的整数，收到的是 ${resolved.leadDays}`,
      `lead days must be a whole number from 0 to 366, got ${resolved.leadDays}`,
    ))
  }
  return resolved
}

/**
 * What the secretary understood, in one block — shown before anything is
 * saved so a misread date is caught by you, not by a missed deadline.
 */
export function describeSeries(s: ResolvedSeries, today: string, lang: Lang): string {
  const first = lang === 'zh'
    ? `${s.firstDue}（${weekday(s.firstDue, lang)}，${relativeDay(s.firstDue, today, lang)}）`
    : `${s.firstDue} (${weekday(s.firstDue, lang)}, ${relativeDay(s.firstDue, today, lang)})`
  const remind = remindDay(s.firstDue, s.leadDays)
  const category = pick(CATEGORY_LABELS[s.category], lang)
  const lines = lang === 'zh'
    ? [
        `事项：${s.title}`,
        `类别：${category}`,
        s.repeat === 'none' ? `日期：${first}` : `重复：${describeRepeat(s, lang)}；下一次 ${first}`,
        s.leadDays === 0 ? '提醒：当天' : `提醒：提前 ${s.leadDays} 天（从 ${remind} 开始出现在待处理里）`,
      ]
    : [
        `Item: ${s.title}`,
        `Category: ${category}`,
        s.repeat === 'none' ? `Date: ${first}` : `Repeats: ${describeRepeat(s, lang)}; next ${first}`,
        s.leadDays === 0 ? 'Reminder: on the day' : `Reminder: ${s.leadDays} days ahead (on the list from ${remind})`,
      ]
  if (s.note !== null) lines.push(lang === 'zh' ? `备注：${s.note}` : `Note: ${s.note}`)
  if (s.repeat === 'none' && daysBetween(today, s.firstDue) < 0) {
    lines.push(pick(bi('注意：这个日期已经过去了，记下后会直接显示为过期', 'Heads-up: this date has passed; it will show as overdue right away'), lang))
  }
  return lines.join('\n')
}

export function addSeries(store: MishuStore, s: ResolvedSeries, now: number): Series {
  return store.transaction(() => {
    const series = store.insertSeries(s, now)
    store.log(now, 'series-add', { id: series.id, ...s })
    return series
  })
}

export function stopSeries(store: MishuStore, id: number, now: number): Series | undefined {
  const series = store.seriesById(id)
  if (series === undefined) return undefined
  store.advanceSeries(id, series.nextK, false, now)
  store.log(now, 'series-stop', { id })
  return store.seriesById(id)
}

function instanceKey(seriesId: number, due: string): string {
  return `manual:${seriesId}:${due}`
}

/** Cap per series per tick, so a long downtime does not flood the list. */
const MAX_CATCH_UP = 12

/**
 * Turn every occurrence whose reminder day has arrived into a matter.
 * Returns the matters created. Idempotent: run it as often as you like.
 */
export function tickManual(store: MishuStore, today: string, now: number): Matter[] {
  const created: Matter[] = []
  for (const series of store.activeSeries()) {
    let k = series.nextK
    let active = true
    for (let n = 0; n < MAX_CATCH_UP; n++) {
      const due = occurrence(series, k)
      if (due === undefined) {
        active = false
        break
      }
      const remind = remindDay(due, series.leadDays)
      if (daysBetween(today, remind) > 0) break
      const key = instanceKey(series.id, due)
      if (store.matterByKey(key) === undefined) {
        created.push(store.insertMatter({
          key,
          source: 'manual',
          kind: series.category,
          title: series.title,
          note: series.note,
          status: 'open',
          reason: 'manual',
          dueDay: due,
          remindDay: remind,
          seriesId: series.id,
        }, now))
      }
      k++
    }
    if (k !== series.nextK || !active) {
      if (series.repeat === 'none' && occurrence(series, k) === undefined) active = false
      store.advanceSeries(series.id, k, active, now)
    }
  }
  return created
}

export interface Upcoming {
  series: Series
  due: string
  remind: string
}

/** Next occurrence of each active series that is not on the list yet, within `days`. */
export function upcoming(store: MishuStore, today: string, days: number): Upcoming[] {
  const result: Upcoming[] = []
  for (const series of store.activeSeries()) {
    const due = occurrence(series, series.nextK)
    if (due === undefined) continue
    if (daysBetween(today, due) > days) continue
    result.push({ series, due, remind: remindDay(due, series.leadDays) })
  }
  return result.sort((a, b) => a.due.localeCompare(b.due))
}

/** One line per series still in play (repeating, or a one-off not done yet), for "what have I told you". */
export function describeActiveSeries(store: MishuStore, today: string, lang: Lang): string[] {
  const pendingIds = new Set(store.openMatters().map(m => m.seriesId).filter(id => id !== null))
  const inPlay = [...store.activeSeries(), ...[...pendingIds].map(id => store.seriesById(id)!).filter(s => !s.active)]
  return inPlay.sort((a, b) => a.id - b.id).map((series) => {
    const next = occurrence(series, series.nextK)
    const when = series.repeat === 'none' ? ` ${series.firstDue}` : ''
    if (lang === 'zh') {
      const nextText = next === undefined ? '' : `；下一次 ${next}（${relativeDay(next, today, lang)}）`
      return `#${series.id} ${series.title} · ${describeRepeat(series, lang)}${when}${nextText}；提前 ${series.leadDays} 天`
    }
    const nextText = next === undefined ? '' : `; next ${next} (${relativeDay(next, today, lang)})`
    return `#${series.id} ${series.title} · ${describeRepeat(series, lang)}${when}${nextText}; ${series.leadDays} days ahead`
  })
}
