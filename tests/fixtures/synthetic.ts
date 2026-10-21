/**
 * A made-up GitHub account for the committed tests.
 *
 * Every repo, login, title and URL here is invented (example-org, upstream-org,
 * demo-*). It reproduces the situations the rules must handle — a fork running
 * its parent's schedules, old release tags superseded by green runs, failures
 * that recovered, a deleted branch, a feature branch still red, a bot comment
 * on a commit, PRs and issues in every state — in the exact response shapes
 * the client reads. Real recordings stay in tests/fixtures/local/ and are
 * never committed.
 */

import type { Fixture } from '../helpers.ts'

/** 2026-10-21 09:00 in Asia/Shanghai. */
export const SYNTHETIC_NOW = Date.UTC(2026, 9, 21, 1, 0)

const API = 'https://api.github.com'
const WEB = 'https://github.com'
const hoursAgo = (h: number) => new Date(SYNTHETIC_NOW - h * 3_600_000).toISOString()

let nextId = 1000
const responses: Fixture['responses'] = {}
const reply = (url: string, body: unknown, status = 200, link: string | null = null) => {
  responses[`GET ${url}`] = { status, link, body: JSON.stringify(body) }
}

// ── repositories ───────────────────────────────────────────

function repo(name: string, parent?: string) {
  const [owner] = name.split('/')
  reply(`${API}/repos/${name}`, {
    full_name: name, fork: parent !== undefined, default_branch: 'main', html_url: `${WEB}/${name}`, owner: { login: owner },
    ...parent === undefined ? {} : { parent: { full_name: parent, default_branch: 'main', owner: { login: parent.split('/')[0] } } },
  })
}

type Run = { name: string; ref: string; conclusion: 'success' | 'failure'; hours: number; id?: number }

function runs(name: string, list: Run[]) {
  const sorted = [...list].sort((a, b) => a.hours - b.hours)
  reply(`${API}/repos/${name}/actions/runs?per_page=100`, {
    workflow_runs: sorted.map((r) => {
      const id = r.id ?? nextId++
      // Every failed run can say where it failed: job "test", step "Run tests".
      if (r.conclusion === 'failure') {
        reply(`${API}/repos/${name}/actions/runs/${id}/jobs?per_page=50`, {
          jobs: [{
            name: 'test', conclusion: 'failure', html_url: `${WEB}/${name}/actions/runs/${id}/job/${id}1`,
            steps: [{ name: 'Set up job', conclusion: 'success', number: 1 }, { name: 'Run tests', conclusion: 'failure', number: 2 }],
          }],
        })
      }
      return {
        id, name: r.name, head_branch: r.ref, status: 'completed', conclusion: r.conclusion,
        created_at: hoursAgo(r.hours), html_url: `${WEB}/${name}/actions/runs/${id}`, event: 'push',
      }
    }),
  })
}

// ── notifications ──────────────────────────────────────────

const notifications: unknown[] = []

function notify(type: string, name: string, title: string, reason: string, hours: number, url: string | null = null, comment: string | null = null) {
  notifications.push({
    id: String(nextId++), unread: true, reason, updated_at: hoursAgo(hours), last_read_at: null,
    subject: { title, url, latest_comment_url: comment, type },
    repository: { full_name: name, html_url: `${WEB}/${name}`, fork: false },
  })
}

const ci = (name: string, workflow: string, ref: string, hours: number) =>
  notify('CheckSuite', name, `${workflow} workflow run failed for ${ref} branch`, 'ci_activity', hours)

// 1. A fork with no commits of its own, failing its parent's scheduled workflows.
repo('example-org/demo-fork', 'upstream-org/demo-list')
reply(`${API}/repos/example-org/demo-fork/compare/${encodeURIComponent('upstream-org:main')}...main`, { ahead_by: 0 })
runs('example-org/demo-fork', [
  { name: 'Nightly report', ref: 'main', conclusion: 'failure', hours: 10 },
  { name: 'Nightly report', ref: 'main', conclusion: 'failure', hours: 34 },
  { name: 'Nightly report', ref: 'main', conclusion: 'failure', hours: 58 },
  { name: 'Link checker', ref: 'main', conclusion: 'failure', hours: 20 },
  { name: 'Link checker', ref: 'main', conclusion: 'failure', hours: 44 },
  { name: 'Label sync', ref: 'main', conclusion: 'failure', hours: 30 },
])
ci('example-org/demo-fork', 'Nightly report', 'main', 10)
ci('example-org/demo-fork', 'Nightly report', 'main', 34)
ci('example-org/demo-fork', 'Nightly report', 'main', 58)
ci('example-org/demo-fork', 'Link checker', 'main', 20)
ci('example-org/demo-fork', 'Link checker', 'main', 44)
ci('example-org/demo-fork', 'Label sync', 'main', 30)

// 2. Old release tags failed; main failed twice and then passed.
repo('example-org/demo-lib')
runs('example-org/demo-lib', [
  { name: 'ci', ref: 'v1.0.0', conclusion: 'failure', hours: 200 },
  { name: 'ci', ref: 'v1.1.0', conclusion: 'failure', hours: 150 },
  { name: 'ci', ref: 'v1.2.0', conclusion: 'failure', hours: 100 },
  { name: 'ci', ref: 'main', conclusion: 'failure', hours: 90 },
  { name: 'ci', ref: 'main', conclusion: 'failure', hours: 60 },
  { name: 'ci', ref: 'main', conclusion: 'success', hours: 30 },
])
ci('example-org/demo-lib', 'ci', 'v1.0.0', 200)
ci('example-org/demo-lib', 'ci', 'v1.1.0', 150)
ci('example-org/demo-lib', 'ci', 'v1.2.0', 100)
ci('example-org/demo-lib', 'ci', 'main', 90)
ci('example-org/demo-lib', 'ci', 'main', 60)

// 3. A release tag superseded by a newer tag.
repo('example-org/demo-cli')
runs('example-org/demo-cli', [
  { name: 'Release', ref: 'v3.0.0', conclusion: 'failure', hours: 120 },
  { name: 'Release', ref: 'v3.1.0', conclusion: 'success', hours: 20 },
])
ci('example-org/demo-cli', 'Release', 'v3.0.0', 120)

// 4. Failed, then passed on the same branch.
repo('example-org/demo-bundle')
runs('example-org/demo-bundle', [
  { name: 'bundle', ref: 'main', conclusion: 'failure', hours: 50 },
  { name: 'bundle', ref: 'main', conclusion: 'success', hours: 10 },
])
ci('example-org/demo-bundle', 'bundle', 'main', 50)

// 5. A deleted branch; a live feature branch still red even though main passed;
//    and a bot comment on a commit that links a failed run which later passed.
repo('example-org/demo-app')
runs('example-org/demo-app', [
  { name: 'e2e', ref: 'feature-x', conclusion: 'failure', hours: 80 },
  { name: 'e2e', ref: 'feature-y', conclusion: 'failure', hours: 40 },
  { name: 'e2e', ref: 'main', conclusion: 'success', hours: 5 },
  { name: 'unit', ref: 'main', conclusion: 'failure', hours: 70, id: 9001 },
  { name: 'unit', ref: 'main', conclusion: 'success', hours: 35 },
])
reply(`${API}/repos/example-org/demo-app/branches/feature-x`, { message: 'Branch not found' }, 404)
reply(`${API}/repos/example-org/demo-app/git/ref/tags/feature-x`, { message: 'Not Found' }, 404)
reply(`${API}/repos/example-org/demo-app/branches/feature-y`, { name: 'feature-y' })
ci('example-org/demo-app', 'e2e', 'feature-x', 80)
ci('example-org/demo-app', 'e2e', 'feature-y', 40)
ci('example-org/demo-app', 'unit', 'main', 70)
const commitUrl = `${API}/repos/example-org/demo-app/commits/0123456789abcdef0123456789abcdef01234567`
const commentUrl = `${API}/repos/example-org/demo-app/comments/555`
reply(commitUrl, { sha: '0123456789abcdef0123456789abcdef01234567', html_url: `${WEB}/example-org/demo-app/commit/0123456` })
reply(commentUrl, {
  body: `Unit tests failed: ${WEB}/example-org/demo-app/actions/runs/9001\n`,
  html_url: `${WEB}/example-org/demo-app/commit/0123456#commitcomment-555`,
  created_at: hoursAgo(70),
  user: { login: 'github-actions[bot]', type: 'Bot' },
})
reply(`${API}/repos/example-org/demo-app/actions/runs/9001`, {
  id: 9001, name: 'unit', head_branch: 'main', status: 'completed', conclusion: 'failure',
  created_at: hoursAgo(70), html_url: `${WEB}/example-org/demo-app/actions/runs/9001`, event: 'push',
})
notify('Commit', 'example-org/demo-app', 'Release 1.4.0', 'author', 69, commitUrl, commentUrl)

// 6. A repo whose main has been red for months.
repo('example-org/demo-stale')
runs('example-org/demo-stale', [
  { name: 'CI', ref: 'main', conclusion: 'failure', hours: 1400 },
  { name: 'CI', ref: 'main', conclusion: 'failure', hours: 1390 },
])
ci('example-org/demo-stale', 'CI', 'main', 1400)
ci('example-org/demo-stale', 'CI', 'main', 1390)

// 7. Pull requests and issues in every state.
function pull(number: number, state: 'open' | 'closed', merged: boolean, reason: string, hours: number, comment?: { id: number; login: string; body: string }) {
  const url = `${API}/repos/upstream-org/demo-list/pulls/${number}`
  reply(url, {
    state, merged, merged_at: merged ? hoursAgo(hours) : null, closed_at: state === 'closed' ? hoursAgo(hours) : null,
    html_url: `${WEB}/upstream-org/demo-list/pull/${number}`, number,
    user: { login: 'carol-dev' }, draft: false, changed_files: 3, additions: 42, deletions: 7,
  })
  const commentUrl = comment === undefined ? url : `${API}/repos/upstream-org/demo-list/issues/comments/${comment.id}`
  if (comment !== undefined) {
    reply(commentUrl, { body: comment.body, html_url: `${WEB}/upstream-org/demo-list/pull/${number}#issuecomment-${comment.id}`, created_at: hoursAgo(hours), user: { login: comment.login, type: 'User' } })
  }
  notify('PullRequest', 'upstream-org/demo-list', `Add entry #${number}`, reason, hours, url, commentUrl)
}
pull(101, 'closed', true, 'author', 300)
pull(102, 'closed', true, 'author', 100)
pull(103, 'closed', false, 'author', 90)
pull(104, 'open', false, 'review_requested', 3, { id: 701, login: 'carol-dev', body: 'Could you check the **new parser**? It replaces the old regex.' })

function issue(number: number, state: 'open' | 'closed', reason: string, hours: number, comment?: { id: number; login: string; body: string }) {
  const url = `${API}/repos/example-org/demo-lib/issues/${number}`
  reply(url, {
    state, state_reason: state === 'closed' ? 'completed' : null, closed_at: state === 'closed' ? hoursAgo(hours) : null,
    html_url: `${WEB}/example-org/demo-lib/issues/${number}`, number, user: { login: 'bob-dev' },
  })
  const commentUrl = comment === undefined ? url : `${API}/repos/example-org/demo-lib/issues/comments/${comment.id}`
  if (comment !== undefined) {
    reply(commentUrl, { body: comment.body, html_url: `${WEB}/example-org/demo-lib/issues/${number}#issuecomment-${comment.id}`, created_at: hoursAgo(hours), user: { login: comment.login, type: 'User' } })
  }
  notify('Issue', 'example-org/demo-lib', `Issue #${number}`, reason, hours, url, commentUrl)
}
issue(7, 'closed', 'comment', 40, { id: 801, login: 'bob-dev', body: 'Fixed in 1.2.0, closing.' })
issue(8, 'open', 'mention', 2, { id: 702, login: 'bob-dev', body: '@demo-user can you confirm the fix works on Windows?' })

// 8. Kinds the rules only note or hand to you.
notify('Release', 'example-org/demo-lib', 'v2.0.0', 'subscribed', 12, `${API}/repos/example-org/demo-lib/releases/1`)
notify('Discussion', 'example-org/demo-lib', 'Roadmap ideas', 'comment', 6)

// Two pages, so pagination is exercised.
const page2 = `${API}/notifications?per_page=50&page=2`
reply(`${API}/notifications?per_page=50`, notifications.slice(0, 15), 200, `<${page2}>; rel="next"`)
reply(page2, notifications.slice(15))

export const SYNTHETIC: Fixture = { recordedAt: SYNTHETIC_NOW, responses }

/** Every notification in the made-up account. */
export const SYNTHETIC_NOTIFICATIONS = notifications.length
