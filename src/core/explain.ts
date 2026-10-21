/**
 * Explanations, resolved into one language for a card or a detail view.
 *
 * GitHub items carry the explanation their rule wrote (stored as JSON).
 * Things you told the secretary are explained here from the series itself:
 * when it is due, what the note says, what happens once it is done.
 */

import type { Explain } from './github/rules.ts'
import { type Bi, type Lang } from './i18n.ts'
import { CATEGORY_LABELS, occurrence, type Category } from './recur.ts'
import type { Matter, MishuStore } from './store.ts'
import { daysBetween, formatMoment, weekday } from './time.ts'

export interface CardExplain {
  what: string
  why: string
  fix: string | null
  link?: { label: string; url: string }
}

const zhOr = (lang: Lang, zh: string, en: string) => (lang === 'zh' ? zh : en)

function pickExplain(e: Explain, lang: Lang): CardExplain {
  const pick = (t: Bi) => t[lang]
  return {
    what: pick(e.what),
    why: pick(e.why),
    fix: e.fix === null ? null : pick(e.fix),
    ...e.link === undefined ? {} : { link: { label: pick(e.link.label), url: e.link.url } },
  }
}

/** The stored rule explanation, or `undefined` when there is none (items from before explanations existed). */
export function storedExplain(m: Matter, lang: Lang): CardExplain | undefined {
  if (m.explain === null) return undefined
  try {
    return pickExplain(JSON.parse(m.explain) as Explain, lang)
  } catch {
    return undefined
  }
}

/** Something you told the secretary: when it is due and what happens after you are done. */
export function manualExplain(store: MishuStore, m: Matter, today: string, now: number, lang: Lang): CardExplain {
  const label = CATEGORY_LABELS[m.kind as Category]
  const category = label === undefined ? m.kind : label[lang]
  const what = zhOr(lang, `你交代的${category}：${m.title}`, `Something you told me (${category}): ${m.title}`)
  if (m.status !== 'open') {
    const at = m.closedAt === null ? '' : formatMoment(m.closedAt, now)
    return {
      what,
      why: m.status === 'done'
        ? zhOr(lang, `你在 ${at} 标了完成。`, `You marked it done at ${at}.`)
        : zhOr(lang, `你在 ${at} 标了忽略。`, `You dismissed it at ${at}.`),
      fix: null,
    }
  }
  const due = m.dueDay
  const note = m.note === null ? '' : zhOr(lang, `备注：${m.note}。`, ` Note: ${m.note}.`)
  let why: string
  if (due === null) {
    why = note
  } else {
    const n = daysBetween(today, due)
    const wd = weekday(due, lang)
    why = n < 0
      ? zhOr(lang, `${due}（${wd}）到期，已经过了 ${-n} 天。${note}`, `It was due ${due} (${wd}), ${-n} days ago.${note}`)
      : n === 0
        ? zhOr(lang, `今天（${due}）到期。${note}`, `It is due today (${due}).${note}`)
        : zhOr(lang, `${due}（${wd}）到期，还有 ${n} 天。${note}`, `It is due ${due} (${wd}), in ${n} days.${note}`)
  }
  if (m.snoozeUntil !== null && m.snoozeUntil > today) {
    why += zhOr(lang, `你说了"明天再说"，${m.snoozeUntil} 会回到"要你处理"。`, ` You put it off; it comes back on ${m.snoozeUntil}.`)
  }
  const series = m.seriesId === null ? undefined : store.seriesById(m.seriesId)
  const next = series === undefined || series.repeat === 'none' ? undefined : occurrence(series, series.nextK)
  const fix = next !== undefined
    ? zhOr(lang, `办完后点"办完了"，这一期就关掉；下一期（${next} 到期）到时候会再出现。不用再提醒的话，在"我记着"里点"不再提醒"。`,
      `Once done, mark it done; this one closes and the next one (due ${next}) appears in time. To stop it for good, use "Stop" in "Keeping for you".`)
    : zhOr(lang, '办完后点"办完了"；不用再提醒的话点"忽略"。', 'Once done, mark it done; dismiss it if it no longer matters.')
  return { what, why, fix }
}
