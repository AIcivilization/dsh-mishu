/**
 * The note tab's endpoints, on DSH's own authenticated `/api` channel.
 *
 * Same shape as the rest of the page's API: POST, a JSON body carrying `lang`,
 * and `{ ok: true, … }` or `{ ok: false, message }` back. Everything that
 * changes answers with the fresh note, so the page never has to guess what the
 * notebook holds now.
 *
 * Two of them are deliberately narrow. `/note-purge` only works on a note that
 * is already in the trash, and `/note-organize` refuses when this Host has no
 * model — saying so beats a spinner that never ends.
 */

import {
  captureNote, exportNotesMarkdown, MAX_NOTE_TEXT, noteTitle, noteView, noteToSeries,
  purgeNote, recordNoteSend, renderNoteDelivery, setNoteStatus, updateNote,
  type NoteView,
} from '../core/notes/note.ts'
import { findSimilar, RELATED_THRESHOLD } from '../core/notes/rules.ts'
import { bi, MishuError, type Lang } from '../core/i18n.ts'
import type { Category, Repeat } from '../core/recur.ts'
import { REPEATS } from '../core/recur.ts'
import type { MishuStore, Note, NoteStatus } from '../core/store.ts'

type Body = Record<string, unknown>
type Handler = (body: Body) => Promise<Record<string, unknown>>

export interface NoteApiDeps {
  store(lang: Lang): MishuStore
  organize(id: string, lang: Lang): Promise<NoteView>
  /** A model is wired up in this Host at all. */
  hasModel(): boolean
  /**
   * The privacy gate: whether note text may be sent to the model. Off by
   * default, because the notebook's standing promise is that what is in it
   * stays on this computer.
   */
  organiseAllowed(): boolean
  now(): number
  fixedLang(): Lang | undefined
  detectLang(value: unknown): Lang
  /** The day counts the tab shows; computed here so the page needs no clock. */
  counts(store: MishuStore): { live: number; archived: number; deleted: number }
}

class NoteApiError extends Error {}

const text = (value: unknown, max = 400): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

const need = (value: unknown, lang: Lang): string => {
  const id = text(value, 120)
  if (id === undefined) throw new NoteApiError(bi('没说清是哪条便签', 'no note was named')[lang])
  return id
}

function tagList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') return value.split(/[,，、]/).map(item => item.trim()).filter(item => item !== '')
  return undefined
}

function statusOf(value: unknown, lang: Lang): NoteStatus {
  const status = String(value ?? '')
  if (status !== 'live' && status !== 'archived' && status !== 'deleted') {
    throw new NoteApiError(bi(`不认识这个状态：${status}`, `unknown status: ${status}`)[lang])
  }
  return status
}

export function noteHandlers(deps: NoteApiDeps): Record<string, Handler> {
  const langOf = (body: Body): Lang => deps.fixedLang() ?? deps.detectLang(body.lang)

  /** One note, as the page shows it. */
  const view = (store: MishuStore, note: Note, lang: Lang): NoteView => noteView(store, note, deps.now(), lang)

  return {
    '/note-list': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const notes = store.notes({ trash: body.trash === true, archived: body.archived === true })
      return { notes: notes.map(note => view(store, note, lang)), counts: deps.counts(store) }
    },

    '/note-get': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const note = store.noteById(need(body.id, lang))
      if (note === undefined) throw new NoteApiError(bi('这条便签不在了', 'that note is gone')[lang])
      const related = findSimilar(note, store.liveNotes(), { limit: 5, threshold: RELATED_THRESHOLD })
        .map(hit => ({ id: hit.note.id, title: hit.note.text.split(/\r?\n/)[0]?.slice(0, 60) ?? '', score: Math.round(hit.score * 100) / 100 }))
      return { note: view(store, note, lang), related }
    },

    '/note-capture': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const input = String(body.text ?? '')
      if (input.trim() === '') throw new NoteApiError(bi('便签是空的', 'the note is empty')[lang])
      if (input.length > MAX_NOTE_TEXT) {
        throw new NoteApiError(bi(`便签太长（上限 ${MAX_NOTE_TEXT} 字）`, `the note is too long (limit ${MAX_NOTE_TEXT} characters)`)[lang])
      }
      const result = captureNote(store, {
        text: input,
        ...text(body.category, 40) === undefined ? {} : { category: text(body.category, 40)! },
        ...tagList(body.tags) === undefined ? {} : { tags: tagList(body.tags)! },
        // Only ask for organising when a model exists: otherwise the note would
        // sit at `pending` for ever and the badge would never settle.
        organize: body.organize === true && deps.organiseAllowed(),
      }, deps.now(), { llmReady: deps.organiseAllowed() })
      const first = result.note
      // The queue is started here, after the note is already on disk, so a slow
      // or failed model call cannot hold up the save.
      if (first.aiState === 'pending') void deps.organize(first.id, lang).catch(() => undefined)
      return {
        note: view(store, store.noteById(first.id) ?? first, lang),
        rule: result.rule,
        duplicate: result.duplicate,
        due: result.due,
      }
    },

    '/note-update': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const id = need(body.id, lang)
      const rev = Number(body.rev)
      if (!Number.isInteger(rev) || rev <= 0) {
        throw new NoteApiError(bi('要带上你看到的版本号', 'say which revision you were looking at')[lang])
      }
      const note = updateNote(store, id, {
        rev,
        ...typeof body.text === 'string' ? { text: body.text } : {},
        ...text(body.category, 40) === undefined ? {} : { category: text(body.category, 40)! },
        ...tagList(body.tags) === undefined ? {} : { tags: tagList(body.tags)! },
      }, deps.now())
      return { note: view(store, note, lang) }
    },

    '/note-search': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const query = text(body.q, 200)
      if (query === undefined) return { notes: [] }
      const limit = Number.isInteger(body.limit) ? Math.min(200, Math.max(1, Number(body.limit))) : 50
      return { notes: store.searchNotes(query, { limit }).map(note => view(store, note, lang)) }
    },

    '/note-status': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const note = setNoteStatus(store, need(body.id, lang), statusOf(body.status, lang), deps.now())
      return { note: view(store, note, lang), counts: deps.counts(store) }
    },

    '/note-purge': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const id = need(body.id, lang)
      const note = store.noteById(id)
      if (note === undefined) throw new NoteApiError(bi('这条便签不在了', 'that note is gone')[lang])
      // Only out of the trash: one click in the list must never destroy anything.
      if (note.status !== 'deleted') {
        throw new NoteApiError(bi('先放进废纸篓，再从那里彻底删除', 'put it in the trash first, then delete it for good from there')[lang])
      }
      purgeNote(store, id, deps.now())
      return { ok: true, counts: deps.counts(store) }
    },

    '/note-organize': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const id = need(body.id, lang)
      if (store.noteById(id) === undefined) throw new NoteApiError(bi('这条便签不在了', 'that note is gone')[lang])
      if (!deps.organiseAllowed()) {
        // Two different refusals, told apart: one is a missing service, the
        // other is a setting you can turn on. Saying which is which saves a
        // hunt through the settings page.
        throw new NoteApiError((deps.hasModel()
          ? bi(
            '便签整理默认关着：打开设置里的「让 AI 整理便签」才会把便签原文发给模型。现在原文照常保存。',
            'Organising notes is off by default: turn on "let AI organise notes" in Settings to send note text to the model. Your note is saved as written.',
          )
          : bi(
            '这台 DSH 没有接模型服务，便签不会自动整理。原文照常保存，其余功能都能用。',
            'This Host has no model service, so notes are not organised automatically. Notes are saved as you write them and everything else works.',
          ))[lang])
      }
      return { note: await deps.organize(id, lang) }
    },

    '/note-to-series': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const repeat = String(body.repeat ?? 'none') as Repeat
      if (!REPEATS.includes(repeat)) {
        throw new NoteApiError(bi(`不认识的重复方式：${repeat}`, `unknown repeat: ${repeat}`)[lang])
      }
      const result = noteToSeries(store, need(body.id, lang), {
        ...text(body.due, 10) === undefined ? {} : { due: text(body.due, 10)! },
        repeat,
        ...text(body.category, 20) === undefined ? {} : { category: text(body.category, 20) as Category },
        ...Number.isInteger(body.leadDays) ? { leadDays: Number(body.leadDays) } : {},
      }, deps.now())
      return { note: view(store, result.note, lang), seriesId: result.seriesId, title: result.title }
    },

    '/note-render': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const note = store.noteById(need(body.id, lang))
      if (note === undefined) throw new NoteApiError(bi('这条便签不在了', 'that note is gone')[lang])
      return { text: renderNoteDelivery(note, lang) }
    },

    '/note-record': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      const id = need(body.id, lang)
      const target = String(body.target ?? '')
      if (!['new-chat', 'current-chat', 'clipboard'].includes(target)) {
        throw new NoteApiError(bi(`不认识的去向：${target}`, `unknown destination: ${target}`)[lang])
      }
      if (store.noteById(id) === undefined) throw new NoteApiError(bi('这条便签不在了', 'that note is gone')[lang])
      recordNoteSend(store, id, target, typeof body.text === 'string' ? body.text.slice(0, 20_000) : null, deps.now())
      return { note: view(store, store.noteById(id)!, lang) }
    },

    /** One Markdown file of everything, for grep, Obsidian or a backup. */
    '/note-export': async (body) => {
      const lang = langOf(body)
      const store = deps.store(lang)
      return {
        text: exportNotesMarkdown(store, deps.now(), lang),
        filename: `notes-${new Date(deps.now()).toISOString().slice(0, 10)}.md`,
      }
    },
  }
}

export type { NoteView }
