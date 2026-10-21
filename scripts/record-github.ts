/**
 * Record a real GitHub sync into a test fixture.
 *
 * Runs one sync with marking read OFF against a throwaway in-memory notebook,
 * and saves every GET response it needed. Only GET requests can happen in this
 * mode; the token is never written.
 *
 * The recording is real data from your own account (repo names, titles,
 * commit authors, private repos), so it goes to tests/fixtures/local/, which
 * git ignores. Never commit it; the committed tests use made-up data.
 *
 *   npm run record                     → tests/fixtures/local/github-YYYY-MM-DD.json
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GitHubClient, type FetchLike } from '../src/core/github/client.ts'
import { syncGithub } from '../src/core/github/sync.ts'
import { decode } from '../src/core/i18n.ts'
import { MishuStore } from '../src/core/store.ts'

const out = process.argv[2] ?? `tests/fixtures/local/github-${new Date().toISOString().slice(0, 10)}.json`
const token = process.env.GITHUB_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

const responses: Record<string, { status: number; link: string | null; body: string }> = {}
const recording: FetchLike = async (url, init) => {
  if (init.method !== 'GET') throw new Error(`recorder refuses ${init.method} ${url}`)
  const response = await fetch(url, init)
  const body = await response.text()
  responses[`GET ${url}`] = { status: response.status, link: response.headers.get('link'), body }
  return { status: response.status, headers: { get: (name: string) => response.headers.get(name) }, text: async () => body }
}

const now = Date.now()
const store = MishuStore.open(':memory:')
const report = await syncGithub({ store, gh: new GitHubClient({ token, fetch: recording }), now, markRead: 'off', markReadReasons: [] })
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ recordedAt: now, responses }, null, 1) + '\n')
console.log(`recorded ${Object.keys(responses).length} responses to ${out}`)
console.log(report)
for (const m of store.openMatters()) console.log(`OPEN  [${m.reason}] ${decode(m.title, 'en')} — ${decode(m.note, 'en') ?? ''}`)
for (const m of store.closedSince(0)) console.log(`DONE  [${m.reason}] ${decode(m.title, 'en')} — ${decode(m.note, 'en') ?? ''}`)
store.close()
