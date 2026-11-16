/**
 * Notes: the recipe behind every promise the note tab makes.
 *
 * Three rules hold the whole thing up, and breaking any of them loses your
 * writing, so they are enforced here rather than in the page:
 *
 *   1. **Your words are never rewritten.** A model may add a title, points,
 *      to-dos and a date; it may not touch `text`. Nothing in this file
 *      writes `text` except you editing the note yourself.
 *   2. **`aiState` is the only truth about the AI half.** The `+AI` badge is
 *      on exactly when it is `done` — not when some field happens to be
 *      non-empty, which is what made an older build show a badge on a note
 *      whose result had been overtaken by an edit.
 *   3. **`rev` only goes up.** Saving names the `rev` you saw; if the note has
 *      moved on, the save is refused instead of quietly winning. That is the
 *      only reason two tabs can both be open.
 *
 * Saving is separate from organising on purpose: `captureNote` writes and
 * returns before anything slow is allowed to start. A note is never held
 * hostage by a model, a network call, or a queue.
 */

import { bi, MishuError, type Lang } from '../i18n.ts'
import { addSeries, resolveSeries, type SeriesInput } from '../manual.ts'
import { CATEGORIES, DEFAULT_LEAD_DAYS, type Category, type Repeat } from '../recur.ts'
import type { MishuStore, Note, NoteAiState, NoteStatus } from '../store.ts'
import { dayOf } from '../time.ts'
import {
  classifyByRule, detectDueHint, findSimilar, isNoteCategory, NOTE_CATEGORIES, resolveDueAt,
  type CategorySource, type DueHint, type NoteCategory, type ResolvedDue,
} from './rules.ts'

/** The longest note kept. Past this, capture stops and says so rather than truncating silently. */
export const MAX_NOTE_TEXT = 20_000
export const MAX_NOTE_TAGS = 16
/** How many notes one prompt may look at, so a big notebook cannot blow the context. */
const PROMPT_NEIGHBOURS = 6

export type { NoteCategory, CategorySource }

/** What a capture call may carry. Everything but `text` is optional. */
export interface CaptureInput {
  text: string
  /** Set only when you picked one yourself: it then outranks everything. */
  category?: string
  tags?: string[]
  /** Work out the AI half right away instead of leaving it for the queue. */
  organize?: boolean
}

export interface CaptureResult {
  note: Note
  /** The rule's verdict, when it had one. */
  rule: { category: NoteCategory; reason: string } | null
  /** A note that already says this, when there is one. Only ever a hint. */
  duplicate: { id: string; title: string; score: number } | null
  due: ResolvedDue | null
}

/**
 * Two letters of the local clock plus a short random tail. Sorting the ids
 * sorts the notes; the tail keeps two notes captured in the same second apart.
 */
export function newNoteId(now: number, random: () => number = Math.random): string {
  const date = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  const tail = Math.floor(random() * 0x10000).toString(16).padStart(4, '0')
  return `${stamp}-${tail}`
}

const oneLine = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Save a note. Returns as soon as it is on disk.
 *
 * The category follows a fixed order of authority: what you picked, then what
 * a rule recognised, then unsorted. A model is never asked here — capture has
 * to feel instant, and a model call in this path would put a spinner between
 * you and the save button.
 */
export function captureNote(store: MishuStore, input: CaptureInput, now: number, options: { llmReady?: boolean } = {}): CaptureResult {
  const text = String(input.text ?? '')
  if (text.trim() === '') throw new MishuError(bi('便签是空的', 'the note is empty'))
  if (text.length > MAX_NOTE_TEXT) {
    throw new MishuError(bi(`便签太长（上限 ${MAX_NOTE_TEXT} 字）`, `the note is too long (limit ${MAX_NOTE_TEXT} characters)`))
  }

  const rule = classifyByRule(text)
  const chosen = oneLine(input.category, 40)
  const categorySource: CategorySource = chosen !== '' ? 'user' : rule === null ? 'rule' : 'rule'
  const category = chosen !== '' ? chosen : rule?.category ?? '未分类'
  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map(tag => oneLine(tag, 24))
    .filter(tag => tag !== '')
    .slice(0, MAX_NOTE_TAGS)

  // Only a note that could be organised gets `pending`. Without a model, or
  // when the caller asked for a plain save, the note is complete as it is.
  const wanted = input.organize === true && options.llmReady === true
  const aiState: NoteAiState = wanted ? 'pending' : 'skipped'

  const dueHint = detectDueHint(text, now)
  const due = resolveDueAt(dueHint, now)

  const note = store.transaction(() => {
    const inserted = store.insertNote({
      id: newNoteId(now),
      rev: 1,
      text: text.trim(),
      category,
      categorySource,
      tags,
      aiState,
      aiTitle: null,
      aiPoints: [],
      aiTodos: [],
      aiDueHint: dueHint === null ? null : JSON.stringify(dueHint),
      aiPromptRev: 0,
      aiBasedOnRev: 0,
      dueDay: due?.day ?? null,
      seriesId: null,
      status: 'live',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }, now)
    store.log(now, 'note-capture', { id: inserted.id, category, source: categorySource, aiState })
    return inserted
  })

  const nearest = findSimilar(note, store.liveNotes(), { limit: 1, threshold: 0.55 })[0]
  return {
    note,
    rule,
    duplicate: nearest === undefined
      ? null
      : { id: nearest.note.id, title: nearest.note.text.split(/\r?\n/)[0]?.slice(0, 60) ?? '', score: Math.round(nearest.score * 100) / 100 },
    due,
  }
}

/** The title to show: the model's, else the first line of what you wrote. */
export function noteTitle(note: Note): string {
  if (note.aiTitle !== null && note.aiTitle.trim() !== '') return note.aiTitle.trim()
  const line = note.text.split(/\r?\n/).find(item => item.trim() !== '')
  return line === undefined ? '' : oneLine(line, 60)
}

export interface UpdateInput {
  /** The `rev` the page was showing; a stale one is refused, not applied. */
  rev?: number
  text?: string
  category?: string
  tags?: string[]
}

/**
 * Edit a note by hand.
 *
 * Changing the words makes the AI half describe something that is no longer
 * there, so it is kept but marked as based on an older version
 * (`aiBasedOnRev` falls behind `rev`) — the page shows "based on an earlier
 * version" rather than pretending it is current, and nothing is thrown away.
 */
export function updateNote(store: MishuStore, id: string, input: UpdateInput, now: number): Note {
  const current = store.noteById(id)
  if (current === undefined) throw new MishuError(bi(`没有这条便签：${id}`, `there is no note ${id}`))

  const patch: Parameters<MishuStore['updateNote']>[1] = {}
  if (input.text !== undefined) {
    const text = String(input.text)
    if (text.trim() === '') throw new MishuError(bi('便签是空的', 'the note is empty'))
    if (text.length > MAX_NOTE_TEXT) {
      throw new MishuError(bi(`便签太长（上限 ${MAX_NOTE_TEXT} 字）`, `the note is too long (limit ${MAX_NOTE_TEXT} characters)`))
    }
    if (text.trim() !== current.text) {
      patch.text = text.trim()
      const hint = detectDueHint(text, now)
      const due = resolveDueAt(hint, now)
      patch.aiDueHint = hint === null ? null : JSON.stringify(hint)
      patch.dueDay = due?.day ?? null
    }
  }
  if (input.category !== undefined) {
    const category = oneLine(input.category, 40)
    if (category === '') throw new MishuError(bi('类别不能为空', 'the category cannot be empty'))
    // Picked by hand: from here on neither a rule nor a model may change it.
    patch.category = category
    patch.categorySource = 'user'
  }
  if (input.tags !== undefined) {
    patch.tags = (Array.isArray(input.tags) ? input.tags : [])
      .map(tag => oneLine(tag, 24))
      .filter(tag => tag !== '')
      .slice(0, MAX_NOTE_TAGS)
  }

  const updated = store.transaction(() => {
    const next = store.updateNote(id, patch, now, input.rev)
    if (next === undefined) {
      throw new MishuError(bi('这条便签在别处改过了，刷新后重试', 'this note changed elsewhere; refresh and try again'))
    }
    store.log(now, 'note-update', { id, rev: next.rev, fields: Object.keys(patch) })
    return next
  })
  return updated
}

/** Take a note out of the list without deleting anything; `restore` brings it back. */
export function setNoteStatus(store: MishuStore, id: string, status: NoteStatus, now: number): Note {
  const current = store.noteById(id)
  if (current === undefined) throw new MishuError(bi(`没有这条便签：${id}`, `there is no note ${id}`))
  const updated = store.transaction(() => {
    const next = store.updateNote(id, { status, deletedAt: status === 'deleted' ? now : null }, now)
    store.log(now, `note-${status}`, { id })
    return next!
  })
  return updated
}

/** Gone for good. Only called from the trash. */
export function purgeNote(store: MishuStore, id: string, now: number): void {
  store.transaction(() => {
    store.deleteNotePermanently(id)
    store.log(now, 'note-purge', { id })
  })
}

// ── the AI half ─────────────────────────────────────────────

/**
 * Which prompt produced a result. Bump it whenever the wording changes, so an
 * old result can be told apart from a new one instead of the page silently
 * presenting a two-generation-old answer as current.
 */
export const NOTE_PROMPT_REV = 1

export interface OrganiseResult {
  title?: string
  category?: string
  points?: string[]
  todos?: string[]
  dueHint?: string | null
}

export interface NormalisedOrganise {
  title: string | null
  category: NoteCategory
  /** True when the model named a category outside the list; kept for the page to say so. */
  categoryOutOfSet: boolean
  points: string[]
  todos: string[]
  dueHint: string | null
}

/**
 * Accept whatever the model returned and make it safe to store.
 *
 * Anything out of range falls back rather than throwing: a model that answers
 * with a category nobody offered should not lose the four good points it did
 * return. `points` is capped and may be empty — an empty list is the correct
 * answer when there is nothing to add, and inventing one would be worse.
 */
export function normalizeOrganise(raw: unknown, note: Note): NormalisedOrganise {
  const value = (raw ?? {}) as Record<string, unknown>
  const list = (items: unknown, max: number): string[] => Array.isArray(items)
    ? items.map(item => oneLine(item, 200)).filter(item => item !== '').slice(0, max)
    : []
  const wanted = oneLine(value.category, 40)
  const allowed = new Set<string>(NOTE_CATEGORIES)
  const dueHint = typeof value.dueHint === 'string' && value.dueHint.trim() !== '' ? oneLine(value.dueHint, 40) : null
  return {
    title: value.title === undefined || value.title === null || oneLine(value.title, 60) === '' ? null : oneLine(value.title, 60),
    category: allowed.has(wanted) ? wanted as NoteCategory : note.category as NoteCategory,
    categoryOutOfSet: wanted !== '' && !allowed.has(wanted),
    points: list(value.points, 5),
    todos: list(value.todos, 8),
    dueHint,
  }
}

/**
 * Store an organising result.
 *
 * A note whose category you set yourself keeps it: `category_source = user`
 * outranks the model, which is the whole point of tracking the source. The
 * text is not touched. `rev` goes up, so a page holding the old one is told to
 * refresh rather than shown a mixture of both versions.
 */
export function applyOrganise(
  store: MishuStore,
  id: string,
  result: NormalisedOrganise,
  now: number,
  options: { promptRev?: number; model?: string } = {},
): Note {
  const current = store.noteById(id)
  if (current === undefined) throw new MishuError(bi(`没有这条便签：${id}`, `there is no note ${id}`))
  const keepCategory = current.categorySource === 'user'
  const patch: Parameters<MishuStore['updateNote']>[1] = {
    aiState: 'done',
    aiTitle: result.title,
    aiPoints: result.points,
    aiTodos: result.todos,
    aiPromptRev: options.promptRev ?? NOTE_PROMPT_REV,
    // The rev this write is about to produce: a fresh result describes *this*
    // version, and only a later edit makes it stale.
    aiBasedOnRev: current.rev + 1,
    ...keepCategory ? {} : { category: result.category, categorySource: 'model' as const },
  }
  if (result.dueHint !== null) patch.aiDueHint = JSON.stringify({ kind: 'raw', label: result.dueHint, raw: result.dueHint })
  return store.transaction(() => {
    const next = store.updateNote(id, patch, now)!
    store.log(now, 'note-organise', { id, rev: next.rev, model: options.model, promptRev: patch.aiPromptRev })
    return next
  })
}

/** Record that organising was tried and did not work, so the page can say why. */
export function markOrganiseFailed(store: MishuStore, id: string, now: number, why: string): void {
  store.transaction(() => {
    store.updateNote(id, { aiState: 'failed' }, now)
    store.log(now, 'note-organise-failed', { id, why })
  })
}

/** Notes waiting to be organised, oldest first — the queue's own view. */
export function pendingNotes(store: MishuStore, limit = 20): Note[] {
  return store.liveNotes(limit).filter(note => note.aiState === 'pending').reverse()
}

// ── a note becoming a reminder ──────────────────────────────

/**
 * Turn a note into a repeating thing the secretary remembers.
 *
 * It takes a deliberate call, never a side effect: a note that mentions a date
 * shows a button, and only pressing it creates a reminder. Guessing here would
 * put things on the to-do list you never asked for.
 */
export function noteToSeries(
  store: MishuStore,
  id: string,
  input: { due?: string; repeat?: Repeat; category?: Category; leadDays?: number },
  now: number,
  leadDefaults: Record<Category, number> = DEFAULT_LEAD_DAYS,
): { note: Note; seriesId: number; title: string } {
  const note = store.noteById(id)
  if (note === undefined) throw new MishuError(bi(`没有这条便签：${id}`, `there is no note ${id}`))
  if (note.seriesId !== null) throw new MishuError(bi('这条便签已经是提醒了', 'this note is already a reminder'))

  const due = input.due ?? note.dueDay ?? undefined
  if (due === undefined || due === '') {
    throw new MishuError(bi('这条便签没有能用的日期，先选一天', 'this note has no usable date; pick a day first'))
  }
  const title = noteTitle(note)
  const seriesInput: SeriesInput = {
    title: title === '' ? oneLine(note.text, 60) : title,
    due,
    repeat: input.repeat ?? 'none',
    category: input.category ?? guessCategory(note.category),
    leadDays: input.leadDays,
  }
  // Resolve first: the note carries a day, not a repeat rule, so the defaults
  // (every, lead days) still have to be filled in and checked.
  const resolved = resolveSeries({ ...seriesInput, note: note.text.slice(0, 200) }, leadDefaults)
  return store.transaction(() => {
    const series = addSeries(store, resolved, now)
    const updated = store.updateNote(id, { seriesId: series.id, dueDay: due }, now)!
    store.log(now, 'note-to-series', { id, seriesId: series.id, due })
    return { note: updated, seriesId: series.id, title: resolved.title }
  })
}

/** A note's free-form category onto the secretary's five, when it maps cleanly. */
function guessCategory(category: string): Category {
  if (isNoteCategory(category)) {
    if (category === '待办') return 'other'
    if (category === '生活') return 'other'
  }
  const direct = CATEGORIES.find(item => item === category)
  return direct ?? 'other'
}

// ── delivery ────────────────────────────────────────────────

/**
 * The text a note arrives as in a chat.
 *
 * It carries the short id, so an agent asked "save the conclusion back onto
 * this note" has something to call `mishu_note_update` with. The original
 * words are quoted, never paraphrased; the AI half follows as a separate list
 * so it can never be mistaken for what you wrote.
 */
export function renderNoteDelivery(note: Note, lang: Lang): string {
  const title = noteTitle(note)
  const stamp = new Date(note.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`
  const label = lang === 'zh' ? '随手贴' : 'Note'
  const lines: string[] = [`> **${title === '' ? (lang === 'zh' ? '（无标题）' : '(untitled)') : title}**　\`${label} · ${note.id} · ${when}\``, '>']
  for (const line of note.text.split(/\r?\n/)) lines.push(`> ${line}`)
  if (note.aiPoints.length > 0) {
    lines.push('', `${lang === 'zh' ? '- 要点' : '- Points'}：${note.aiPoints.join(lang === 'zh' ? '；' : '; ')}`)
  }
  if (note.aiTodos.length > 0) {
    lines.push(`${lang === 'zh' ? '- 待办' : '- To-do'}：${note.aiTodos.join(lang === 'zh' ? '；' : '; ')}`)
  }
  if (note.dueDay !== null) {
    lines.push(`${lang === 'zh' ? '- 日期' : '- Date'}：${note.dueDay}`)
  }
  if (note.seriesId !== null) {
    lines.push(lang === 'zh' ? `- 已设为提醒（交代 #${note.seriesId}）` : `- Already a reminder (series #${note.seriesId})`)
  }
  return lines.join('\n')
}

/** Record that a note went somewhere, for the card's "delivered" line. */
export function recordNoteSend(store: MishuStore, id: string, target: string, text: string | null, now: number): void {
  store.transaction(() => {
    store.insertNoteSend(id, now, target, text ?? '')
    store.log(now, 'note-send', { id, target })
  })
}

// ── export ──────────────────────────────────────────────────

/**
 * Every live note as one Markdown document: a heading, the original text, and
 * the AI half underneath. This is the escape hatch — the notebook itself stays
 * SQLite, but nothing in it is held hostage to that choice.
 */
export function exportNotesMarkdown(store: MishuStore, now: number, lang: Lang = 'zh'): string {
  const notes = store.notes({ limit: 10_000 })
  const say = (zh: string, en: string) => bi(zh, en)[lang]
  const head = [
    `# ${say('随手贴导出', 'Notes export')}`,
    '',
    `${dayOf(now)} · ${notes.length} ${say('条', 'notes')}`,
    '',
  ]
  const body = notes.map((note) => {
    const lines = [`## ${noteTitle(note) === '' ? note.id : noteTitle(note)}`, '', `<!-- id: ${note.id} · rev: ${note.rev} -->`, '']
    lines.push(note.text)
    if (note.tags.length > 0) lines.push('', `**${say('标签', 'Tags')}**：${note.tags.join('、')}`)
    lines.push('', `${say('类别', 'Category')}：${note.category} · ${say('AI', 'AI')}：${note.aiState}`)
    if (note.aiPoints.length > 0) lines.push('', `### ${say('要点', 'Points')}`, ...note.aiPoints.map(p => `- ${p}`))
    if (note.aiTodos.length > 0) lines.push('', `### ${say('待办', 'To-do')}`, ...note.aiTodos.map(t => `- ${t}`))
    return lines.join('\n')
  })
  return [...head, body.join('\n\n---\n\n')].join('\n')
}

// ── the page's view ─────────────────────────────────────────

/** A note as the page shows it: everything, plus the lines it needs. */
export interface NoteView {
  id: string
  rev: number
  text: string
  title: string
  category: string
  categorySource: CategorySource
  tags: string[]
  aiState: NoteAiState
  /** On exactly when `aiState === 'done'`. */
  aiBadge: boolean
  /** The AI half is older than the note: it described an earlier version. */
  aiStale: boolean
  aiPoints: string[]
  aiTodos: string[]
  aiDueHint: string | null
  dueDay: string | null
  seriesId: number | null
  status: NoteStatus
  createdAt: number
  updatedAt: number
  /** "刚刚" / "3 天前", written by the host so the page needs no clock. */
  when: string
  /** Where it has been delivered, newest first. */
  sends: Array<{ at: number; target: string }>
}

export function noteView(store: MishuStore, note: Note, now: number, lang: Lang): NoteView {
  return {
    id: note.id,
    rev: note.rev,
    text: note.text,
    title: noteTitle(note),
    category: note.category,
    categorySource: note.categorySource,
    tags: note.tags,
    aiState: note.aiState,
    aiBadge: note.aiState === 'done',
    aiStale: note.aiState === 'done' && note.aiBasedOnRev < note.rev,
    aiPoints: note.aiPoints,
    aiTodos: note.aiTodos,
    aiDueHint: parseHintLabel(note.aiDueHint),
    dueDay: note.dueDay,
    seriesId: note.seriesId,
    status: note.status,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    when: relativeFromNow(note.updatedAt, now, lang),
    sends: store.noteSends(note.id).map(send => ({ at: send.at, target: send.target })),
  }
}

function parseHintLabel(stored: string | null): string | null {
  if (stored === null || stored === '') return null
  try {
    const parsed = JSON.parse(stored) as DueHint
    return typeof parsed.label === 'string' ? parsed.label : null
  } catch {
    return null
  }
}

function relativeFromNow(at: number, now: number, lang: Lang): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return lang === 'zh' ? '刚刚' : 'just now'
  if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟前` : `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return lang === 'zh' ? `${days} 天前` : `${days} d ago`
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
