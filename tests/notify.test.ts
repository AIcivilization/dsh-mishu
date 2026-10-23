import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { buildBoard } from '../src/core/board.ts'
import { DesktopChannel, FeishuChannel, saveFeishu, type JsonPost } from '../src/core/channels.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { encode, bi } from '../src/core/i18n.ts'
import { inQuiet, localClock, notifySettings, notifyTick, saveNotifySettings, type Channel, type Message } from '../src/core/notify.ts'
import { MishuStore } from '../src/core/store.ts'

/** 2026-10-22 08:00 in Shanghai (tests run in that zone). */
const MORNING = Date.parse('2026-10-22T08:00:00+08:00')
const at = (hhmm: string, day = '2026-10-22') => Date.parse(`${day}T${hhmm}:00+08:00`)

function recorder(id: Channel['id'] = 'desktop', fail = false) {
  const sent: Message[] = []
  const channel: Channel = {
    id,
    status: async () => ({ available: true }),
    send: async (message) => {
      if (fail) throw new Error('bot removed')
      sent.push(message)
    },
  }
  return { channel, sent }
}

function seeded() {
  const store = MishuStore.open(':memory:')
  store.insertMatter({ key: 'gh:pr:1', source: 'github', kind: 'pr', title: encode(bi('看一下新解析器', 'Look at the new parser')), status: 'open', reason: 'review-requested' }, MORNING - 3_600_000)
  store.insertMatter({ key: 'gh:ci:1', source: 'github', kind: 'ci', title: encode(bi('CI 失败', 'CI failed')), status: 'open', reason: 'ci-failing' }, MORNING - 3_600_000)
  return store
}

const tick = (store: MishuStore, now: number, channels: Channel[]) =>
  notifyTick({ store, now, lang: 'zh', channels, board: () => buildBoard(store, { now, lang: 'zh', github: { enabled: true, markRead: 'shadow' } }) })

test('clock and quiet hours: read in your time zone, quiet hours may cross midnight', () => {
  assert.deepEqual(localClock(Date.parse('2026-10-22T01:30:00Z'), 'Asia/Shanghai'), { day: '2026-10-22', minutes: 9 * 60 + 30 })
  assert.deepEqual(localClock(Date.parse('2026-10-22T01:30:00Z'), 'America/Los_Angeles'), { day: '2026-10-21', minutes: 18 * 60 + 30 })
  const quiet = { enabled: true, from: '22:00', to: '08:00' }
  assert.equal(inQuiet(23 * 60, quiet), true)
  assert.equal(inQuiet(7 * 60 + 59, quiet), true)
  assert.equal(inQuiet(8 * 60, quiet), false)
  assert.equal(inQuiet(12 * 60, { enabled: true, from: '12:00', to: '13:30' }), true)
  assert.equal(inQuiet(23 * 60, { ...quiet, enabled: false }), false)
})

test('turning reminders on does not resend what is already there; new urgent items are sent once', async () => {
  const store = seeded()
  saveNotifySettings(store, { timeZone: 'Asia/Shanghai', brief: { enabled: false, time: '09:00' } }, MORNING)
  const { channel, sent } = recorder()
  assert.deepEqual(await tick(store, MORNING, [channel]), [], 'first look only takes note')

  store.insertMatter({ key: 'gh:issue:8', source: 'github', kind: 'issue', title: encode(bi('能确认 Windows 上修好了吗', 'Can you confirm the fix on Windows')), status: 'open', reason: 'mentioned' }, MORNING + 60_000)
  store.insertMatter({ key: 'gh:ci:2', source: 'github', kind: 'ci', title: encode(bi('又一个 CI 失败', 'Another CI failure')), status: 'open', reason: 'ci-failing' }, MORNING + 60_000)
  const [report] = await tick(store, MORNING + 120_000, [channel])
  assert.equal(report!.count, 1, 'a failing CI waits for the brief; a mention does not')
  assert.equal(sent[0]!.title, '小秘书：1 件急事')
  assert.match(sent[0]!.text, /^小秘书：1 件急事\n• 能确认 Windows 上修好了吗（.+）\n打开小秘书看板处理。$/)
  assert.deepEqual(await tick(store, MORNING + 180_000, [channel]), [], 'sent once')
})

test('quiet hours hold urgent items until they end; the brief goes out once a day at its time', async () => {
  const store = seeded()
  saveNotifySettings(store, { timeZone: 'Asia/Shanghai' }, MORNING)
  const { channel, sent } = recorder()
  await tick(store, at('07:00'), [channel])

  store.insertMatter({ key: 'manual:rent', source: 'manual', kind: 'bill', title: encode(bi('交房租', 'Pay rent')), status: 'open', reason: 'manual', dueDay: '2026-10-22' }, at('07:10'))
  assert.deepEqual(await tick(store, at('07:30'), [channel]), [], 'still quiet before 08:00')
  const [urgent] = await tick(store, at('08:00'), [channel])
  assert.equal(urgent!.kind, 'urgent')
  assert.match(sent[0]!.text, /• 交房租（2026-10-22 到期）/)

  assert.deepEqual(await tick(store, at('08:59'), [channel]), [])
  const [brief] = await tick(store, at('09:00'), [channel])
  assert.equal(brief!.kind, 'brief')
  assert.equal(sent[1]!.title, '小秘书 · 今日简报')
  assert.match(sent[1]!.text, /要你处理：\n• /)
  assert.deepEqual(await tick(store, at('15:00'), [channel]), [], 'one brief a day')
  assert.equal((await tick(store, at('09:00', '2026-10-23'), [channel]))[0]?.kind, 'brief', 'and again tomorrow')
})

test('one channel failing does not stop the others, and the last result is kept for the page', async () => {
  const store = seeded()
  saveNotifySettings(store, { timeZone: 'Asia/Shanghai', brief: { enabled: false, time: '09:00' } }, MORNING)
  const good = recorder('desktop')
  const broken = recorder('feishu', true)
  await tick(store, MORNING, [good.channel, broken.channel])
  store.insertMatter({ key: 'gh:pr:2', source: 'github', kind: 'pr', title: encode(bi('请你 review', 'Review please')), status: 'open', reason: 'review-requested' }, MORNING + 60_000)
  const [report] = await tick(store, MORNING + 120_000, [good.channel, broken.channel])
  assert.deepEqual(report!.results, [{ channel: 'desktop', ok: true }, { channel: 'feishu', ok: false, error: 'bot removed' }])
  assert.equal(good.sent.length, 1)
  assert.deepEqual(store.get('notify.last'), report)
})

test('reminder settings are checked before they are kept', () => {
  const store = MishuStore.open(':memory:')
  assert.equal(notifySettings(store).brief.time, '09:00')
  assert.throws(() => saveNotifySettings(store, { brief: { enabled: true, time: '9:00' } }, MORNING), /08:30/)
  assert.throws(() => saveNotifySettings(store, { timeZone: 'Mars/Base' }, MORNING), /Unknown time zone/)
  const saved = saveNotifySettings(store, { quiet: { enabled: false, from: '23:00', to: '07:00' }, channels: { desktop: false, feishu: true } }, MORNING)
  assert.deepEqual(saved.channels, { desktop: false, feishu: true })
  assert.equal(notifySettings(store).quiet.from, '23:00')
})

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d-example'

function feishu(answer: Record<string, unknown> = { code: 0, msg: 'success' }) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  const post: JsonPost = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return { status: 200, text: async () => JSON.stringify(answer) }
  }
  return { post, posts }
}

test('a Feishu bot is tried with a first message before it is kept; its refusals are said plainly', async () => {
  const secrets = new MemorySecrets()
  await assert.rejects(saveFeishu(secrets, { webhook: 'https://example.com/hook' }, 'zh'), /not a Feishu bot address/)

  const keyword = feishu({ code: 19024, msg: 'Key Words Not Found' })
  await assert.rejects(saveFeishu(secrets, { webhook: HOOK }, 'zh', keyword.post), /keyword to "小秘书"/)
  assert.equal(await secrets.get('feishu:webhook'), undefined, 'nothing kept from a failed try')

  const ok = feishu()
  await saveFeishu(secrets, { webhook: ` ${HOOK} `, secret: 'sign-secret' }, 'zh', ok.post)
  const first = ok.posts[0]!
  assert.equal(first.url, HOOK)
  assert.deepEqual(first.body.content, { text: '小秘书已经连上这个群，以后的提醒会发到这里。' })
  const expected = createHmac('sha256', `${first.body.timestamp}\nsign-secret`).update('').digest('base64')
  assert.equal(first.body.sign, expected, 'signed the way Feishu checks it')
  assert.equal(await secrets.get('feishu:webhook'), HOOK)

  const later = feishu()
  await new FeishuChannel(secrets, later.post).send({ kind: 'urgent', title: 't', body: 'b', text: '小秘书：1 件急事' })
  assert.deepEqual(later.posts[0]!.body.content, { text: '小秘书：1 件急事' })
  assert.deepEqual(await new FeishuChannel(new MemorySecrets()).status(), { available: false, why: bi('还没填飞书机器人的地址。', 'No Feishu bot address yet.') })
})

test('a server without a desktop says it cannot show notifications', async () => {
  const status = await new DesktopChannel('linux', {}).status()
  assert.equal(status.available, false)
  assert.match(status.available ? '' : status.why.zh, /没有桌面.*用飞书就行/)
})
