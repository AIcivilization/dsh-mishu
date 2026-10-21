import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REASON_LABELS, renderBrief, renderClosed } from '../src/core/brief.ts'
import { GitHubClient, type Notification } from '../src/core/github/client.ts'
import { findRunLink, parseCheckSuiteTitle, type Facts } from '../src/core/github/facts.ts'
import { judge } from '../src/core/github/rules.ts'
import { syncGithub } from '../src/core/github/sync.ts'
import { decode } from '../src/core/i18n.ts'
import { setStatusByUser } from '../src/core/matters.ts'
import { MishuStore } from '../src/core/store.ts'
import { SYNTHETIC, SYNTHETIC_NOTIFICATIONS } from './fixtures/synthetic.ts'
import { fixtureNotifications, localFixtures, replayFetch, type Fixture } from './helpers.ts'

const NOW = SYNTHETIC.recordedAt
const READ_REASONS = ['merged', 'closed', 'recovered', 'superseded', 'ref-gone']

async function syncFixture(store: MishuStore, markRead: 'off' | 'shadow' | 'on' = 'shadow', overrides: Record<string, unknown> = {}, now = NOW, fixture: Fixture = SYNTHETIC) {
  const replay = replayFetch(fixture, overrides)
  const report = await syncGithub({ store, gh: new GitHubClient({ token: 't', fetch: replay.fetch }), now, markRead, markReadReasons: READ_REASONS })
  return { report, requests: replay.requests }
}

const titles = (matters: Array<{ title: string }>, lang: 'zh' | 'en' = 'en') => matters.map(m => decode(m.title, lang)).sort()

test('a made-up account: 27 notifications fold into 19 items, and only the 6 that need you stay open', async () => {
  const store = MishuStore.open(':memory:')
  const { report, requests } = await syncFixture(store)
  assert.equal(report.notifications, SYNTHETIC_NOTIFICATIONS)
  assert.equal(report.notifications, 27)
  assert.equal(report.checkFailures, 0)
  assert.equal(report.apiCalls, 34, 'one runs request per repo, not per notification')
  assert.ok(requests.every(r => r.startsWith('GET ')), 'shadow mode only reads')

  const open = store.openMatters()
  assert.deepEqual(open.map(m => m.reason).sort(), ['ci-failing', 'ci-failing', 'fork-upstream-schedule', 'mentioned', 'review-requested', 'unclassified'])
  const fork = store.matterByKey('gh:fork-actions:example-org/demo-fork')!
  assert.equal(decode(fork.title, 'zh'), '关掉 fork example-org/demo-fork 的 Actions（或删掉这个 fork）')
  assert.match(decode(fork.note!, 'zh'), /它是 upstream-org\/demo-list 的 fork，没有自己的提交.*最近 7 天失败了 6 次/)
  assert.equal(store.messagesOfMatter(fork.key).length, 6, 'six notices, one thing to do')
  assert.match(decode(store.matterByKey('gh:ci:example-org/demo-stale:CI@main')!.note!, 'en'), /latest run on main \(08-24\) still fails/)
  // A live feature branch is not "fixed" by a green main.
  assert.equal(store.matterByKey('gh:ci:example-org/demo-app:e2e@feature-y')!.reason, 'ci-failing')

  const closed = store.closedSince(0)
  assert.equal(closed.length, 13)
  assert.ok(closed.every(m => m.closedBy === 'rule'))
  const byReason = (reason: string) => titles(closed.filter(m => m.reason === reason))
  assert.deepEqual(byReason('superseded'), [
    'example-org/demo-cli · Release failing on v3.0.0',
    'example-org/demo-lib · ci failing on v1.0.0',
    'example-org/demo-lib · ci failing on v1.1.0',
    'example-org/demo-lib · ci failing on v1.2.0',
  ])
  assert.deepEqual(byReason('recovered'), [
    'example-org/demo-app · unit failing on main',
    'example-org/demo-bundle · bundle failing on main',
    'example-org/demo-lib · ci failing on main',
  ])
  assert.deepEqual(byReason('merged'), ['upstream-org/demo-list#101 Add entry #101', 'upstream-org/demo-list#102 Add entry #102'])
  assert.deepEqual(byReason('closed'), ['example-org/demo-lib#7 Issue #7', 'upstream-org/demo-list#103 Add entry #103'])
  assert.deepEqual(byReason('ref-gone'), ['example-org/demo-app · e2e failing on feature-x'])
  assert.deepEqual(byReason('info-release'), ['example-org/demo-lib released v2.0.0'])
})

test('the bot comment on a commit joins the CI item of the run it links to', async () => {
  const store = MishuStore.open(':memory:')
  await syncFixture(store)
  const commit = fixtureNotifications(SYNTHETIC).find(n => n.subject.type === 'Commit')!
  const message = store.messageById(commit.id)!
  assert.equal(message.matterKey, 'gh:ci:example-org/demo-app:unit@main')
  assert.equal(message.verdictReason, 'recovered')
  assert.equal(store.messagesOfMatter(message.matterKey).length, 2)
})

test('shadow mode records what it would mark read; on mode marks exactly those', async () => {
  const shadow = MishuStore.open(':memory:')
  const { report } = await syncFixture(shadow, 'shadow')
  assert.equal(report.markedRead, 0)
  assert.equal(report.wouldMarkRead, 14)
  const fork = shadow.matterByKey('gh:fork-actions:example-org/demo-fork')!
  assert.ok(shadow.messagesOfMatter(fork.key).every(m => !m.wouldMarkRead), 'open items are never marked read')

  const live = MishuStore.open(':memory:')
  const on = await syncFixture(live, 'on')
  assert.equal(on.requests.filter(r => r.startsWith('PATCH ')).length, 14)
  assert.equal(on.report.markedRead, 14)

  const off = MishuStore.open(':memory:')
  assert.equal((await syncFixture(off, 'off')).report.wouldMarkRead, 0)
})

test('reopening a rule-closed item counts as a correction and holds until new activity', async () => {
  const store = MishuStore.open(':memory:')
  await syncFixture(store)
  const merged = store.closedSince(0).find(m => m.reason === 'merged')!
  const change = setStatusByUser(store, merged.id, 'open', NOW + 1000)!
  assert.equal(change.corrected, 'merged')
  assert.deepEqual(store.ruleStats().find(s => s.reason === 'merged'), { reason: 'merged', fired: 2, corrected: 1 })
  await syncFixture(store, 'shadow', {}, NOW + 2000)
  assert.equal(store.matterById(merged.id)!.status, 'open', 'your decision stands against the same evidence')
})

test('a rule corrected too often is demoted and hands its items to you', async () => {
  const store = MishuStore.open(':memory:')
  for (let i = 0; i < 10; i++) store.bumpRule('merged', 'fired')
  for (let i = 0; i < 3; i++) store.bumpRule('merged', 'corrected')
  await syncFixture(store)
  const prs = store.openMatters().filter(m => m.kind === 'pr' && m.reason === 'merged')
  assert.equal(prs.length, 2)
  assert.match(decode(prs[0]!.note!, 'zh'), /已降级/)
  assert.match(decode(prs[0]!.note!, 'en'), /demoted/)
})

test('threads read elsewhere close their items on the next sync', async () => {
  const store = MishuStore.open(':memory:')
  await syncFixture(store)
  const pages = Object.keys(SYNTHETIC.responses).filter(k => k.startsWith('GET https://api.github.com/notifications'))
  const { report } = await syncFixture(store, 'shadow', Object.fromEntries(pages.map(k => [k, []])), NOW + 60_000)
  assert.equal(report.notifications, 0)
  assert.equal(store.openMatters().length, 0)
  assert.equal(store.matterByKey('gh:fork-actions:example-org/demo-fork')!.reason, 'read-on-github')
})

test('the brief lists what is open, counts closures by reason, and reports the shadow run, in both languages', async () => {
  const store = MishuStore.open(':memory:')
  await syncFixture(store)
  const zh = renderBrief(store, { now: NOW + 60_000, lang: 'zh', github: { enabled: true, markRead: 'shadow' } })
  assert.match(zh, /要处理（6）/)
  assert.match(zh, /最近 24 小时替你关掉 13 件：已被取代 4、已恢复 3、已关闭 2、已合并 2、只是通知 1、分支已删除 1。/)
  assert.match(zh, /影子模式：如果打开自动标已读，会把 GitHub 上 14 条/)
  assert.match(zh, /27 条未读通知，用了 34 次 API/)
  assert.match(renderClosed(store, NOW + 60_000, 'zh'), /规则关闭 · 分支已删除：feature-x 这个分支或 tag 已经删了/)
  const en = renderBrief(store, { now: NOW + 60_000, lang: 'en', github: { enabled: true, markRead: 'shadow' } })
  assert.match(en, /To handle \(6\)\n#\d+ \[GitHub\] upstream-org\/demo-list#104 Add entry #104\n    review requested/)
  assert.match(en, /Closed for you in the last 24 hours: 13 \(superseded 4, recovered 3, closed 2, merged 2, just a notice 1, branch deleted 1\)/)
  assert.match(en, /27 unread notifications, 34 API calls\./)
  assert.match(renderClosed(store, NOW + 60_000, 'en'), /closed by a rule · branch deleted: feature-x \(branch or tag\) has been deleted/)
})

test('a failed notifications request is reported, not thrown', async () => {
  const store = MishuStore.open(':memory:')
  const fetch = async () => ({ status: 401, headers: { get: () => null }, text: async () => '{"message":"Bad credentials"}' })
  const report = await syncGithub({ store, gh: new GitHubClient({ token: 'x', fetch }), now: NOW, markRead: 'shadow', markReadReasons: READ_REASONS })
  assert.match(report.error!.en, /401: Bad credentials/)
  assert.match(renderBrief(store, { now: NOW, lang: 'zh', github: { enabled: true, markRead: 'shadow' } }), /同步失败：GitHub 401/)
  assert.match(renderBrief(store, { now: NOW, lang: 'en', github: { enabled: true, markRead: 'shadow' } }), /sync failed at .*: GitHub 401/)
})

test('every open item says what it is, where the problem is and what to do', async () => {
  const store = MishuStore.open(':memory:')
  await syncFixture(store)
  const explain = (key: string) => JSON.parse(store.matterByKey(key)!.explain!) as { what: { zh: string; en: string }; why: { zh: string; en: string }; fix: { zh: string; en: string } | null; link?: { label: { zh: string; en: string }; url: string } }

  const stale = explain('gh:ci:example-org/demo-stale:CI@main')
  assert.equal(stale.what.zh, 'example-org/demo-stale 的「CI」工作流，在 main 上')
  assert.equal(stale.why.zh, '最近一次运行（08-24）失败了，失败在 job「test」的「Run tests」这一步。能看到的 2 次记录里一次都没成功过。')
  assert.match(stale.fix!.zh, /^这个仓库最近一周没有再跑过：如果还在维护/)
  assert.equal(stale.link!.label.zh, '看失败日志')
  assert.match(stale.link!.url, /\/job\//, 'the link goes to the failing job, not just the repo')
  assert.equal(stale.why.en, 'The latest run (08-24) failed; it fails in job "test", step "Run tests". It has not passed in any of the 2 runs on record.')

  const fork = explain('gh:fork-actions:example-org/demo-fork')
  assert.match(fork.why.zh, /（Label sync \/ Link checker \/ Nightly report）/)
  assert.match(fork.fix!.zh, /Settings → Actions → General，选「Disable actions」/)
  assert.equal(fork.link!.label.en, 'Turn off Actions')

  const review = explain('gh:pr:upstream-org/demo-list#104')
  assert.equal(review.what.zh, 'upstream-org/demo-list 的 PR #104「Add entry #104」，作者 carol-dev')
  assert.match(review.why.zh, /有人请你审查这个 PR，改了 3 个文件（\+42 \/ -7），正在等你。最新的评论：carol-dev（10-21）：「Could you check the new parser\? It replaces the old regex\.」/)
  assert.equal(review.link!.label.zh, '去审查')

  const mention = explain('gh:issue:example-org/demo-lib#8')
  assert.match(mention.why.en, /Someone mentioned you in this issue\. Latest comment: bob-dev \(10-21\): "@demo-user can you confirm the fix works on Windows\?"/)

  const superseded = explain('gh:ci:example-org/demo-lib:ci@v1.0.0')
  assert.match(superseded.why.zh, /^v1\.0\.0 是旧版本的 tag，tag 不会再重跑；之后的 main 在 10-20 已经通过/)
  assert.equal(superseded.fix, null)
})

// Real recordings, only where they exist (tests/fixtures/local/, ignored by git).
// They are someone's own account, so the checks are general, never names.
for (const { name, fixture } of localFixtures()) {
  test(`local recording ${name}: every notification is judged and every closure has a known reason`, async () => {
    const store = MishuStore.open(':memory:')
    const { report, requests } = await syncFixture(store, 'shadow', {}, fixture.recordedAt, fixture)
    assert.equal(report.error, undefined)
    assert.equal(report.notifications, fixtureNotifications(fixture).length)
    assert.equal(report.checkFailures, 0)
    assert.ok(requests.every(r => r.startsWith('GET ')))
    for (const m of [...store.openMatters(), ...store.closedSince(0)]) assert.ok(m.reason !== null && m.reason in REASON_LABELS, `${m.key}: ${m.reason}`)
  })
}

// ── rules on hand-written facts ─────────────────────────

function notification(type: string, title: string, reason = 'ci_activity', url: string | null = null): Notification {
  return {
    id: '1', unread: true, reason, updated_at: '2026-10-20T00:00:00Z', last_read_at: null,
    subject: { title, url, latest_comment_url: null, type },
    repository: { full_name: 'o/r', html_url: 'https://github.com/o/r', fork: false },
  }
}

const repo = { fullName: 'o/r', fork: false, defaultBranch: 'main' }
const run = (ref: string, conclusion: string, day: number) => ({ id: day, ref, conclusion, at: Date.UTC(2026, 9, day), url: `u${day}` })

test('CheckSuite titles parse, including non-ASCII workflow names', () => {
  assert.deepEqual(parseCheckSuiteTitle('兼容性检查 workflow run failed for main branch'), { workflow: '兼容性检查', outcome: 'failed', ref: 'main' })
  assert.equal(parseCheckSuiteTitle('something else'), undefined)
  assert.deepEqual(findRunLink('failed: https://github.com/o/r/actions/runs/36660264295\n'), { repo: 'o/r', id: 36660264295 })
})

test('a feature branch is not superseded by main; a release tag is', () => {
  const n = notification('CheckSuite', 'CI workflow run failed for feature-x branch')
  const branch: Facts = { repo, ci: { workflow: 'CI', ref: 'feature-x', failedAt: 0, recentFailures: 1, repoFailures: 1, latestSameRef: run('feature-x', 'failure', 1), newerElsewhere: run('main', 'success', 5), refExists: true } }
  assert.equal(judge(n, branch).reason, 'ci-failing')
  const tag: Facts = { repo, ci: { workflow: 'CI', ref: 'v1.2.0', failedAt: 0, recentFailures: 1, repoFailures: 1, latestSameRef: run('v1.2.0', 'failure', 1), newerElsewhere: run('main', 'success', 5) } }
  assert.equal(judge(n, tag).reason, 'superseded')
  const tagByTag: Facts = { repo, ci: { workflow: 'CI', ref: 'v1.2.0', failedAt: 0, recentFailures: 1, repoFailures: 1, newerElsewhere: run('v1.3.0', 'success', 5) } }
  assert.equal(judge(n, tagByTag).reason, 'superseded')
  const mainStillRed: Facts = { repo, ci: { workflow: 'CI', ref: 'main', failedAt: 0, recentFailures: 3, repoFailures: 3, latestSameRef: run('main', 'failure', 4), newerElsewhere: run('feature-x', 'success', 5) } }
  const verdict = judge(n, mainStillRed)
  assert.equal(verdict.reason, 'ci-failing')
  assert.match(verdict.note!.zh, /最近 7 天失败了 3 次/)
  assert.match(verdict.note!.en, /3 failures in the last 7 days/)
})

test('open PRs and issues keep why they need you', () => {
  const pr = notification('PullRequest', 'Fix it', 'review_requested', 'https://api.github.com/repos/o/r/pulls/7')
  assert.equal(judge(pr, { pull: { state: 'open', merged: false, merged_at: null, html_url: 'h', number: 7 } }).reason, 'review-requested')
  assert.equal(judge(pr, { pull: { state: 'closed', merged: false, merged_at: null, html_url: 'h', number: 7 } }).reason, 'closed')
  const issue = notification('Issue', 'Bug', 'mention', 'https://api.github.com/repos/o/r/issues/3')
  assert.equal(judge(issue, { issue: { state: 'open', html_url: 'h', number: 3 } }).reason, 'mentioned')
  assert.equal(judge(notification('Discussion', 'Q', 'comment'), {}).reason, 'unclassified')
  assert.equal(judge(pr, { error: 'timeout' }).reason, 'check-failed')
})
