import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAsk, detailText } from '../src/core/ask.ts'
import { GitHubClient } from '../src/core/github/client.ts'
import { syncGithub } from '../src/core/github/sync.ts'
import { addSeries, resolveSeries, tickManual } from '../src/core/manual.ts'
import { snoozeByUser } from '../src/core/matters.ts'
import { syncMail } from '../src/core/mail/sync.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { MishuStore } from '../src/core/store.ts'
import { dayOf } from '../src/core/time.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'
import { SYNTHETIC } from './fixtures/synthetic.ts'
import { ACCOUNT } from './fixtures/synthetic-mail.ts'
import { replayFetch } from './helpers.ts'

const NOW = SYNTHETIC.recordedAt

async function seeded() {
  const store = MishuStore.open(':memory:')
  await syncGithub({ store, gh: new GitHubClient({ token: 't', fetch: replayFetch(SYNTHETIC).fetch }), now: NOW, markRead: 'shadow', markReadReasons: ['merged', 'closed', 'recovered', 'superseded', 'ref-gone'] })
  addSeries(store, resolveSeries({ title: '交房租', due: '2026-10-19', repeat: 'monthly', category: 'bill', note: '转给房东' }), NOW)
  addSeries(store, resolveSeries({ title: '护照到期', due: '2027-03-10', category: 'document' }), NOW)
  tickManual(store, dayOf(NOW), NOW)
  return store
}

const opts = (lang: 'zh' | 'en') => ({ now: NOW, lang, markRead: 'shadow' as const, accounts: [ACCOUNT] })

test('+AI on an item to handle asks how to deal with it, with everything the card knows', async () => {
  const store = await seeded()
  const stale = store.matterByKey('gh:ci:example-org/demo-stale:CI@main')!
  const prompt = buildAsk(store, { kind: 'matter', id: stale.id }, opts('zh'))
  assert.match(prompt, /^我在小秘书看板的"要你处理"里看到下面这件事，帮我弄明白它是怎么回事、我该怎么处理：/)
  assert.ok(prompt.includes(`【#${stale.id}】example-org/demo-stale · CI 在 main 上失败`))
  assert.match(prompt, /问题在哪：最近一次运行（08-24）失败了，失败在 job「test」的「Run tests」这一步/)
  assert.match(prompt, /小秘书的建议：这个仓库最近一周没有再跑过/)
  assert.match(prompt, /链接：https:\/\/github\.com\/example-org\/demo-stale\/actions\/runs\/\d+\/job\//)
  assert.match(prompt, /相关通知（2 条）：\n- \d\d-\d\d \d\d:\d\d CI workflow run failed for main branch/)
  assert.ok(prompt.endsWith(`（你可以用 mishu_detail 工具查 #${stale.id} 的完整记录，用 mishu_list 看整个看板。要改状态的话先问我，我同意了再用 mishu_update。）`))
  const en = buildAsk(store, { kind: 'matter', id: stale.id }, opts('en'))
  assert.match(en, /^This item is under "To handle" on my secretary board\./)
  assert.match(en, /The problem: The latest run \(08-24\) failed/)
})

test('+AI asks the right question for closed and snoozed items and for things you told it', async () => {
  const store = await seeded()
  const superseded = store.matterByKey('gh:ci:example-org/demo-lib:ci@v1.0.0')!
  const closed = buildAsk(store, { kind: 'matter', id: superseded.id }, opts('zh'))
  assert.match(closed, /^小秘书把下面这件事关掉了，帮我看看它的判断对不对、我还需不需要做什么：/)
  assert.match(closed, /为什么关掉：v1\.0\.0 是旧版本的 tag/)
  assert.match(closed, /小秘书做了什么：.*小秘书按上面的理由，在自己的清单里把它关掉了。GitHub 上没有改动。影子模式：打开自动标已读后，会把其中 1 条通知标成已读。/)

  const fork = store.matterByKey('gh:fork-actions:example-org/demo-fork')!
  snoozeByUser(store, fork.id, '2026-10-23', NOW)
  assert.match(buildAsk(store, { kind: 'matter', id: fork.id }, opts('zh')), /^下面这件事我说过"明天再说"/)

  const passport = store.activeSeries().find(s => s.title === '护照到期')!
  const series = buildAsk(store, { kind: 'series', id: passport.id }, opts('zh'))
  assert.match(series, /^这是我交代给小秘书的一件事，帮我看看需要提前准备什么/)
  assert.match(series, /下一次到期：2027-03-10（2026-12-10 开始提醒）/)
  assert.throws(() => buildAsk(store, { kind: 'matter', id: 9999 }, opts('en')), /that item no longer exists/)
})

test('+AI on the summary lists what needs you, in order', async () => {
  const store = await seeded()
  const prompt = buildAsk(store, { kind: 'summary' }, opts('zh'))
  assert.match(prompt, /^这是小秘书看板上现在要我处理的 7 件事。帮我排个先后/)
  const rent = prompt.split('\n').find(l => l.includes('交房租'))!
  assert.match(rent, /^- #\d+ 交房租（2026-10-19 到期）：2026-10-19（周一）到期，已经过了 2 天。备注：转给房东。/)
  assert.ok(prompt.indexOf('交房租') < prompt.indexOf('demo-fork'), 'overdue things you told it come first')
  const empty = MishuStore.open(':memory:')
  assert.match(buildAsk(empty, { kind: 'summary' }, opts('en')), /^My secretary board has nothing for me to handle right now/)
})

test('+AI on a mail error explains the setup but never carries the password', async () => {
  const store = MishuStore.open(':memory:')
  const secrets = new MemorySecrets()
  const password = 'never-in-a-prompt-123'
  await secrets.set('mail:1', password)
  const failing = { unread: async () => { throw Object.assign(new Error('fail'), { responseText: 'AUTHENTICATIONFAILED' }) } }
  await syncMail({ store, account: ACCOUNT, fetcher: failing, password, now: NOW })
  const prompt = buildAsk(store, { kind: 'mail-error', accountId: ACCOUNT.id }, opts('zh'))
  assert.match(prompt, /^小秘书收我的邮箱时出错了，帮我弄明白是什么原因、怎么解决（我不会把密码发给你）：/)
  assert.match(prompt, /IMAP 服务器：imap\.gmail\.com:993（SSL\/TLS）\n用户名：me@example\.com\n报错：登录失败/)
  assert.ok(!prompt.includes(password))

  const setup = buildAsk(store, { kind: 'mail-setup', preset: 'qq' }, opts('zh'))
  assert.match(setup, /^我想让小秘书只读地查看我的「QQ 邮箱」收件箱/)
  assert.match(setup, /IMAP 服务器：imap\.qq\.com:993/)

  store.set('github.lastSync', { at: NOW, notifications: 0, opened: 0, closed: 0, wouldMarkRead: 0, markedRead: 0, checkFailures: 0, apiCalls: 1, error: { zh: 'GitHub 401: Bad credentials', en: 'GitHub 401: Bad credentials' } })
  assert.match(buildAsk(store, { kind: 'github-error' }, opts('en')), /Error: GitHub 401: Bad credentials/)
})

test('the API serves +AI text and the agent can look up an item in full', async () => {
  const store = await seeded()
  const runtime = new Runtime(Config({ github: { enabled: false } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  runtime.store = store
  const api = apiHandlers(runtime, () => NOW)
  const fork = store.matterByKey('gh:fork-actions:example-org/demo-fork')!
  const asked = await api['/ask']!({ lang: 'en', ask: { kind: 'matter', id: fork.id } }) as { prompt: string }
  assert.match(asked.prompt, /Turn off Actions on fork example-org\/demo-fork/)
  await assert.rejects(api['/ask']!({ lang: 'en', ask: { kind: 'shell' } }), /Unknown question/)

  const detail = detailText(store, fork.id, { now: NOW, lang: 'zh', markRead: 'shadow' })!
  assert.ok(detail.startsWith(`【#${fork.id}】关掉 fork example-org/demo-fork 的 Actions（或删掉这个 fork）`))
  assert.match(detail, /相关通知（6 条）/)
})
