/**
 * One watch, one check: read the address, compare with what was seen last
 * time, and turn anything new into a card.
 *
 * A card per watch, not per entry: "补丁公告 · 3 条新内容" is what you want to
 * see, not three cards that say the same thing. Marking it done closes it;
 * the next change opens it again with what changed.
 *
 * The first check only writes down what is there now — otherwise adding a
 * feed would hand you every entry it ever published. Words you asked to watch
 * for are the exception: those are shown right away, because you asked.
 */

import { applyVerdict } from '../fold.ts'
import { bi, MishuError, type Bi } from '../i18n.ts'
import type { MishuStore } from '../store.ts'
import { shortDay } from '../time.ts'
import type { Verdict } from '../github/rules.ts'
import { describeWatchError, readWatchBody, type WatchFetch, type WatchItem } from './fetch.ts'
import { WATCH_SOURCE, watchReportKey, watchSeenKey, watchStateKey, type WatchReport, type WatchSource } from './source.ts'

/** How many entry keys one watch remembers. A feed longer than this is fine; the tail ages out. */
const SEEN_LIMIT = 500

interface WatchState {
  /** Keys of entries already reported, newest last. */
  seen: string[]
  /** Fingerprint of the whole page, for addresses that are not feeds. */
  digest?: string
  /** First check done. */
  primed: boolean
}

function readState(store: MishuStore, id: number): WatchState {
  return store.get<WatchState>(watchStateKey(id)) ?? { seen: [], primed: false }
}

/** Which items are new since last time, and whether the whole page changed. */
export function diffItems(items: WatchItem[], state: WatchState): { fresh: WatchItem[]; changed: boolean; digest: string } {
  const seen = new Set(state.seen)
  const fresh = items.filter(item => !seen.has(item.key))
  // A single-item read is a page: its key is a hash of the text, so "new" means "the text changed".
  const digest = items.length === 1 ? items[0]!.key : items.map(i => i.key).sort().join(',')
  return { fresh, changed: state.digest !== undefined && state.digest !== digest, digest }
}

function matches(item: WatchItem, keywords: readonly string[]): string | undefined {
  if (keywords.length === 0) return undefined
  const haystack = `${item.title}\n${item.text}`.toLowerCase()
  return keywords.find(word => haystack.includes(word))
}

function quote(items: WatchItem[], lang: 'zh' | 'en'): string {
  const shown = items.slice(0, 3).map(i => `「${i.title.slice(0, 80)}」`)
  const more = items.length - shown.length
  if (lang === 'zh') return more > 0 ? `${shown.join('、')} 等 ${items.length} 条` : shown.join('、')
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

export function judgeWatch(options: {
  source: WatchSource
  items: WatchItem[]
  fresh: WatchItem[]
  changed: boolean
  first: boolean
  now: number
}): Verdict | undefined {
  const { source, items, fresh, changed, first, now } = options
  const hit = (list: WatchItem[]) => list
    .map(item => ({ item, word: matches(item, source.keywords) }))
    .filter((x): x is { item: WatchItem; word: string } => x.word !== undefined)

  const freshHits = hit(fresh)
  const allHits = hit(items)
  const keywordMode = source.keywords.length > 0

  let reason: string
  let relevant: WatchItem[]
  let word: string | undefined
  if (keywordMode) {
    // A word you watch for is worth a card even on the very first check.
    relevant = (first ? allHits : freshHits).map(x => x.item)
    if (relevant.length === 0) return undefined
    word = (first ? allHits : freshHits)[0]!.word
    reason = 'watch-keyword'
  } else if (first) {
    return undefined
  } else if (fresh.length > 0) {
    relevant = fresh
    reason = items.length > 1 ? 'watch-new' : 'watch-changed'
  } else if (changed) {
    relevant = items.slice(0, 1)
    reason = 'watch-changed'
  } else {
    return undefined
  }

  const when = shortDay(now)
  const what = bi(`你关注「${source.label}」（${new URL(source.url).hostname}）`, `The thing you watch: "${source.label}" (${new URL(source.url).hostname})`)
  const why = keywordMode && word !== undefined
    ? bi(`${when} 检查时，这里有内容提到你关注的字「${word}」：${quote(relevant, 'zh')}。`, `On ${when} it mentioned "${word}", one of your words: ${quote(relevant, 'en')}.`)
    : reason === 'watch-new'
      ? bi(`${when} 检查时出现了 ${fresh.length} 条新内容：${quote(relevant, 'zh')}。`, `On ${when} there were ${fresh.length} new entries: ${quote(relevant, 'en')}.`)
      : bi(`${when} 检查时，${source.label} 的内容变了：${quote(relevant, 'zh')}。`, `On ${when} "${source.label}" changed: ${quote(relevant, 'en')}.`)
  const link = relevant.find(i => i.url !== null)?.url ?? source.url
  return {
    matterKey: `watch:${source.id}`,
    kind: 'watch',
    title: source.label,
    url: link,
    status: 'open',
    reason,
    note: bi(
      keywordMode ? `提到「${word}」` : reason === 'watch-new' ? `${fresh.length} 条新内容` : '内容有变化',
      keywordMode ? `mentions "${word}"` : reason === 'watch-new' ? `${fresh.length} new entries` : 'changed',
    ),
    explain: {
      what,
      why,
      fix: bi('打开看一眼；处理完点"办完了"。不想再关注了，在设置里删掉这一条。', 'Open it and have a look; mark it done afterwards. To stop watching, delete it in Settings.'),
      link: { label: bi('打开看看', 'Open it'), url: link },
    },
  }
}

export async function syncWatch(options: {
  store: MishuStore
  source: WatchSource
  fetcher: WatchFetch
  now: number
}): Promise<WatchReport> {
  const { store, source, fetcher, now } = options
  const report: WatchReport = { at: now, id: source.id, items: 0, opened: 0, closed: 0 }
  let body: { status: number; body: string; contentType: string }
  try {
    body = await fetcher(source.url)
  } catch (error) {
    report.error = describeWatchError(error, source)
    store.set(watchReportKey(source.id), report)
    return report
  }
  if (body.status >= 400) {
    report.error = body.status === 404
      ? bi(`${source.label} 打不开了（404）：这个网址可能已经变了。`, `${source.label} is gone (404): the address may have moved.`)
      : bi(`${source.label} 返回 ${body.status}，读不到内容。`, `${source.label} answered ${body.status}, so there was nothing to read.`)
    store.set(watchReportKey(source.id), report)
    return report
  }

  if (body.body.trim() === '') {
    report.error = bi(`${source.label} 这次读到的是空页面。`, `${source.label} came back empty.`)
    store.set(watchReportKey(source.id), report)
    return report
  }
  const items = readWatchBody({ body: body.body, contentType: body.contentType, url: source.url, now })
  if (items.length === 0) {
    report.error = bi(`${source.label} 这次读到的是空页面。`, `${source.label} came back empty.`)
    store.set(watchReportKey(source.id), report)
    return report
  }
  report.items = items.length

  const state = readState(store, source.id)
  const { fresh, changed, digest } = diffItems(items, state)
  const verdict = judgeWatch({ source, items, fresh, changed, first: !state.primed, now })

  store.transaction(() => {
    if (verdict !== undefined) {
      const counts = { opened: 0, closed: 0 }
      applyVerdict(store, WATCH_SOURCE, { ...verdict, activityAt: Math.max(...items.map(i => i.at), now) }, now, counts)
      report.opened = counts.opened
      report.closed = counts.closed
    }
    const seen = [...state.seen, ...fresh.map(i => i.key)]
    const trimmed = seen.length > SEEN_LIMIT ? seen.slice(seen.length - SEEN_LIMIT) : seen
    store.set(watchStateKey(source.id), { seen: trimmed, digest, primed: true } satisfies WatchState)
    store.set(watchSeenKey(source.id), trimmed.length)
  })
  store.set(watchReportKey(source.id), report)
  return report
}

/** Everything about one watch the settings page shows. */
export function describeWatch(store: MishuStore, source: WatchSource, lang: 'zh' | 'en'): string {
  const report = store.get<WatchReport>(watchReportKey(source.id))
  if (report === undefined) return lang === 'zh' ? '还没看过' : 'not checked yet'
  if (report.error !== undefined) return report.error[lang]
  return lang === 'zh'
    ? `${shortDay(report.at)} 看过，${report.items} 条内容`
    : `checked ${shortDay(report.at)}, ${report.items} entries`
}

/** The words, for showing back to you. */
export function describeKeywords(source: WatchSource, lang: 'zh' | 'en'): string {
  if (source.keywords.length === 0) return lang === 'zh' ? '有任何变化就告诉我' : 'tell me about any change'
  return lang === 'zh' ? `提到 ${source.keywords.join('、')} 时告诉我` : `tell me when it mentions ${source.keywords.join(', ')}`
}

/** Guard for the settings page: an address that cannot be a watch at all. */
export function assertWatchable(source: WatchSource): void {
  if (!/^https?:\/\//.test(source.url)) throw new MishuError(bi('只支持 http 和 https 的网址', 'only http and https addresses work'))
}
