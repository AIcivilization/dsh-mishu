import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { FetchLike, Notification } from '../src/core/github/client.ts'

export interface Fixture {
  recordedAt: number
  responses: Record<string, { status: number; link: string | null; body: string }>
}

/** Real recordings made with `npm run record`; they live only on this machine (git ignores the folder). */
export function localFixtures(): Array<{ name: string; fixture: Fixture }> {
  const dir = new URL('./fixtures/local/', import.meta.url)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(name => ({ name, fixture: JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as Fixture }))
}

/**
 * A fetch that answers from recorded responses and logs every request.
 * Unrecorded requests fail loudly; PATCH (mark read) answers 205 so the
 * "on" mode can be exercised without touching GitHub.
 */
export function replayFetch(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const requests: string[] = []
  const fetch: FetchLike = async (url, init) => {
    const key = `${init.method} ${url}`
    requests.push(key)
    if (key in overrides) {
      const body = JSON.stringify(overrides[key])
      return { status: 200, headers: { get: () => null }, text: async () => body }
    }
    if (init.method === 'PATCH') return { status: 205, headers: { get: () => null }, text: async () => '' }
    const hit = fixture.responses[key]
    if (hit === undefined) throw new Error(`no recorded response for ${key}`)
    return { status: hit.status, headers: { get: (name: string) => (name.toLowerCase() === 'link' ? hit.link : null) }, text: async () => hit.body }
  }
  return { fetch, requests }
}

/** All notifications in a fixture, across pages. */
export function fixtureNotifications(fixture: Fixture): Notification[] {
  return Object.entries(fixture.responses)
    .filter(([key]) => key.startsWith('GET https://api.github.com/notifications'))
    .flatMap(([, r]) => JSON.parse(r.body) as Notification[])
}

/** Local time on a given day, for tests (TZ is pinned to Asia/Shanghai by `npm test`). */
export function at(day: string, hour = 9): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d, hour).getTime()
}
