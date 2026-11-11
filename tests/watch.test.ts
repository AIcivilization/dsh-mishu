import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBoard } from '../src/core/board.ts'
import { REASON_LABELS } from '../src/core/brief.ts'
import type { MishuError } from '../src/core/i18n.ts'
import { MishuStore } from '../src/core/store.ts'
import { parseFeed, parseJson, parsePage, plainText, readWatchBody } from '../src/core/watch/fetch.ts'
import { deleteWatch, parseKeywords, resolveWatch, saveWatch, watchSources, dueWatches, watchReportKey, type WatchReport } from '../src/core/watch/source.ts'
import { diffItems, judgeWatch, syncWatch } from '../src/core/watch/sync.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'
import { at } from './helpers.ts'

const NOW = at('2026-10-21', 9)

function store(): MishuStore {
  return MishuStore.open(':memory:')
}

function add(store: MishuStore, input: Parameters<typeof saveWatch>[1]) {
  return saveWatch(store, input, NOW)
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>补丁公告</title>
<item><title>1.4.0 更新</title><link>https://example.com/p/1</link><description><![CDATA[<p>修了闪退</p>]]></description><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>1.3.9 更新</title><link>https://example.com/p/2</link><description>改了平衡性</description><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`

test('a watch needs a real http address, a name and a sane interval', () => {
  const s = store()
  assert.throws(() => add(s, { url: '' }), (e: MishuError) => e.text.zh.includes('还没填网址'))
  assert.throws(() => add(s, { url: 'ftp://example.com/x' }), (e: MishuError) => e.text.zh.includes('http'))
  assert.throws(() => add(s, { url: 'not a url' }), (e: MishuError) => e.text.zh.includes('看不懂'))
  assert.throws(() => add(s, { url: 'https://example.com', intervalMinutes: 1 }), (e: MishuError) => e.text.zh.includes('15 到 1440'))
  const ok = add(s, { url: 'https://example.com/news', label: '  公告  ', intervalMinutes: 30 })
  assert.equal(ok.label, '公告')
  assert.equal(ok.url, 'https://example.com/news')
  assert.equal(ok.enabled, true)
  assert.deepEqual(watchSources(s).map(w => w.id), [ok.id])
  // No name: the host stands in, so the card never has an empty title.
  assert.equal(add(s, { url: 'https://example.org/a' }).label, 'example.org')
})

test('words are split however you type them, de-duplicated, and capped', () => {
  assert.deepEqual(parseKeywords('上新, 补丁、面试; 上新\n价格'), ['上新', '补丁', '面试', '价格'])
  assert.deepEqual(parseKeywords(''), [])
  assert.deepEqual(parseKeywords(undefined), [])
  assert.equal(parseKeywords(Array.from({ length: 30 }, (_, i) => `w${i}`)).length, 20)
})

test('the first look writes down what is there and says nothing', async () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/feed.xml', label: '公告' })
  const report = await syncWatch({ store: s, source, now: NOW, fetcher: async () => ({ status: 200, body: RSS, contentType: 'application/rss+xml' }) })
  assert.equal(report.items, 2)
  assert.equal(report.opened, 0, 'adding a feed must not hand you its whole history')
  assert.equal(s.openMatters().length, 0)
  assert.equal(s.get<WatchReport>(watchReportKey(source.id))?.items, 2)
})

test('a new entry after that becomes one card, not one per entry', async () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/feed.xml', label: '公告' })
  const feed = (extra: string) => RSS.replace('<channel>', `<channel>${extra}`)
  await syncWatch({ store: s, source, now: NOW, fetcher: async () => ({ status: 200, body: RSS, contentType: 'application/rss+xml' }) })

  const later = feed('<item><title>1.5.0 更新</title><link>https://example.com/p/3</link><description>新增关卡</description></item>')
  const report = await syncWatch({ store: s, source, now: NOW + 3600_000, fetcher: async () => ({ status: 200, body: later, contentType: 'application/rss+xml' }) })
  assert.equal(report.opened, 1)
  const open = s.openMatters()
  assert.equal(open.length, 1)
  assert.equal(open[0]!.key, `watch:${source.id}`)
  assert.equal(open[0]!.source, 'watch')
  assert.equal(open[0]!.reason, 'watch-new')
  assert.ok(open[0]!.note !== null && JSON.parse(open[0]!.note).zh.includes('1 条新内容'))

  // A second new entry reopens the same card instead of adding another.
  const third = feed('<item><title>1.6.0</title><link>https://example.com/p/4</link></item><item><title>1.5.0 更新</title><link>https://example.com/p/3</link><description>新增关卡</description></item>')
  const again = await syncWatch({ store: s, source, now: NOW + 7200_000, fetcher: async () => ({ status: 200, body: third, contentType: 'application/rss+xml' }) })
  assert.equal(again.opened, 0, 'already open: nothing to open again')
  assert.equal(s.openMatters().length, 1)
})

test('words you watch for are reported on the very first look', async () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/feed.xml', label: '公告', keywords: '闪退' })
  const report = await syncWatch({ store: s, source, now: NOW, fetcher: async () => ({ status: 200, body: RSS, contentType: 'application/rss+xml' }) })
  assert.equal(report.opened, 1)
  const open = s.openMatters()
  assert.equal(open[0]!.reason, 'watch-keyword')
  assert.ok(JSON.parse(open[0]!.note!).zh.includes('闪退'))
})

test('a page with no feed is compared by its text', async () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/price', label: '价格' })
  const page = (body: string) => `<html><head><title>价格页</title></head><body><p>${body}</p></body></html>`
  const first = await syncWatch({ store: s, source, now: NOW, fetcher: async () => ({ status: 200, body: page('¥299'), contentType: 'text/html' }) })
  assert.equal(first.opened, 0)
  const same = await syncWatch({ store: s, source, now: NOW + 60_000, fetcher: async () => ({ status: 200, body: page('¥299'), contentType: 'text/html' }) })
  assert.equal(same.opened, 0, 'the same text is not a change')
  const changed = await syncWatch({ store: s, source, now: NOW + 120_000, fetcher: async () => ({ status: 200, body: page('¥199'), contentType: 'text/html' }) })
  assert.equal(changed.opened, 1)
  assert.equal(s.openMatters()[0]!.reason, 'watch-changed')
})

test('a JSON list is read too, and an entry keeps its link', async () => {
  const s = store()
  const body = JSON.stringify({ data: [{ id: 'a1', title: 'Vue 3.6', url: 'https://example.com/vue', description: 'released' }] })
  const items = parseJson(body, NOW, 'https://api.example.com/releases')
  assert.equal(items?.[0]?.title, 'Vue 3.6')
  assert.equal(items?.[0]?.url, 'https://example.com/vue')
  assert.equal(items?.[0]?.text, 'released')

  const source = add(s, { url: 'https://api.example.com/releases', label: '版本' })
  const read = readWatchBody({ body, contentType: 'application/json', url: source.url, now: NOW })
  assert.equal(read.length, 1)
  assert.equal(parseFeed(RSS, NOW, 'https://example.com/feed.xml')?.length, 2)
  assert.equal(plainText('<b>粗</b>&amp;细'), '粗 &细'.replace(' &', ' &'))
  assert.equal(parsePage('<title>T</title><body>hi</body>', NOW, 'https://example.com/x')[0]!.title, 'T')
})

test('a watch that cannot be read says so in plain words, and keeps its old cards', async () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/feed.xml', label: '公告' })
  await syncWatch({ store: s, source, now: NOW, fetcher: async () => ({ status: 200, body: RSS, contentType: 'application/rss+xml' }) })
  const failed = await syncWatch({ store: s, source, now: NOW + 60_000, fetcher: async () => { throw new Error('getaddrinfo ENOTFOUND example.com') } })
  assert.ok(failed.error?.zh.includes('找不到服务器'))
  const gone = await syncWatch({ store: s, source, now: NOW + 120_000, fetcher: async () => ({ status: 404, body: '', contentType: 'text/html' }) })
  assert.ok(gone.error?.zh.includes('404'))
  const empty = await syncWatch({ store: s, source, now: NOW + 180_000, fetcher: async () => ({ status: 200, body: '', contentType: 'text/html' }) })
  assert.ok(empty.error !== undefined)
  assert.equal(s.openMatters().length, 0, 'a failed read never invents a card')
})

test('the board shows a watch card and a status line, and filters by source', async () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/feed.xml', label: '公告' })
  await syncWatch({ store: s, source, now: NOW, fetcher: async () => ({ status: 200, body: RSS, contentType: 'application/rss+xml' }) })
  await syncWatch({ store: s, source, now: NOW + 60_000, fetcher: async () => ({ status: 200, body: RSS.replace('<channel>', '<channel><item><title>新</title><link>https://example.com/n</link></item>'), contentType: 'application/rss+xml' }) })
  const board = buildBoard(s, { now: NOW + 60_000, lang: 'zh', github: { enabled: false, markRead: 'off' }, watches: watchSources(s) })
  assert.equal(board.sources.watch.length, 1)
  assert.equal(board.sources.watch[0]!.state, 'ok')
  assert.ok(board.sources.watch[0]!.text.includes('公告'))
  const card = board.columns.handle.find(c => c.source === 'watch')
  assert.ok(card !== undefined)
  assert.equal(card.title, '公告')
  assert.ok(REASON_LABELS['watch-new'] !== undefined)
})

test('deleting a watch closes what it left open and forgets what it saw', async () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/feed.xml', label: '公告', keywords: '闪退' })
  await syncWatch({ store: s, source, now: NOW, fetcher: async () => ({ status: 200, body: RSS, contentType: 'application/rss+xml' }) })
  assert.equal(s.openMatters().length, 1)
  assert.equal(deleteWatch(s, source.id, NOW + 1000), true)
  assert.deepEqual(watchSources(s), [])
  assert.equal(s.openMatters().length, 0)
  assert.equal(s.closedSince(NOW)[0]!.reason, 'watch-removed')
  assert.equal(deleteWatch(s, source.id, NOW + 2000), false)
})

test('a watch is only looked at again once its interval has passed', () => {
  const s = store()
  const source = add(s, { url: 'https://example.com/a', label: 'a', intervalMinutes: 60 })
  assert.deepEqual(dueWatches(s, NOW).map(w => w.id), [source.id], 'never checked: due at once')
  s.set(watchReportKey(source.id), { at: NOW, id: source.id, items: 1, opened: 0, closed: 0 } satisfies WatchReport)
  assert.deepEqual(dueWatches(s, NOW + 30 * 60_000), [])
  assert.deepEqual(dueWatches(s, NOW + 60 * 60_000).map(w => w.id), [source.id])
  saveWatch(s, { id: source.id, enabled: false }, NOW)
  assert.deepEqual(dueWatches(s, NOW + 10 * 3600_000), [])
})

test('the diff keeps what was seen, so an old entry never comes back as new', () => {
  const state = { seen: ['a', 'b'], primed: true }
  const items = [
    { key: 'a', title: 'a', text: '', url: null, at: NOW },
    { key: 'b', title: 'b', text: '', url: null, at: NOW },
    { key: 'c', title: 'c', text: '', url: null, at: NOW },
  ]
  const { fresh, changed } = diffItems(items, state)
  assert.deepEqual(fresh.map(i => i.key), ['c'])
  assert.equal(changed, false, 'a longer list is not a changed page')
  const verdict = judgeWatch({ source: { id: 1, label: 'x', url: 'https://example.com/x', keywords: [], enabled: true, intervalMinutes: 60 }, items, fresh, changed: false, first: false, now: NOW })
  assert.equal(verdict?.reason, 'watch-new')
  assert.equal(verdict?.matterKey, 'watch:1')
})

test('the API answers for watches: save, test, sync and delete', async () => {
  const s = store()
  const runtime = new Runtime(Config({ language: 'auto', github: { enabled: false } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  runtime.store = s
  runtime.watchFetch = async () => ({ status: 200, body: RSS, contentType: 'application/rss+xml' })
  const api = apiHandlers(runtime, () => NOW)

  const saved = await api['/watch/save']!({ lang: 'zh', watch: { url: 'https://example.com/feed.xml', label: '公告', keywords: '闪退', intervalMinutes: 60 } }) as { id: number; view: { watches: Array<{ id: number; label: string }> } }
  assert.equal(saved.view.watches.length, 1)
  assert.equal(saved.view.watches[0]!.label, '公告')

  const tested = await api['/watch/test']!({ lang: 'zh', watch: { url: 'https://example.com/feed.xml', keywords: '闪退' } }) as { items: number; title: string; keywordHit: boolean }
  assert.equal(tested.items, 2)
  assert.equal(tested.keywordHit, true)

  const synced = await api['/watch/sync']!({ lang: 'zh', id: saved.id }) as { board: { columns: { handle: Array<{ source: string }> } } }
  assert.ok(synced.board.columns.handle.some(c => c.source === 'watch'))

  const removed = await api['/watch/delete']!({ lang: 'zh', id: saved.id }) as { view: { watches: unknown[] } }
  assert.equal(removed.view.watches.length, 0)
  await assert.rejects(async () => api['/watch/sync']!({ lang: 'zh', id: saved.id }), (e: Error) => e.message.includes('没有'))
})
