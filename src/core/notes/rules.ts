/**
 * What a note can be worked out without a model: its category, its
 * resemblance to another note, and any date it mentions.
 *
 * Ported from dsh-stickynote's `lib/rules.js`, which was written against the
 * same three questions. Three things are kept exactly as they were, because
 * each one fixed a real bug:
 *
 *   1. **Rules run before the model, and may only abstain.** A rule that
 *      cannot place a note says so; it never guesses. Being unclassified is a
 *      normal state, not an error.
 *   2. **One similarity score serves every caller.** Duplicate hints, delivery
 *      candidates and related notes all read `similarity()`, so the page can
 *      never say "this is new" while the hint says "you already wrote this".
 *   3. **A date is detected, then resolved — never guessed.** `detectDueHint`
 *      only says roughly what was said; `resolveDueAt` turns that into a real
 *      day and returns null when it cannot. A reminder that fires on the wrong
 *      day is worse than one that was never made, so "someday" and "when I get
 *      a chance" deliberately resolve to nothing.
 */

import type { Lang } from '../i18n.ts'
import { addDays, addMonths, dayOf, dayStart, parseDay, relativeDay, weekday } from '../time.ts'

// ── categories ──────────────────────────────────────────────

/** The categories a note may have. The model is only ever offered these. */
export const NOTE_CATEGORIES = ['工作', '想法', '待办', '参考', '生活', '未分类'] as const
export type NoteCategory = typeof NOTE_CATEGORIES[number]

export const NOTE_CATEGORY_LABELS: Record<NoteCategory, { zh: string; en: string }> = {
  工作: { zh: '工作', en: 'Work' },
  想法: { zh: '想法', en: 'Idea' },
  待办: { zh: '待办', en: 'To-do' },
  参考: { zh: '参考', en: 'Reference' },
  生活: { zh: '生活', en: 'Life' },
  未分类: { zh: '未分类', en: 'Unsorted' },
}

/** Where a note's category came from. Once it is `user`, nothing may overwrite it. */
export type CategorySource = 'rule' | 'model' | 'user'

export function categoryLabel(category: string, lang: Lang): string {
  const known = NOTE_CATEGORY_LABELS[category as NoteCategory]
  return known === undefined ? category : known[lang]
}

export function isNoteCategory(value: string): value is NoteCategory {
  return (NOTE_CATEGORIES as readonly string[]).includes(value)
}

// ── rule classification ─────────────────────────────────────

/**
 * Domains that put a note in a category on sight.
 *
 * Only names where the domain alone settles it. Long distinctive words match
 * bare (people type "github" without the suffix); short everyday words need a
 * dot and a suffix, or "docs" and "api" would fire on ordinary prose.
 */
const DOMAIN_RULES: ReadonlyArray<{ category: NoteCategory; test: RegExp }> = [
  { category: '参考', test: /(?:github|gitlab|gitee|bitbucket|stackoverflow|stackexchange|segmentfault)\b/i },
  { category: '参考', test: /(?:arxiv|springer)\b/i },
  { category: '想法', test: /(?:twitter|weibo|mastodon|threads)\b/i },
  { category: '待办', test: /(?:linear|jira|trello|asana|notion)\b/i },
  { category: '参考', test: /(?:^|\/\/|[.\s])(?:docs|developer|dev|api)\.[a-z0-9-]+\.(?:com|io|org)\b/i },
  { category: '想法', test: /(?:^|\/\/|[.\s])x\.(?:com|social|app)\b/i },
]

/** Words that settle the category. Ordered: the more specific ones come first. */
const KEYWORD_RULES: ReadonlyArray<{ category: NoteCategory; test: RegExp }> = [
  { category: '待办', test: /(?:待办|TODO|to-?do|记得|别忘了|要做|待办事项|ddl|deadline|截止)/i },
  { category: '参考', test: /(?:参考|文档|链接|文章|paper|论文|教程|手册|spec|规范)/i },
  { category: '想法', test: /(?:想法|灵感|点子|idea|也许|或许|要不要|是不是该|如果|假如)/i },
  { category: '工作', test: /(?:需求|上线|发布|部署|接口|重构|排查|bug|修复|评审|排期|会议|客户)/i },
  { category: '生活', test: /(?:买|吃|做菜|菜谱|旅行|旅游|体检|挂号|快递|缴费|物业|房租|心情|照片|拍照|vlog|视频|日记|打卡|记录生活)/i },
]

export interface RuleVerdict {
  category: NoteCategory
  /** Why, for the "why is it here" line: `domain:github`, `keyword:房租`, … */
  reason: string
}

/**
 * Place a note by rule. `null` means "no rule knows", which is where the
 * model may be asked — never a fallback category, because a wrong category is
 * worse than an empty one.
 */
export function classifyByRule(text: string): RuleVerdict | null {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  for (const rule of DOMAIN_RULES) {
    const match = raw.match(rule.test)
    if (match !== null) return { category: rule.category, reason: `domain:${match[0].replace(/^\/+/, '')}` }
  }
  for (const rule of KEYWORD_RULES) {
    const match = raw.match(rule.test)
    if (match !== null) return { category: rule.category, reason: `keyword:${match[0]}` }
  }
  return null
}

// ── tokens and similarity ───────────────────────────────────

/** Words that appear in nearly every note and so tell two notes apart from nothing. */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '就', '也', '都', '而', '及', '与', '着', '或',
  '一个', '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '因为', '所以',
  '但是', '如果', '可以', '应该', '需要', '没有', '不是', '就是', '还是', '这样',
  '那样', '一下', '现在', '然后', '而且', '并且', '不过', '只是', '已经',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or',
  'in', 'on', 'at', 'for', 'with', 'this', 'that', 'it', 'as', 'by', 'from',
])

/**
 * Features for the similarity score: English words, and 2-grams of each run of
 * Chinese. This is not real tokenising — it is feature extraction, and 2-grams
 * are enough for short notes without carrying a dictionary.
 */
export function tokenize(text: string): Set<string> {
  const raw = String(text ?? '').toLowerCase()
  const tokens = new Set<string>()
  for (const word of raw.match(/[a-z][a-z0-9_+#.-]{1,}/g) ?? []) {
    if (word.length >= 2 && !STOPWORDS.has(word)) tokens.add(word)
  }
  for (const run of raw.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) tokens.add(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) tokens.add(gram)
    }
  }
  return tokens
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const item of small) if (large.has(item)) shared += 1
  return shared
}

/** Symmetric overlap of two token sets. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const shared = sharedCount(a, b)
  return shared / (a.size + b.size - shared)
}

/** Share of the *shorter* note that the other covers. */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  return sharedCount(a, b) / Math.min(a.size, b.size)
}

/**
 * Body similarity: the larger of the two measures.
 *
 * Jaccard alone misses the common Chinese case where one note is a shortened
 * restatement of another — the short one is a subset, so the extra grams of
 * the long one inflate the denominator ("登录流程要拆成两步" vs
 * "登录流程拆两步" scores 0.29). The overlap coefficient handles containment
 * (0.67) but flatters two long notes with one shared paragraph. Taking the
 * maximum covers both; taking the mean would do badly on both.
 */
export function bodyScore(a: Set<string>, b: Set<string>): number {
  return Math.max(jaccard(a, b), overlapCoefficient(a, b))
}

/** What the similarity score reads. Only these fields matter. */
export interface SimilarityInput {
  id: string
  text: string
  tags: readonly string[]
  category: string
  createdAt: number
}

const DAY_MS = 86_400_000

/**
 * How much two notes are about the same thing, 0–1.
 *
 * Four signals: shared tags (×3, the most trustworthy because you wrote them),
 * body similarity (×7), same category (+1, weak), written within a week (+1).
 *
 * The denominator is **the weight of the signals that were actually
 * comparable**, not a fixed 12. This matters at capture time: a brand-new note
 * has no tags and no category yet, so with a fixed denominator an identical
 * earlier note could score at most 8/12 = 0.67 and the 0.55 threshold would
 * demand 0.80 body similarity — a structural failure to notice real duplicates.
 */
export function similarity(a: SimilarityInput, b: SimilarityInput): number {
  if (a.id === b.id) return 0
  let score = 0
  let applicable = 0

  const tagsA = new Set(a.tags)
  const tagsB = new Set(b.tags)
  if (tagsA.size > 0 && tagsB.size > 0) {
    applicable += 3
    let shared = 0
    for (const tag of tagsA) if (tagsB.has(tag)) shared += 1
    score += Math.min(1, shared / Math.min(tagsA.size, tagsB.size)) * 3
  }

  applicable += 7
  score += bodyScore(tokenize(a.text), tokenize(b.text)) * 7

  const categorized = (note: SimilarityInput) => note.category !== '' && note.category !== '未分类' && note.category !== 'Unsorted'
  if (categorized(a) && categorized(b)) {
    applicable += 1
    if (a.category === b.category) score += 1
  }

  applicable += 1
  if (Math.abs(a.createdAt - b.createdAt) <= 7 * DAY_MS) score += 1

  return applicable === 0 ? 0 : Math.max(0, Math.min(1, score / applicable))
}

/**
 * The closest notes to `target`, best first.
 *
 * Thresholds live with the caller: 0.55 for "you already wrote this" (better
 * to miss than to nag) and 0.25 for "maybe related" (better to list too many,
 * you pick). Both read the same score, which is what keeps them consistent.
 */
export function findSimilar(
  target: SimilarityInput,
  pool: readonly SimilarityInput[],
  options: { limit?: number; threshold?: number } = {},
): Array<{ note: SimilarityInput; score: number }> {
  const limit = options.limit !== undefined && options.limit > 0 ? options.limit : 3
  const threshold = options.threshold ?? 0.25
  const hits: Array<{ note: SimilarityInput; score: number }> = []
  for (const note of pool) {
    if (note.id === target.id) continue
    const score = similarity(target, note)
    if (score >= threshold) hits.push({ note, score })
  }
  hits.sort((x, y) => y.score - x.score)
  return hits.slice(0, limit)
}

/** Two thresholds, named where they are used. */
export const DUPLICATE_THRESHOLD = 0.55
export const RELATED_THRESHOLD = 0.25

// ── dates ───────────────────────────────────────────────────

const DAY_WORDS: ReadonlyArray<{ test: RegExp; offset: number }> = [
  { test: /前天/, offset: -2 },
  { test: /昨天|昨日/, offset: -1 },
  { test: /今天|今日|今晚|今早/, offset: 0 },
  { test: /明天|明日|明早|明晚/, offset: 1 },
  { test: /后天/, offset: 2 },
  { test: /大后天/, offset: 3 },
]

const TIME_WORDS = /(早上|上午|中午|下午|傍晚|晚上|夜里|凌晨)/

/** What a note seems to say about when. `raw` means "a time word, no date". */
export type DueHint =
  | { kind: 'date'; day: string; label: string; raw: string }
  | { kind: 'day'; offset: number; label: string; raw: string }
  | { kind: 'week'; weekOffset: number; weekday: string; label: string; raw: string }
  | { kind: 'month'; which: '月底' | '月末' | '月初' | '月中'; monthOffset: number; label: string; raw: string }
  | { kind: 'raw'; label: string; raw: string }

const CN_WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

/**
 * Read what a note says about a day, without committing to one.
 *
 * Deliberately coarse: an absolute `YYYY-MM-DD`, an offset in days, a weekday,
 * a part of a month, or nothing. Turning that into a date is `resolveDueAt`'s
 * job, so "which day is it" is decided in exactly one place.
 */
export function detectDueHint(text: string, now: number = Date.now()): DueHint | null {
  const raw = String(text ?? '').trim()
  if (raw === '') return null

  const iso = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (iso !== null) {
    const day = `${iso[1]}-${pad(iso[2]!)}-${pad(iso[3]!)}`
    if (parseDay(day) !== undefined) return { kind: 'date', day, label: day, raw: iso[0] }
  }

  const cn = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
  if (cn !== null) {
    const [year, month, day] = [new Date(now).getFullYear(), Number(cn[1]), Number(cn[2])]
    const candidate = `${year}-${pad(month)}-${pad(day)}`
    if (parseDay(candidate) !== undefined) {
      // "3月10日" said in December means next year, not ten months ago.
      const shifted = `${year + 1}-${pad(month)}-${pad(day)}`
      const day_ = dayStart(candidate) < dayStart(dayOf(now)) && parseDay(shifted) !== undefined ? shifted : candidate
      return { kind: 'date', day: day_, label: `${cn[0]}`, raw: cn[0] }
    }
  }

  for (const word of DAY_WORDS) {
    const match = raw.match(word.test)
    if (match !== null) {
      const time = raw.match(TIME_WORDS)
      const label = match[0] + (time === null ? '' : time[1])
      return { kind: 'day', offset: word.offset, label, raw: label }
    }
  }

  const week = raw.match(/(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/)
  if (week !== null) {
    return {
      kind: 'week',
      weekOffset: week[1] === '下下' ? 2 : week[1] === '下' ? 1 : 0,
      weekday: week[2]!,
      label: week[0].trim(),
      raw: week[0].trim(),
    }
  }

  const month = raw.match(/(这个?月|下个?月)?\s*(月底|月末|月初|月中)/)
  if (month !== null) {
    return {
      kind: 'month',
      which: month[2] as '月底' | '月末' | '月初' | '月中',
      monthOffset: month[1] !== undefined && month[1].startsWith('下') ? 1 : 0,
      label: month[0].trim(),
      raw: month[0].trim(),
    }
  }

  const vague = raw.match(/(过几[天日]|有空|改天|回头|之后|以后|尽快|马上|稍后)/)
  if (vague !== null) return { kind: 'raw', label: vague[0], raw: vague[0] }

  return null
}

export interface ResolvedDue {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  /** What to call it on screen: "明天", "下周三", "2027-03-10". */
  label: string
}

/**
 * Turn a hint into the day a reminder would fall on, or null.
 *
 * The rule is **rather no answer than a wrong one**: "有空""改天""尽快"
 * return null on purpose, because a reminder on an invented day is worse than
 * no reminder at all. A day already past returns null too — the moment to be
 * reminded about it has gone.
 */
export function resolveDueAt(hint: DueHint | null, now: number = Date.now()): ResolvedDue | null {
  if (hint === null) return null
  const today = dayOf(now)
  const lang: Lang = 'zh'

  if (hint.kind === 'date') {
    if (dayStart(hint.day) < dayStart(today)) return null
    return { day: hint.day, label: hint.label }
  }

  if (hint.kind === 'day') {
    const day = addDays(today, hint.offset)
    if (dayStart(day) < dayStart(today)) return null
    return { day, label: hint.label }
  }

  if (hint.kind === 'week') {
    const target = CN_WEEKDAY[hint.weekday] ?? Number(hint.weekday)
    if (!Number.isInteger(target) || target < 1 || target > 7) return null
    const currentIndex = CN_WEEKDAY[weekday(today, 'zh').slice(1)] ?? 0
    let delta = target - currentIndex + hint.weekOffset * 7
    // "周三" said on a Thursday means next Wednesday, not six days ago.
    if (hint.weekOffset === 0 && delta <= 0) delta += 7
    const day = addDays(today, delta)
    if (dayStart(day) < dayStart(today)) return null
    return { day, label: hint.label }
  }

  if (hint.kind === 'month') {
    // "月初" said on the 15th means next month's start, the same way "3月10日"
    // said in December means next year. Past of this month is never offered.
    const build = (offset: number): string => {
      const shifted = addMonths(today, offset)
      const year = Number(shifted.slice(0, 4))
      const month = Number(shifted.slice(5, 7))
      const last = Number(addDays(addMonths(`${year}-${pad(month)}-01`, 1), -1).slice(8, 10))
      const dayNumber = hint.which === '月初' ? 1 : hint.which === '月中' ? 15 : last
      return `${year}-${pad(month)}-${pad(dayNumber)}`
    }
    const first = build(hint.monthOffset)
    if (dayStart(first) >= dayStart(today)) return { day: first, label: hint.label }
    if (hint.monthOffset !== 0) return null
    const rolled = build(1)
    if (dayStart(rolled) < dayStart(today)) return null
    return { day: rolled, label: hint.label }
  }

  // 'raw': a time word and nothing to pin it to.
  return null
}

/** The one-line description of when, for a card: "2026-12-10（周三） · 还有 18 天". */
export function describeDue(due: ResolvedDue, now: number, lang: Lang): string {
  return `${due.day}（${weekday(due.day, lang)}）· ${relativeDay(due.day, dayOf(now), lang)}`
}

function pad(value: number | string): string {
  return String(value).padStart(2, '0')
}
