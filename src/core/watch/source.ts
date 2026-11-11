/**
 * Things you watch yourself: a page, a feed or an API you care about.
 *
 * GitHub and mail are sources the secretary knows how to read. Everything
 * else a person cares about — a game's patch notes, a job posting, a price,
 * a status page — is a URL. You add it here with the words that matter to
 * you, and the secretary looks at it now and then: when it changes, or when
 * one of your words shows up, it becomes a card like anything else.
 *
 * Only where and what to look for is kept here. What was seen last lives in
 * the notebook's key-value table, so an entry never grows without bound.
 */

import { createHash } from 'node:crypto'
import { bi, MishuError, type Bi } from '../i18n.ts'
import type { MishuStore } from '../store.ts'

export const WATCH_SOURCE = 'watch'

export interface WatchSource {
  id: number
  /** What you call it: "补丁公告", "机票价格". */
  label: string
  url: string
  /**
   * Words to watch for, lower-cased. Empty: any change is worth a card.
   * A feed is read per entry; a page is read as one text.
   */
  keywords: string[]
  enabled: boolean
  /** Minutes between checks. */
  intervalMinutes: number
}

export interface WatchInput {
  id?: number
  label?: string
  url?: string
  keywords?: string | string[]
  enabled?: boolean
  intervalMinutes?: number
}

export interface WatchReport {
  at: number
  id: number
  /** Entries or text pieces the fetch turned up. */
  items: number
  opened: number
  closed: number
  error?: Bi
}

const SOURCES_KEY = 'watch.sources'
const NEXT_ID_KEY = 'watch.nextId'

export function watchSources(store: MishuStore): WatchSource[] {
  return store.get<WatchSource[]>(SOURCES_KEY) ?? []
}

export function watchById(store: MishuStore, id: number): WatchSource | undefined {
  return watchSources(store).find(s => s.id === id)
}

export function watchReportKey(id: number): string {
  return `watch.lastSync.${id}`
}

/** Where one watch keeps what it has already seen. */
export function watchStateKey(id: number): string {
  return `watch.state.${id}`
}

export function watchSeenKey(id: number): string {
  return `watch.seen.${id}`
}

/** A stable id for a feed entry: its guid, else its link, else its title. */
export function entryKey(entry: { id?: string; link?: string; title?: string }): string {
  const basis = entry.id ?? entry.link ?? entry.title ?? ''
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

/** Split what you typed into words: commas, 、, spaces or new lines all work. */
export function parseKeywords(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，、;\n]+/)
  const words = list.map(w => w.trim().toLowerCase()).filter(w => w !== '')
  return [...new Set(words)].slice(0, 20)
}

/** Check and complete what the settings page sent; throws a sentence a person can act on. */
export function resolveWatch(input: WatchInput, id: number): WatchSource {
  const raw = String(input.url ?? '').trim()
  if (raw === '') throw new MishuError(bi('还没填网址', 'the address is empty'))
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new MishuError(bi(`网址看不懂：${raw}。要完整的一串，比如 https://example.com/news`, `that is not a web address: ${raw}. It should look like https://example.com/news`))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MishuError(bi('只支持 http 和 https 的网址', 'only http and https addresses work'))
  }
  const label = String(input.label ?? '').trim() || url.hostname
  if (label.length > 60) throw new MishuError(bi('名字太长了，60 个字以内', 'the name is too long; keep it under 60 characters'))
  const intervalMinutes = Number(input.intervalMinutes ?? 60)
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440) {
    throw new MishuError(bi('多久看一次要是 15 到 1440 分钟', 'how often to look must be 15 to 1440 minutes'))
  }
  return {
    id,
    label,
    url: url.toString(),
    keywords: parseKeywords(input.keywords),
    enabled: input.enabled !== false,
    intervalMinutes,
  }
}

/** Add (no id) or update one watch. */
export function saveWatch(store: MishuStore, input: WatchInput, now: number): WatchSource {
  const sources = watchSources(store)
  const existing = input.id === undefined ? undefined : sources.find(s => s.id === input.id)
  if (input.id !== undefined && existing === undefined) throw new MishuError(bi(`没有 #${input.id} 这个关注`, `there is no watch #${input.id}`))
  const id = existing?.id ?? (store.get<number>(NEXT_ID_KEY) ?? 1)
  const source = resolveWatch({ ...existing, ...input }, id)
  store.set(SOURCES_KEY, existing === undefined ? [...sources, source] : sources.map(s => (s.id === id ? source : s)))
  if (existing === undefined) store.set(NEXT_ID_KEY, id + 1)
  store.log(now, existing === undefined ? 'watch-add' : 'watch-update', { id, url: source.url, keywords: source.keywords.length })
  return source
}

/** Remove one watch and close whatever it still has open. */
export function deleteWatch(store: MishuStore, id: number, now: number): boolean {
  const sources = watchSources(store)
  if (!sources.some(s => s.id === id)) return false
  store.transaction(() => {
    store.set(SOURCES_KEY, sources.filter(s => s.id !== id))
    store.set(watchStateKey(id), null)
    store.set(watchSeenKey(id), null)
    for (const matter of store.mattersOfSource(WATCH_SOURCE)) {
      if (matter.status === 'open' && (matter.key === `watch:${id}` || matter.key.startsWith(`watch:${id}:`))) {
        store.updateMatter(matter.id, { status: 'done', reason: 'watch-removed', closedBy: 'source', closedAt: now }, now)
      }
    }
    store.log(now, 'watch-delete', { id })
  })
  return true
}

/** The watches whose next check is due. */
export function dueWatches(store: MishuStore, now: number): WatchSource[] {
  return watchSources(store).filter((source) => {
    if (!source.enabled) return false
    const report = store.get<WatchReport>(watchReportKey(source.id))
    return report === undefined || now - report.at >= source.intervalMinutes * 60_000
  })
}
