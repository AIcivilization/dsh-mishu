import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyOrganise, captureNote, exportNotesMarkdown, MAX_NOTE_TEXT, markOrganiseFailed, newNoteId,
  normalizeOrganise, noteTitle, noteToSeries, noteView, pendingNotes, purgeNote, recordNoteSend,
  renderNoteDelivery, setNoteStatus, updateNote,
} from '../src/core/notes/note.ts'
import {
  classifyByRule, detectDueHint, findSimilar, NOTE_CATEGORIES, resolveDueAt, similarity,
} from '../src/core/notes/rules.ts'
import { MishuStore } from '../src/core/store.ts'
import { DEFAULT_LEAD_DAYS } from '../src/core/recur.ts'
import { at } from './helpers.ts'


const store = () => MishuStore.open(':memory:')

// ── capture ─────────────────────────────────────────────────

test('a note is saved before anything slow: capture returns the stored note with rev 1', () => {
  const db = store()
  const result = captureNote(db, { text: '明天给客户发报价单' }, at('2026-11-15'))
  assert.equal(result.note.rev, 1)
  assert.equal(result.note.status, 'live')
  assert.equal(result.note.text, '明天给客户发报价单', 'the words are stored exactly as written')
  assert.equal(result.note.createdAt, at('2026-11-15'))
  assert.equal(db.notes().length, 1, 'and it is on disk when capture returns')
})

test('nothing on a capture path may need a model: a plain save is complete', () => {
  const db = store()
  const result = captureNote(db, { text: '记一条' }, at('2026-11-15'))
  assert.equal(result.note.aiState, 'skipped', 'no model asked for: skipped, not pending')
  assert.equal(result.note.aiTitle, null)
})

test('asking for organising without a model still saves, and does not leave a pending note', () => {
  const db = store()
  const result = captureNote(db, { text: '整理一下这条' }, at('2026-11-15'), { llmReady: false })
  assert.equal(result.note.aiState, 'skipped', 'a note that can never be organised must not sit at pending')
})

test('capturing with a model ready marks it pending, and nothing else changes', () => {
  const db = store()
  const result = captureNote(db, { text: '整理一下这条', organize: true }, at('2026-11-15'), { llmReady: true })
  assert.equal(result.note.aiState, 'pending')
  assert.equal(result.note.text, '整理一下这条')
})

test('a category the user picks outranks the rule, and says so', () => {
  const db = store()
  const result = captureNote(db, { text: '房租 下个月交', category: '生活' }, at('2026-11-15'))
  assert.equal(result.note.category, '生活')
  assert.equal(result.note.categorySource, 'user')
})

test('a rule places what it can without being asked, and abstains otherwise', () => {
  const db = store()
  assert.equal(captureNote(db, { text: '交房租' }, at('2026-11-15')).note.category, '生活')
  const vague = captureNote(db, { text: '嗯' }, at('2026-11-15'))
  assert.equal(vague.note.category, '未分类', 'no rule knows: unsorted, not a guess')
  assert.equal(vague.rule, null)
})

test('an empty note is refused rather than saved', () => {
  const db = store()
  assert.throws(() => captureNote(db, { text: '   ' }, at('2026-11-15')), /the note is empty/)
  assert.equal(db.notes().length, 0)
})

test('an over-long note is refused, not silently truncated', () => {
  const db = store()
  const long = 'a'.repeat(MAX_NOTE_TEXT + 1)
  assert.throws(() => captureNote(db, { text: long }, at('2026-11-15')), /too long/)
  assert.equal(captureNote(db, { text: 'a'.repeat(MAX_NOTE_TEXT) }, at('2026-11-15')).note.text.length, MAX_NOTE_TEXT)
})

test('a duplicate is reported but never merged', () => {
  const db = store()
  const first = captureNote(db, { text: '登录流程要拆成两步' }, at('2026-11-15'))
  const second = captureNote(db, { text: '登录流程要拆成两步' }, at('2026-11-15'))
  assert.notEqual(first.note.id, second.note.id, 'both notes exist')
  assert.equal(second.duplicate?.id, first.note.id)
  assert.equal(db.notes().length, 2, 'nothing was merged away')
})

test('two notes captured in the same second still get different ids', () => {
  const now = at('2026-11-15')
  const ids = new Set([
    newNoteId(now, () => 0.1), newNoteId(now, () => 0.9), newNoteId(now),
  ])
  assert.equal(ids.size, 3)
  assert.match(newNoteId(now, () => 0.5), /^2026-11-15T09-00-00-[0-9a-f]{4}$/)
})

// ── editing ─────────────────────────────────────────────────

test('editing the words bumps rev and marks the AI half as describing an older version', () => {
  const db = store()
  const captured = captureNote(db, { text: '第一版' }, at('2026-11-15'), { llmReady: true })
  const organised = applyOrganise(db, captured.note.id, { title: '标题', category: '想法', points: ['要点'], todos: [], dueHint: null, categoryOutOfSet: false }, at('2026-11-15'))
  assert.equal(organised.aiBasedOnRev, organised.rev, 'fresh result matches this version')
  assert.equal(noteView(db, organised, at('2026-11-15'), 'zh').aiStale, false)

  const edited = updateNote(db, captured.note.id, { rev: organised.rev, text: '第二版' }, at('2026-11-16'))
  assert.equal(edited.rev, organised.rev + 1)
  assert.equal(edited.text, '第二版')
  assert.equal(edited.aiPoints[0], '要点', 'the old result is kept, not thrown away')
  const view = noteView(db, edited, at('2026-11-16'), 'zh')
  assert.equal(view.aiStale, true, 'the page can say it described an earlier version')
})

test('a save against a stale rev is refused instead of overwriting the newer one', () => {
  const db = store()
  const note = captureNote(db, { text: '原文' }, at('2026-11-15')).note
  updateNote(db, note.id, { rev: note.rev, text: '甲改的' }, at('2026-11-15'))
  assert.throws(() => updateNote(db, note.id, { rev: note.rev, text: '乙改的' }, at('2026-11-15')), /changed elsewhere/)
  assert.equal(db.noteById(note.id)!.text, '甲改的', 'the first write stands')
})

test('a category picked by hand is never overridden by the model afterwards', () => {
  const db = store()
  const note = captureNote(db, { text: '接口要重构' }, at('2026-11-15'), { llmReady: true }).note
  const picked = updateNote(db, note.id, { rev: note.rev, category: '参考' }, at('2026-11-15'))
  assert.equal(picked.categorySource, 'user')

  const organised = applyOrganise(db, note.id, { title: null, category: '工作', points: [], todos: [], dueHint: null, categoryOutOfSet: false }, at('2026-11-15'))
  assert.equal(organised.category, '参考', 'your choice wins')
  assert.equal(organised.categorySource, 'user')
  assert.equal(organised.aiState, 'done', 'but the rest of the result is kept')
})

test('a category the model invents falls back instead of being stored', () => {
  const db = store()
  const note = captureNote(db, { text: '随便一句话' }, at('2026-11-15'), { llmReady: true }).note
  const result = normalizeOrganise({ title: '标题', category: '玄学', points: ['一', '二'], todos: [] }, note)
  assert.equal(result.categoryOutOfSet, true)
  assert.equal(result.category, note.category, 'kept what the note had')
  assert.deepEqual(result.points, ['一', '二'], 'the rest of the answer survives')
  assert.ok(NOTE_CATEGORIES.includes(result.category))
})

test('organise results are capped and never invent points', () => {
  const db = store()
  const note = captureNote(db, { text: '一句话' }, at('2026-11-15'), { llmReady: true }).note
  const result = normalizeOrganise({ points: Array.from({ length: 20 }, (_, i) => `p${i}`), todos: [] }, note)
  assert.equal(result.points.length, 5)
  assert.deepEqual(normalizeOrganise({}, note).points, [])
})

test('a failed organise is recorded so the page can say why', () => {
  const db = store()
  const note = captureNote(db, { text: '一句话', organize: true }, at('2026-11-15'), { llmReady: true }).note
  assert.equal(pendingNotes(db).length, 1)
  markOrganiseFailed(db, note.id, at('2026-11-15'), 'no-model')
  assert.equal(db.noteById(note.id)!.aiState, 'failed')
  assert.equal(pendingNotes(db).length, 0, 'a failed note leaves the queue instead of looping')
})

// ── trash and archive ───────────────────────────────────────

test('delete is a soft delete; restore brings it back; purge is only for the trash', () => {
  const db = store()
  const note = captureNote(db, { text: '待删' }, at('2026-11-15')).note
  setNoteStatus(db, note.id, 'deleted', at('2026-11-15'))
  assert.equal(db.notes().length, 0, 'gone from the list')
  assert.equal(db.notes({ trash: true }).length, 1, 'but still there in the trash')
  setNoteStatus(db, note.id, 'live', at('2026-11-15'))
  assert.equal(db.notes().length, 1)
  setNoteStatus(db, note.id, 'deleted', at('2026-11-15'))
  purgeNote(db, note.id, at('2026-11-15'))
  assert.equal(db.notes({ trash: true }).length, 0)
})

test('archive and trash are independent dimensions', () => {
  const db = store()
  const note = captureNote(db, { text: '归档的' }, at('2026-11-15')).note
  setNoteStatus(db, note.id, 'archived', at('2026-11-15'))
  assert.deepEqual(db.noteCounts(), { live: 0, archived: 1, deleted: 0 })
  assert.equal(db.notes({ archived: true }).length, 1)
})

// ── search ──────────────────────────────────────────────────

test('search finds Chinese words anywhere in the note, not just at the start', () => {
  const db = store()
  captureNote(db, { text: '护照 2027 年 3 月 10 日到期，记得提前办' }, at('2026-11-15'))
  assert.equal(db.searchNotes('护照').length, 1)
  assert.equal(db.searchNotes('到期').length, 1, 'FTS5 would miss this: a whole Chinese sentence is one token')
  assert.equal(db.searchNotes('不存在').length, 0)
})

test('search treats % and _ as characters, not wildcards', () => {
  const db = store()
  captureNote(db, { text: '折扣 50% 起' }, at('2026-11-15'))
  captureNote(db, { text: '完全无关的一条' }, at('2026-11-15'))
  assert.equal(db.searchNotes('50%').length, 1)
  assert.equal(db.searchNotes('%').length, 1, 'the % only matches the note that has one')
})

test('search can see the trash when asked', () => {
  const db = store()
  const note = captureNote(db, { text: '删掉的' }, at('2026-11-15')).note
  setNoteStatus(db, note.id, 'deleted', at('2026-11-15'))
  assert.equal(db.searchNotes('删掉的').length, 0)
  assert.equal(db.searchNotes('删掉的', { includeDeleted: true }).length, 1)
})

// ── rules ───────────────────────────────────────────────────

test('rule classification never guesses', () => {
  assert.equal(classifyByRule('看这个 https://github.com/x/y 的 issue')?.category, '参考')
  assert.equal(classifyByRule('明天要交房租')?.category, '生活')
  assert.equal(classifyByRule('嗯') === null, true)
  assert.equal(classifyByRule('') === null, true)
})

test('similarity is one score: the same pair always ranks the same', () => {
  const a = { id: 'a', text: '登录流程要拆成两步', tags: [], category: '工作', createdAt: at('2026-11-15') }
  const b = { id: 'b', text: '登录流程拆两步', tags: [], category: '工作', createdAt: at('2026-11-15') }
  const score = similarity(a, b)
  assert.ok(score > 0.55, `a shortened restatement should clear the duplicate threshold, got ${score}`)
  assert.equal(similarity(a, b), similarity(b, a), 'symmetric')
})

test('an untrimmed note can still be recognised as a duplicate of an identical one', () => {
  // Both have no tags and no category yet — the case the fixed-denominator bug missed.
  const fresh = { id: 'a', text: '周五前把报价单发给客户', tags: [], category: '未分类', createdAt: at('2026-11-15') }
  const older = { id: 'b', text: '周五前把报价单发给客户', tags: [], category: '未分类', createdAt: at('2026-11-15') }
  assert.ok(similarity(fresh, older) > 0.9)
})

test('findSimilar excludes the note itself and ranks best first', () => {
  const target = { id: 'a', text: '护照到期换新', tags: [], category: '未分类', createdAt: at('2026-11-15') }
  const pool = [
    target,
    { id: 'b', text: '护照到期换新', tags: [], category: '未分类', createdAt: at('2026-11-15') },
    { id: 'c', text: '完全不同的内容', tags: [], category: '未分类', createdAt: at('2026-11-15') },
  ]
  const hits = findSimilar(target, pool, { limit: 3, threshold: 0.25 })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0]!.note.id, 'b')
  assert.equal(hits.some(hit => hit.note.id === 'a'), false, 'never matches itself')
})

// ── dates ───────────────────────────────────────────────────

test('a written date that has not passed resolves to that day', () => {
  assert.deepEqual(resolveDueAt(detectDueHint('2027-03-10 到期')), { day: '2027-03-10', label: '2027-03-10' })
})

test('a month-and-day that has passed this year means next year', () => {
  const resolved = resolveDueAt(detectDueHint('3月10日交材料'), at('2026-11-15'))
  assert.equal(resolved?.day, '2027-03-10')
})

test('relative days resolve against today', () => {
  assert.equal(resolveDueAt(detectDueHint('明天交'), at('2026-11-15'))?.day, '2026-11-16')
  assert.equal(resolveDueAt(detectDueHint('后天交'), at('2026-11-15'))?.day, '2026-11-17')
})

test('a weekday already gone this week means next week', () => {
  // 2026-11-15 is a Sunday, the last day of the Mon–Sun week that began 11-09.
  // "周三" alone is the coming Wednesday (11-18); "下周三" is also 11-18, because
  // next week starts 11-16. Saying them on a Monday instead must differ.
  assert.equal(resolveDueAt(detectDueHint('周三开会'), at('2026-11-15'))?.day, '2026-11-18')
  assert.equal(resolveDueAt(detectDueHint('下周三开会'), at('2026-11-15'))?.day, '2026-11-18')
  assert.equal(resolveDueAt(detectDueHint('周三开会'), at('2026-11-16'))?.day, '2026-11-18', 'said on Monday, this Wednesday')
  assert.equal(resolveDueAt(detectDueHint('下周三开会'), at('2026-11-16'))?.day, '2026-11-25', 'said on Monday, next Wednesday')
})

test('month ends and month starts resolve to the real calendar days', () => {
  assert.equal(resolveDueAt(detectDueHint('月底前报销'), at('2026-11-15'))?.day, '2026-11-30')
  // 月初 has already gone on the 15th, so it means the next month rather than a
  // reminder that could never fire.
  assert.equal(resolveDueAt(detectDueHint('月初交表'), at('2026-11-15'))?.day, '2026-12-01')
  assert.equal(resolveDueAt(detectDueHint('下个月初交表'), at('2026-11-15'))?.day, '2026-12-01')
})

test('a vague time word resolves to nothing rather than an invented day', () => {
  for (const text of ['有空再说', '改天吧', '尽快处理', '过几天']) {
    const hint = detectDueHint(text)
    assert.notEqual(hint, null, `${text} does have a time word`)
    assert.equal(resolveDueAt(hint, at('2026-11-15')), null, `${text} must not become a day`)
  }
})

test('a date already in the past does not become a reminder', () => {
  assert.equal(resolveDueAt(detectDueHint('2020-01-01 到期'), at('2026-11-15')), null)
})

// ── a note becoming a reminder ──────────────────────────────

test('a note becomes a reminder only when asked, and links both ways', () => {
  const db = store()
  const note = captureNote(db, { text: '护照 2027-03-10 到期' }, at('2026-11-15')).note
  assert.equal(note.seriesId, null, 'capturing alone creates no reminder')

  const result = noteToSeries(db, note.id, {}, at('2026-11-15'))
  assert.equal(db.noteById(note.id)!.seriesId, result.seriesId)
  assert.equal(db.seriesById(result.seriesId)!.firstDue, '2027-03-10')
  assert.equal(db.seriesById(result.seriesId)!.leadDays, DEFAULT_LEAD_DAYS.other,
    'a note does not claim to be a document: the model may place it, a note may not guess')
})

test('a note cannot become two reminders', () => {
  const db = store()
  const note = captureNote(db, { text: '2027-03-10 到期' }, at('2026-11-15')).note
  noteToSeries(db, note.id, {}, at('2026-11-15'))
  assert.throws(() => noteToSeries(db, note.id, {}, at('2026-11-15')), /already a reminder/)
})

test('a note with no date asks for one instead of making something up', () => {
  const db = store()
  const note = captureNote(db, { text: '随便记一句' }, at('2026-11-15')).note
  assert.throws(() => noteToSeries(db, note.id, {}, at('2026-11-15')), /no usable date/)
  // Given a day, it works.
  assert.ok(noteToSeries(db, note.id, { due: '2027-01-01' }, at('2026-11-15')).seriesId > 0)
})

// ── delivery ────────────────────────────────────────────────

test('the delivery block carries the id so an agent can find the note again', () => {
  const db = store()
  const note = captureNote(db, { text: '第一行\n第二行' }, at('2026-11-15')).note
  const text = renderNoteDelivery(note, 'zh')
  assert.match(text, new RegExp(note.id))
  assert.match(text, /> 第一行/)
  assert.match(text, /> 第二行/)
})

test('the delivery block never presents the AI half as your words', () => {
  const db = store()
  const note = captureNote(db, { text: '原话' }, at('2026-11-15'), { llmReady: true }).note
  const organised = applyOrganise(db, note.id, { title: '标题', category: '想法', points: ['这是模型加的'], todos: [], dueHint: null, categoryOutOfSet: false }, at('2026-11-15'))
  const text = renderNoteDelivery(organised, 'zh')
  assert.match(text, /- 要点：这是模型加的/, 'the addition is labelled as such')
  assert.equal(text.includes('> 这是模型加的'), false, 'and never inside the quoted original')
})

test('deliveries are recorded, and the view shows them', () => {
  const db = store()
  const note = captureNote(db, { text: '投递看看' }, at('2026-11-15')).note
  recordNoteSend(db, note.id, 'new-chat', 'some text', at('2026-11-15'))
  assert.deepEqual(noteView(db, db.noteById(note.id)!, at('2026-11-15'), 'zh').sends.map(s => s.target), ['new-chat'])
})

test('the +AI badge is on exactly when aiState is done', () => {
  const db = store()
  const note = captureNote(db, { text: '角标' }, at('2026-11-15')).note
  assert.equal(noteView(db, note, at('2026-11-15'), 'zh').aiBadge, false)
  const done = applyOrganise(db, note.id, { title: null, category: '未分类', points: [], todos: [], dueHint: null, categoryOutOfSet: false }, at('2026-11-15'))
  assert.equal(noteView(db, done, at('2026-11-15'), 'zh').aiBadge, true)
  const failed = db.noteById(note.id)!
  markOrganiseFailed(db, failed.id, at('2026-11-15'), 'x')
  assert.equal(noteView(db, db.noteById(note.id)!, at('2026-11-15'), 'zh').aiBadge, false, 'a failed run leaves no badge')
})

// ── export ──────────────────────────────────────────────────

test('export writes one Markdown document with every live note, trash excluded', () => {
  const db = store()
  captureNote(db, { text: '留着的' }, at('2026-11-15'))
  const gone = captureNote(db, { text: '删掉的' }, at('2026-11-15')).note
  setNoteStatus(db, gone.id, 'deleted', at('2026-11-15'))
  const md = exportNotesMarkdown(db, at('2026-11-15'))
  assert.match(md, /留着的/)
  assert.equal(md.includes('删掉的'), false)
})

// ── the view ────────────────────────────────────────────────

test('the view is written by the host: no clock, no language work in the page', () => {
  const db = store()
  const note = captureNote(db, { text: '标题行\n正文' }, at('2026-11-15')).note
  const zh = noteView(db, note, at('2026-11-15') + 1000, 'zh')
  assert.equal(zh.when, '刚刚')
  assert.equal(zh.title, '标题行')
  const later = noteView(db, note, at('2026-11-15') + 3 * 86_400_000, 'en')
  assert.equal(later.when, '3 d ago')
})

test('noteTitle falls back to the first line, never to a blank card', () => {
  const db = store()
  const note = captureNote(db, { text: '\n\n  真正的第一行  \n第二行' }, at('2026-11-15')).note
  assert.equal(noteTitle(note), '真正的第一行')
})

test('the export is Markdown a person can read, not a dumped object', () => {
  const db = store()
  captureNote(db, { text: '导出看看' }, at('2026-11-15'))
  const zh = exportNotesMarkdown(db, at('2026-11-15'), 'zh')
  assert.match(zh, /^# 随手贴导出/)
  assert.equal(zh.includes('[object Object]'), false, 'a bilingual object must never reach the file')
  assert.match(zh, /2026-11-15 · 1 条/)
  assert.match(exportNotesMarkdown(db, at('2026-11-15'), 'en'), /^# Notes export/)
})
