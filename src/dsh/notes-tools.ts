/**
 * Tools for notes, so an agent can write one down, find one again, and put a
 * conclusion back on it.
 *
 * The day-to-day motions are unlimited: reading, searching and adding notes
 * change nothing you would miss, and asking permission to look something up
 * would make the notebook useless in a conversation. The two that could lose
 * your writing — changing a note's words, and deleting it — are what the page
 * does by hand.
 *
 * `mishu_note_capture` is the "记得/记一下" case: you say it, the agent writes
 * it down, and the note appears in the tab with its own id. It never merges
 * two notes, and it never says a duplicate was found — it only reports one,
 * and leaves the decision to you.
 */

import { captureNote, noteTitle, noteView, noteToSeries, renderNoteDelivery, updateNote, type NoteView } from '../core/notes/note.ts'
import { findSimilar, RELATED_THRESHOLD } from '../core/notes/rules.ts'
import { bi, errorText, type Lang } from '../core/i18n.ts'
import type { Category, Repeat } from '../core/recur.ts'
import { REPEATS } from '../core/recur.ts'
import type { MishuStore, Note } from '../core/store.ts'
import { loadDefineTool } from './tools.ts'

const ANY_JSON = { type: 'json' } as const

const textResult = {
  schema: ANY_JSON,
  render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
}

export interface NoteToolDeps {
  store: () => MishuStore | undefined
  lang: () => Lang
  now?: () => number
}

/** The tool that changes your words; the page shows the same approval shape. */
export const NOTE_UPDATE_TOOL = 'mishu_note_rewrite'

export async function registerNoteTools(tools: { register(definition: unknown): unknown }, deps: NoteToolDeps): Promise<void> {
  const defineTool = await loadDefineTool()
  const now = deps.now ?? Date.now
  const say = (zh: string, en: string) => bi(zh, en)[deps.lang()]
  const need = (): MishuStore => {
    const store = deps.store()
    if (store === undefined) throw new Error(say('小秘书的记事本没有打开', 'the secretary\'s notebook is not open'))
    return store
  }
  const speak = async <T>(body: () => T | Promise<T>): Promise<T> => {
    try {
      return await body()
    } catch (error) {
      throw new Error(errorText(error, deps.lang()))
    }
  }

  tools.register(defineTool({
    name: 'mishu_note_capture',
    description: [
      'Write something down in the user\'s notes (the 随手贴 / Notes tab) when they say "记一下", "别忘了", "note this down", or dictate a thought.',
      'Keep their words as they said them: the text is stored verbatim and is never rewritten.',
      'Leave `category` empty unless they name one themselves; a rule places it, and one they pick by hand outranks everything.',
      'If a similar note already exists the answer says so, but nothing is merged — tell the user and let them decide.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'What to write down, in the user\'s own words' },
      category: { type: 'string', description: 'Only when the user names one: 工作 / 想法 / 待办 / 参考 / 生活' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels' },
    },
    output: textResult,
    execute: (args: { text: string; category?: string; tags?: string[] }) => speak(() => {
      const lang = deps.lang()
      if (String(args.text ?? '').trim() === '') throw new Error(say('便签是空的', 'the note is empty'))
      const store = need()
      const at = now()
      const result = captureNote(store, {
        text: args.text,
        ...args.category === undefined ? {} : { category: args.category },
        ...args.tags === undefined ? {} : { tags: args.tags },
      }, at)
      const note = result.note
      const lines = [lang === 'zh'
        ? `记下了（${note.id}）。`
        : `Written down (${note.id}).`]
      const title = noteTitle(note)
      if (title !== '') lines.push(lang === 'zh' ? `标题：${title}` : `Title: ${title}`)
      if (lang === 'zh') {
        lines.push(`类别：${note.category}${note.categorySource === 'user' ? '（你指定的）' : '（规则判断）'}`)
        if (note.dueDay !== null) lines.push(`日期：${note.dueDay}（说一声就能设成提醒）`)
        if (result.duplicate !== null) {
          lines.push(`你之前记过一条很像的：「${result.duplicate.title}」（相似度 ${result.duplicate.score}）。两条都留着，要不要合并你说。`)
        }
      } else {
        lines.push(`Category: ${note.category}${note.categorySource === 'user' ? ' (you chose it)' : ' (by rule)'}`)
        if (note.dueDay !== null) lines.push(`Date: ${note.dueDay} (say so and it becomes a reminder)`)
        if (result.duplicate !== null) {
          lines.push(`You wrote something close before: "${result.duplicate.title}" (similarity ${result.duplicate.score}). Both are kept; merge them only if you say so.`)
        }
      }
      return { text: lines.join('\n') }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_note_search',
    description: 'Search the user\'s notes (original text, title, tags and category). Returns the short id, title, category and date of each match, best matches first. Read-only.',
    parameters: {
      query: { type: 'string', required: true, description: 'Words to look for' },
      limit: { type: 'integer', description: 'How many notes, default 20' },
    },
    output: textResult,
    execute: (args: { query: string; limit?: number }) => speak(() => {
      const lang = deps.lang()
      const store = need()
      const limit = Number.isInteger(args.limit) ? Math.min(100, Math.max(1, Number(args.limit))) : 20
      const hits = store.searchNotes(String(args.query ?? ''), { limit })
      if (hits.length === 0) return { text: say(`没有找到「${args.query}」`, `Nothing found for "${args.query}"`) }
      const lines = hits.map((note) => {
        const head = lang === 'zh'
          ? `- [${note.id}] ${noteTitle(note) || '(无标题)'}`
          : `- [${note.id}] ${noteTitle(note) || '(untitled)'}`
        const meta = lang === 'zh'
          ? `  ${note.category} · ${note.status === 'live' ? '在列表里' : note.status === 'archived' ? '已归档' : '在废纸篓'}` + (note.dueDay === null ? '' : ` · ${note.dueDay}`)
          : `  ${note.category} · ${note.status === 'live' ? 'in the list' : note.status === 'archived' ? 'archived' : 'in the trash'}` + (note.dueDay === null ? '' : ` · ${note.dueDay}`)
        return `${head}\n${meta}`
      })
      return { text: `${say(`找到 ${hits.length} 条：`, `${hits.length} found:`)}\n${lines.join('\n')}` }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_note_get',
    description: 'Read one note in full (its id): the original words, the AI half, tags, the date it mentions, whether it became a reminder, and where it has been delivered. Also lists the notes most like it. Read-only.',
    parameters: {
      id: { type: 'string', required: true, description: 'Note id, e.g. 2026-11-15T09-14-22-a3f1' },
    },
    output: textResult,
    execute: (args: { id: string }) => speak(() => {
      const lang = deps.lang()
      const store = need()
      const note = store.noteById(String(args.id ?? '').trim())
      if (note === undefined) throw new Error(say('这条便签不在了', 'that note is gone'))
      const view = noteView(store, note, now(), lang)
      const lines = [
        lang === 'zh' ? `# ${view.title || '(无标题)'}` : `# ${view.title || '(untitled)'}`,
        lang === 'zh' ? `id：${view.id} · 版本 ${view.rev} · ${view.when}` : `id: ${view.id} · rev ${view.rev} · ${view.when}`,
        lang === 'zh' ? `类别：${view.category}（${sourceLabel(view.categorySource, lang)}）` : `Category: ${view.category} (${sourceLabel(view.categorySource, lang)})`,
        ...view.tags.length === 0 ? [] : [lang === 'zh' ? `标签：${view.tags.join('、')}` : `Tags: ${view.tags.join(', ')}`],
        ...view.dueDay === null ? [] : [lang === 'zh' ? `日期：${view.dueDay}` : `Date: ${view.dueDay}`],
        ...view.seriesId === null ? [] : [lang === 'zh' ? `已是提醒：交代 #${view.seriesId}` : `Already a reminder: series #${view.seriesId}`],
        '',
        lang === 'zh' ? '原文：' : 'Original:',
        view.text,
      ]
      if (view.aiPoints.length > 0) {
        lines.push('', lang === 'zh' ? '要点：' : 'Points:', ...view.aiPoints.map(point => `- ${point}`))
      }
      if (view.aiTodos.length > 0) {
        lines.push('', lang === 'zh' ? '待办：' : 'To-do:', ...view.aiTodos.map(todo => `- ${todo}`))
      }
      if (view.sends.length > 0) {
        lines.push('', lang === 'zh' ? '投递记录：' : 'Delivered to:')
        for (const send of view.sends) lines.push(`- ${send.target} · ${new Date(send.at).toISOString().slice(0, 16).replace('T', ' ')}`)
      }
      const related = findSimilar(note, store.liveNotes(), { limit: 3, threshold: RELATED_THRESHOLD })
      if (related.length > 0) {
        lines.push('', lang === 'zh' ? '相似的便签：' : 'Similar notes:')
        for (const hit of related) lines.push(`- [${hit.note.id}] ${hit.note.text.split(/\r?\n/)[0]?.slice(0, 50) ?? ''}（${Math.round(hit.score * 100)}%）`)
      }
      return { text: lines.join('\n') }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_note_promote',
    description: 'Render one note (its id) as the Markdown block it is delivered as: a quoted block carrying the short id, the original words, and the AI half underneath. Produces text only — it does not send anything anywhere.',
    parameters: {
      id: { type: 'string', required: true, description: 'Note id' },
    },
    output: textResult,
    execute: (args: { id: string }) => speak(() => {
      const store = need()
      const note = store.noteById(String(args.id ?? '').trim())
      if (note === undefined) throw new Error(say('这条便签不在了', 'that note is gone'))
      return { text: renderNoteDelivery(note, deps.lang()) }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_note_to_reminder',
    description: [
      'Turn a note (its id) into something the secretary reminds about, by creating a repeating series from it.',
      'Only call this when the user asks for a reminder: a note that merely mentions a date stays a note.',
      'Pick `due` from the note\'s own date when it has one; otherwise ask the user which day.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Note id' },
      due: { type: 'string', description: 'First due day, YYYY-MM-DD; defaults to the date the note mentions' },
      repeat: { type: 'string', enum: [...REPEATS], description: 'none (default), weekly, monthly or yearly' },
      category: { type: 'string', description: 'document / bill / birthday / renewal / other' },
    },
    output: textResult,
    execute: (args: { id: string; due?: string; repeat?: string; category?: string }) => speak(() => {
      const lang = deps.lang()
      const store = need()
      const result = noteToSeries(store, String(args.id ?? '').trim(), {
        ...args.due === undefined ? {} : { due: args.due },
        ...args.repeat === undefined ? {} : { repeat: args.repeat as Repeat },
        ...args.category === undefined ? {} : { category: args.category as Category },
      }, now())
      return {
        text: lang === 'zh'
          ? `「${result.title}」已设为提醒（交代 #${result.seriesId}）。到提醒那天会出现在待处理里。`
          : `"${result.title}" is now a reminder (series #${result.seriesId}). It appears on your list when its reminder day comes.`,
      }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_note_append',
    description: [
      'Put a conclusion back on a note after talking it through: appends to the note\'s AI half, which is the "## AI 补全" area.',
      'Appends only — it never rewrites what the user wrote, and never replaces an earlier conclusion.',
      'Use it when the user says "save that back onto the note" / 「把结论存回卡片」, naming the note id from the delivery block.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Note id' },
      points: { type: 'array', items: { type: 'string' }, description: 'The conclusions to add, one per item' },
    },
    output: textResult,
    execute: (args: { id: string; points: string[] }) => speak(() => {
      const lang = deps.lang()
      const store = need()
      const note = store.noteById(String(args.id ?? '').trim())
      if (note === undefined) throw new Error(say('这条便签不在了', 'that note is gone'))
      const incoming = (Array.isArray(args.points) ? args.points : []).map(point => String(point).trim()).filter(point => point !== '')
      if (incoming.length === 0) throw new Error(say('没有要写回去的内容', 'nothing to write back'))
      // Appended, never substituted: the earlier conclusions stay, and the
      // original words are read but never written.
      const merged = [...note.aiPoints, ...incoming].slice(-20)
      const at = now()
      const stored = store.transaction(() => store.updateNote(note.id, {
        aiPoints: merged,
        aiState: 'done',
        aiBasedOnRev: note.rev,
      }, at)!)
      store.log(at, 'note-append', { id: note.id, added: incoming.length })
      return {
        text: lang === 'zh'
          ? `已追加到便签 ${stored.id} 的 AI 补全区（现有 ${stored.aiPoints.length} 条）。原文没有改动。`
          : `Appended to note ${stored.id}'s AI section (${stored.aiPoints.length} points now). Your own words were not touched.`,
      }
    }),
  }))
}

function sourceLabel(source: NoteView['categorySource'], lang: Lang): string {
  if (lang === 'en') return source === 'user' ? 'you chose it' : source === 'model' ? 'by the model' : 'by rule'
  return source === 'user' ? '你选的' : source === 'model' ? '模型判断' : '规则判断'
}

export type { Note }
