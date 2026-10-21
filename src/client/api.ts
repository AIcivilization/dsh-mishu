// Calls to the plugin's endpoints on DSH's own authenticated `/api` channel.

import type { BoardData, MatterDetail } from '../core/board.ts'

export type { BoardCard, BoardData, CardAction, DoneGroup, MatterDetail } from '../core/board.ts'

export interface NewItem {
  title: string
  due: string
  repeat: string
  category: string
  note: string
}

type Result<T> = ({ ok: true } & T) | { ok: false; message: string }

async function post<T>(path: string, body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const res = await fetch(new URL(`/api/dsh-mishu${path}`, document.baseURI), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value = await res.json().catch(() => null) as Result<T> | null
    if (value === null) return { ok: false, message: `HTTP ${res.status}` }
    return value
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export const mishuApi = {
  board: (lang: string) => post<{ board: BoardData }>('/board', { lang }),
  sync: (lang: string) => post<{ board: BoardData }>('/sync', { lang }),
  action: (lang: string, target: 'matter' | 'series', id: number, action: string, days?: number) =>
    post<{ board: BoardData }>('/action', { lang, target, id, action, ...days === undefined ? {} : { days } }),
  detail: (lang: string, id: number) => post<{ detail: MatterDetail }>('/detail', { lang, id }),
  preview: (lang: string, item: NewItem) => post<{ text: string }>('/preview', { lang, item }),
  add: (lang: string, item: NewItem) => post<{ id: number; board: BoardData }>('/add', { lang, item }),
}
