import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBoard } from '../src/core/board.ts'
import { GitHubClient } from '../src/core/github/client.ts'
import { syncGithub } from '../src/core/github/sync.ts'
import { addSeries, resolveSeries, tickManual } from '../src/core/manual.ts'
import { snoozeByUser } from '../src/core/matters.ts'
import { MishuStore } from '../src/core/store.ts'
import { dayOf } from '../src/core/time.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { SYNTHETIC } from './fixtures/synthetic.ts'
import { at, replayFetch } from './helpers.ts'

const NOW = SYNTHETIC.recordedAt
const GITHUB = { enabled: true, markRead: 'shadow' as const }

async function seeded() {
  const store = MishuStore.open(':memory:')
  await syncGithub({ store, gh: new GitHubClient({ token: 't', fetch: replayFetch(SYNTHETIC).fetch }), now: NOW, markRead: 'shadow', markReadReasons: ['merged', 'closed', 'recovered', 'superseded', 'ref-gone'] })
  const today = dayOf(NOW)
  addSeries(store, resolveSeries({ title: '交房租', due: '2026-10-19', repeat: 'monthly', category: 'bill' }), NOW)
  addSeries(store, resolveSeries({ title: '护照到期', due: '2027-03-10', category: 'document' }), NOW)
  addSeries(store, resolveSeries({ title: '交物业费', due: '2026-10-25', category: 'bill' }), NOW)
  tickManual(store, today, NOW)
  return store
}

test('the board splits matters into to handle, keeping and done for you', async () => {
  const store = await seeded()
  const board = buildBoard(store, { now: NOW, lang: 'zh', github: GITHUB })

  assert.deepEqual(board.columns.handle.map(c => c.title), [
    '交房租',
    'upstream-org/demo-list#104 Add entry #104',
    'example-org/demo-lib#8 Issue #8',
    'example-org/demo-app · e2e 在 feature-y 上失败',
    'example-org/demo-stale · CI 在 main 上失败',
    '关掉 fork example-org/demo-fork 的 Actions（或删掉这个 fork）',
    'example-org/demo-lib · Roadmap ideas',
  ])
  const rent = board.columns.handle[0]!
  assert.equal(rent.tone, 'danger')
  assert.match(rent.meta, /10-19 到期 · 已过 2 天/)
  assert.deepEqual(rent.actions, ['done', 'snooze', 'dismiss'])
  assert.deepEqual(board.columns.handle[5]!.actions, ['open', 'done', 'snooze', 'dismiss'])

  // The rent's next month, the passport and the property fee are kept for later.
  assert.deepEqual(board.columns.remember.map(c => [c.target, c.title]), [
    ['series', '交物业费'], ['series', '交房租'], ['series', '护照到期'],
  ])
  assert.match(board.columns.remember[1]!.meta, /2026-11-19 到期 · 11-16 提醒 · 每月 19 日/)

  assert.equal(board.columns.done.total, 13)
  assert.deepEqual(board.columns.done.groups.map(g => [g.label, g.items.length]), [
    ['已被取代', 4], ['已恢复', 3], ['已关闭', 2], ['已合并', 2], ['只是通知', 1], ['分支已删除', 1],
  ])
  assert.deepEqual(board.metrics, { handle: 7, overdue: 1, dueSoon: 1, closedToday: 13, shadow: 14 })
  assert.equal(board.summary, '有 7 件要你处理，其中 1 件已经过期，先看「交房租」。今天替你关掉了 13 件，理由都在右栏。')
  assert.equal(board.sources.github.state, 'ok')
})

test('a snoozed matter moves to "keeping" and comes back on its day', async () => {
  const store = await seeded()
  const fork = store.matterByKey('gh:fork-actions:example-org/demo-fork')!
  snoozeByUser(store, fork.id, '2026-10-22', NOW)
  let board = buildBoard(store, { now: NOW, lang: 'en', github: GITHUB })
  assert.equal(board.columns.handle.length, 6)
  assert.equal(board.columns.remember[0]!.title, 'Turn off Actions on fork example-org/demo-fork (or delete the fork)')
  assert.equal(board.columns.remember[0]!.meta, 'snoozed · back 10-22')
  assert.deepEqual(board.columns.remember[0]!.actions, ['unsnooze', 'done'])
  board = buildBoard(store, { now: at('2026-10-22'), lang: 'en', github: GITHUB })
  assert.ok(board.columns.handle.some(c => c.id === fork.id), 'back on the list on the 22nd')
  assert.match(board.summary, /^\d+ to handle/)
})

test('the API answers with the fresh board and explains failures in the caller\'s language', async () => {
  const store = await seeded()
  const api = apiHandlers({ store: () => store, config: Config({ language: 'auto' }), fixedLang: undefined, sync: async () => {}, now: () => NOW })
  const first = await api['/board']!({ lang: 'zh-CN' }) as { board: { columns: { handle: Array<{ id: number }> } } }
  const id = first.board.columns.handle[0]!.id

  const done = await api['/action']!({ lang: 'en', target: 'matter', id, action: 'done' }) as { board: { lang: string; columns: { handle: unknown[]; done: { groups: Array<{ reason: string }> } } } }
  assert.equal(done.board.lang, 'en')
  assert.equal(done.board.columns.handle.length, 6)
  assert.ok(done.board.columns.done.groups.some(g => g.reason === 'done-by-you'))

  const preview = await api['/preview']!({ lang: 'en', item: { title: 'Gym', due: '2026-10-26', repeat: 'weekly' } }) as { text: string }
  assert.match(preview.text, /Repeats: every Mon; next 2026-10-26/)
  await assert.rejects(api['/preview']!({ lang: 'zh', item: { title: 'x', due: '下周' } }), /not a valid date/)

  const added = await api['/add']!({ lang: 'zh', item: { title: '健身', due: '2026-10-26', repeat: 'weekly' } }) as { id: number; board: { columns: { remember: Array<{ title: string }> } } }
  assert.ok(added.board.columns.remember.some(c => c.title === '健身'))
  await assert.rejects(api['/action']!({ target: 'matter', id: 9999, action: 'done' }), /9999/)
})

test('a notebook from 0.1 (schema 1) gains snooze on open and keeps its matters', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 'mishu-v1-'))
  const path = join(dir, 'mishu.db')
  try {
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE matters (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, source TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, note TEXT, url TEXT, status TEXT NOT NULL, reason TEXT, closed_by TEXT, due_day TEXT, remind_day TEXT,
      series_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER, activity_at INTEGER, override_at INTEGER);
      INSERT INTO matters (key, source, kind, title, status, created_at, updated_at) VALUES ('gh:x', 'github', 'ci', 'old one', 'open', 1, 1);
      PRAGMA user_version = 1;`)
    old.close()
    const store = MishuStore.open(path)
    const matter = store.matterByKey('gh:x')!
    assert.equal(matter.snoozeUntil, null)
    snoozeByUser(store, matter.id, '2026-10-22', NOW)
    assert.equal(store.matterByKey('gh:x')!.snoozeUntil, '2026-10-22')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
