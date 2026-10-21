/**
 * HTTP endpoints for the board page. They live on DSH's own `/api` channel
 * (`ctx.connection.fetch`), so every request has already passed DSH's browser
 * authentication and Host/Origin checks before reaching these handlers.
 *
 * Every endpoint is POST with a JSON body and answers `{ ok: true, … }` or
 * `{ ok: false, message }`. Changing endpoints answer with the fresh board, so
 * the page never shows a state the notebook does not have.
 */

import {
  addDays, addSeries, buildBoard, buildDetail, dayOf, describeSeries, detectLang, errorText, resolveSeries, setStatusByUser,
  snoozeByUser, stopSeries, tickManual, type BoardData, type Category, type Lang, type MishuStore, type SeriesInput,
} from '../core/index.ts'
import type { MishuConfig } from './config.ts'

export const API_BASE = '/api/dsh-mishu'

export interface ApiDeps {
  store: () => MishuStore | undefined
  config: MishuConfig
  /** The language fixed by config, or undefined for `auto`. */
  fixedLang: Lang | undefined
  sync: () => Promise<unknown>
  now?: () => number
}

type Body = Record<string, unknown>
type Handler = (body: Body) => Promise<Record<string, unknown>>

class ApiError extends Error {}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function seriesInput(value: unknown): SeriesInput {
  const item = (value ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
  const int = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  return {
    title: String(item.title ?? ''),
    due: String(item.due ?? ''),
    ...text(item.repeat) === undefined ? {} : { repeat: item.repeat as SeriesInput['repeat'] },
    ...int(item.every) === undefined ? {} : { every: int(item.every)! },
    ...text(item.category) === undefined ? {} : { category: item.category as Category },
    ...int(item.leadDays) === undefined ? {} : { leadDays: int(item.leadDays)! },
    ...text(item.note) === undefined ? {} : { note: String(item.note) },
  }
}

export function apiHandlers(deps: ApiDeps): Record<string, Handler> {
  const now = deps.now ?? Date.now
  const langOf = (body: Body): Lang => deps.fixedLang ?? detectLang(typeof body.lang === 'string' ? body.lang : undefined)
  const need = (lang: Lang) => {
    const store = deps.store()
    if (store === undefined) throw new ApiError(lang === 'zh' ? '小秘书的记事本没有打开' : 'The notebook is not open')
    return store
  }
  const board = (store: MishuStore, lang: Lang): BoardData => {
    const at = now()
    tickManual(store, dayOf(at), at)
    return buildBoard(store, { now: at, lang, github: { enabled: deps.config.github.enabled, markRead: deps.config.github.markRead } })
  }

  return {
    '/board': async (body) => {
      const lang = langOf(body)
      return { board: board(need(lang), lang) }
    },

    '/sync': async (body) => {
      const lang = langOf(body)
      await deps.sync()
      return { board: board(need(lang), lang) }
    },

    '/action': async (body) => {
      const lang = langOf(body)
      const store = need(lang)
      const id = Number(body.id)
      const at = now()
      const missing = () => new ApiError(lang === 'zh' ? `没有 #${body.id} 这一项` : `There is no item #${body.id}`)
      if (!Number.isInteger(id) || id <= 0) throw missing()
      if (body.target === 'series') {
        if (body.action !== 'stop' || stopSeries(store, id, at) === undefined) throw missing()
        return { board: board(store, lang) }
      }
      switch (body.action) {
        case 'done':
        case 'dismiss':
        case 'reopen': {
          const status = body.action === 'done' ? 'done' : body.action === 'dismiss' ? 'dismissed' : 'open'
          if (setStatusByUser(store, id, status, at) === undefined) throw missing()
          break
        }
        case 'snooze': {
          const days = Number.isInteger(body.days) && Number(body.days) > 0 ? Number(body.days) : 1
          if (snoozeByUser(store, id, addDays(dayOf(at), days), at) === undefined) throw missing()
          break
        }
        case 'unsnooze':
          if (snoozeByUser(store, id, null, at) === undefined) throw missing()
          break
        default:
          throw new ApiError(lang === 'zh' ? `不认识的操作：${String(body.action)}` : `Unknown action: ${String(body.action)}`)
      }
      return { board: board(store, lang) }
    },

    '/detail': async (body) => {
      const lang = langOf(body)
      const detail = buildDetail(need(lang), Number(body.id), { now: now(), lang, markRead: deps.config.github.markRead })
      if (detail === undefined) throw new ApiError(lang === 'zh' ? `没有 #${body.id} 这一项` : `There is no item #${body.id}`)
      return { detail }
    },

    '/preview': async (body) => {
      const lang = langOf(body)
      const resolved = resolveSeries(seriesInput(body.item), deps.config.leadDays)
      return { text: describeSeries(resolved, dayOf(now()), lang) }
    },

    '/add': async (body) => {
      const lang = langOf(body)
      const store = need(lang)
      const resolved = resolveSeries(seriesInput(body.item), deps.config.leadDays)
      const at = now()
      const series = addSeries(store, resolved, at)
      return { id: series.id, board: board(store, lang) }
    },
  }
}

/** Run one handler; failures become `{ ok: false, message }` in the caller's language. */
export async function handle(handler: Handler, request: Request, fixedLang: Lang | undefined): Promise<Response> {
  let body: Body = {}
  try {
    const text = await request.text()
    body = text === '' ? {} : JSON.parse(text) as Body
  } catch {
    return json(400, { ok: false, message: 'invalid JSON' })
  }
  const lang = fixedLang ?? detectLang(typeof body.lang === 'string' ? body.lang : undefined)
  try {
    return json(200, { ok: true, ...await handler(body) })
  } catch (error) {
    return json(200, { ok: false, message: errorText(error, lang) })
  }
}
