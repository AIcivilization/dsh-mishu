import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BRIEF_MARK, BRIEF_TASK_KEY, briefPrompt, briefTiming, briefTitle, clockText, describeTiming, instantText, isBriefTask,
  sortTasks, taskView, type ScheduleEntry,
} from '../src/core/schedule/tasks.ts'
import { MishuStore } from '../src/core/store.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'
import type { MishuError } from '../src/core/i18n.ts'
import { ScheduleBridge, type ScheduleLike } from '../src/dsh/schedule.ts'
import { MemorySecrets } from '../src/core/secrets.ts'

/** One task as the Schedule service hands it out. */
const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  id: 'schedule-1', kind: 'daily', title: '小秘书 · 每日简报', prompt: `${BRIEF_MARK}\nread the board`,
  time: '09:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-12T01:00:00.000Z', status: 'active',
  ...over,
})

test('a task reads as its rule, not as a cron string', () => {
  assert.equal(describeTiming(entry(), 'zh'), '每天 09:00')
  assert.equal(describeTiming(entry(), 'en'), 'daily at 09:00')
  assert.equal(describeTiming(entry({ kind: 'every', everySeconds: 900, time: undefined, timeZone: undefined }), 'zh'), '每 15 分钟')
  assert.equal(describeTiming(entry({ kind: 'every', everySeconds: 7200, time: undefined, timeZone: undefined }), 'en'), 'every 2 h')
  assert.equal(describeTiming(entry({ kind: 'after', afterSeconds: 600, time: undefined, timeZone: undefined }), 'zh'), '10 分钟后一次')
  assert.equal(describeTiming(entry({ kind: 'weekly', weekdays: [1, 4], time: '08:30:00.000' }), 'zh'), '每一、四 08:30')
  assert.equal(describeTiming(entry({ kind: 'weekly', weekdays: [1, 4], time: '08:30:00.000' }), 'en'), 'Mon, Thu at 08:30')
  assert.equal(describeTiming(entry({ kind: 'cron', expression: '0 9 * * *', time: undefined }), 'zh'), '按规则 0 9 * * *')
  assert.equal(describeTiming(entry({ kind: 'rrule', rrule: 'DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY', time: undefined }), 'en'), 'FREQ=DAILY')
  assert.match(describeTiming(entry({ kind: 'at', scheduledAt: '2026-11-12T01:00:00.000Z' }), 'zh'), /^只跑一次，11-12 09:00$/)
})

test('the brief rule is a daily clock time in an IANA zone, and the zone is never empty', () => {
  assert.deepEqual(briefTiming('08:30', 'Asia/Shanghai'), { time: '08:30:00.000', time_zone: 'Asia/Shanghai' })
  assert.equal(briefTiming('9:5', 'UTC').time, '08:30:00.000', 'a broken time falls back instead of sending nonsense')
  assert.notEqual(briefTiming('07:00', '').time_zone, '', 'no zone picked: this computer\'s, then UTC')
})

test('a task is recognised as the brief by id or by its mark, even after the title was edited', () => {
  assert.equal(isBriefTask(entry(), 'schedule-1'), true)
  assert.equal(isBriefTask(entry({ title: '早报' }), 'schedule-1'), true)
  assert.equal(isBriefTask(entry({ title: '早报' }), undefined), true, 'the mark survives losing the saved id')
  assert.equal(isBriefTask(entry({ prompt: 'do something else' }), undefined), false)
})

test('the task view carries the rule, the next run and whether it is still going', () => {
  const view = taskView(entry(), 'zh', 'schedule-1')
  assert.equal(view.mine, true)
  assert.equal(view.status, 'active')
  assert.equal(view.when, '每天 09:00')
  assert.match(view.next ?? '', /^11-12 09:00$/, 'same year: no year in front')
  assert.equal(view.prompt, 'read the board', 'the mark is not shown')
  assert.equal(taskView(entry({ status: 'ended' }), 'zh', undefined).next, null, 'an ended task has no next run')
  assert.equal(taskView(entry({ executionActive: true }), 'zh', undefined).running, true)
  const ended = taskView(entry({ status: 'ended', lastDelivery: { at: '2026-11-11T01:00:00.000Z' } }), 'zh', undefined)
  assert.match(ended.lastDelivery ?? '', /^11-11 09:00$/)
})

test('tasks read in the order you would act on them: running, paused, finished', () => {
  const sorted = sortTasks([
    taskView(entry({ id: 'c', title: 'C', status: 'ended' }), 'en', undefined),
    taskView(entry({ id: 'b', title: 'B', status: 'paused' }), 'en', undefined),
    taskView(entry({ id: 'a', title: 'A' }), 'en', undefined),
  ])
  assert.deepEqual(sorted.map(t => t.title), ['A', 'B', 'C'])
})

test('the brief prompt names the tool and forbids acting on your behalf', () => {
  assert.match(briefPrompt('zh'), /mishu_list/)
  assert.match(briefPrompt('zh'), /不要替我做事/)
  assert.match(briefPrompt('en'), /mishu_list/)
  assert.match(briefPrompt('en'), /do not act for me/)
  assert.ok(briefPrompt('zh').startsWith(BRIEF_MARK), 'the mark leads, so it survives trimming')
  assert.ok(briefTitle('zh').length <= 120, 'titles are capped at 120 characters')
})

test('clock and instant text survive values the service should never send', () => {
  assert.equal(clockText(undefined), '')
  assert.equal(clockText('09:05'), '09:05')
  assert.equal(clockText('nonsense'), 'nonsense')
  assert.equal(instantText(undefined, 'UTC', 'en'), '')
  assert.equal(instantText('not a date', 'UTC', 'en'), 'not a date')
})

/** A Schedule service that keeps tasks in a Map, so the bridge can be driven without a Host. */
function fakeSchedule(seed: ScheduleEntry[] = []) {
  const tasks = new Map<string, ScheduleEntry>(seed.map(t => [t.id, t]))
  const calls: string[] = []
  let nextId = 1
  const service: ScheduleLike = {
    async list() {
      calls.push('list')
      return { items: [...tasks.values()], shown: tasks.size, total: tasks.size }
    },
    async view({ id }) {
      calls.push(`view ${id}`)
      const task = tasks.get(id)
      return task ?? { id, code: 'schedule_not_found' }
    },
    async create(request) {
      calls.push('create')
      const id = `schedule-${nextId++}`
      const daily = (request.timing as { daily?: { time: string; time_zone: string } }).daily
      const task = entry({ id, title: request.title, prompt: request.prompt, time: daily?.time, timeZone: daily?.time_zone })
      tasks.set(id, task)
      return task
    },
    async edit(request) {
      calls.push(`edit ${request.action} ${request.id}`)
      const task = tasks.get(request.id)
      if (task === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (request.action === 'delete') {
        tasks.delete(request.id)
        return { id: request.id, deleted: true }
      }
      const patch = (request.patch ?? {}) as Partial<ScheduleEntry> & { timing?: { daily?: { time: string; time_zone: string } } }
      const daily = patch.timing?.daily
      const next = { ...task, ...patch, ...daily === undefined ? {} : { time: daily.time, timeZone: daily.time_zone } } as ScheduleEntry
      tasks.set(request.id, next)
      return next
    },
    async run({ id }) {
      calls.push(`run ${id}`)
      const task = tasks.get(id)
      return task ?? { id, code: 'schedule_not_found' }
    },
  }
  return { service, tasks, calls }
}

function setup(seed: ScheduleEntry[] = []) {
  const store = MishuStore.open(':memory:')
  const config = Config({ home: '/tmp/mishu-schedule-test', language: 'zh', github: { enabled: false } })
  const runtime = new Runtime(config, { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  runtime.store = store
  const fake = fakeSchedule(seed)
  const bridge = runtime.attachSchedule(fake.service)
  return { store, runtime, bridge, fake }
}

test('arming the brief creates one task, and arming again edits it instead of piling up', async () => {
  const { store, bridge, fake } = setup()
  const armed = await bridge.armBrief()
  assert.equal(armed.brief.armed, true)
  assert.equal(armed.brief.id, 'schedule-1')
  assert.equal(fake.tasks.size, 1)
  assert.equal(store.get<string>(BRIEF_TASK_KEY), 'schedule-1')
  const task = fake.tasks.get('schedule-1')!
  assert.equal(task.time, '09:00:00.000', 'the brief time is the reminder setting\'s')
  assert.equal(task.title, briefTitle('zh'))

  const again = await bridge.armBrief()
  assert.equal(again.brief.id, 'schedule-1')
  assert.equal(fake.tasks.size, 1, 'no second task')
  assert.ok(fake.calls.includes('edit update schedule-1'))
})

test('a task deleted in DSH\'s own page is recreated, not resurrected by a stale id', async () => {
  const { store, bridge, fake } = setup()
  await bridge.armBrief()
  fake.tasks.delete('schedule-1')
  const armed = await bridge.armBrief()
  assert.equal(fake.tasks.size, 1)
  assert.equal(armed.brief.armed, true)
  assert.notEqual(store.get<string>(BRIEF_TASK_KEY), 'schedule-1', 'the new id replaced the dead one')
})

test('disarming removes the task and leaves the reminder settings alone', async () => {
  const { store, bridge, fake } = setup()
  await bridge.armBrief()
  const after = await bridge.disarmBrief()
  assert.equal(fake.tasks.size, 0)
  assert.equal(after.brief.armed, false)
  assert.equal(store.get<string>(BRIEF_TASK_KEY), null)
  const again = await bridge.disarmBrief()
  assert.equal(again.brief.armed, false, 'disarming twice is not an error')
})

test('moving the brief time on the settings page moves the task, and only when it changed', async () => {
  const { store, bridge, fake } = setup()
  await bridge.armBrief()
  fake.calls.length = 0
  await bridge.followBrief()
  assert.deepEqual(fake.calls, ['view schedule-1'], 'same time: nothing written')

  store.set('notify.settings', { brief: { enabled: true, time: '07:15' } })
  await bridge.followBrief()
  assert.equal(fake.tasks.get('schedule-1')!.time, '07:15:00.000')
  assert.ok(fake.calls.includes('edit update schedule-1'))
})

test('a paused brief stays paused when its time changes', async () => {
  const { store, bridge, fake } = setup()
  await bridge.armBrief()
  fake.tasks.set('schedule-1', { ...fake.tasks.get('schedule-1')!, status: 'paused' })
  store.set('notify.settings', { brief: { enabled: true, time: '06:00' } })
  await bridge.followBrief()
  assert.equal(fake.tasks.get('schedule-1')!.time, '09:00:00.000', 'paused: the rule is not touched')
})

test('a failing service says so once, in the notebook, and the page shows it', async () => {
  const { store, bridge } = setup()
  const broken: ScheduleLike = {
    async list() { throw new Error('boom') },
    async view() { throw new Error('boom') },
    async create() { throw new Error('schedule says no') },
    async edit() { throw new Error('boom') },
    async run() { throw new Error('boom') },
  }
  bridge.replace(broken)
  const view = await bridge.view()
  assert.equal(view.available, true)
  assert.match(view.brief.error ?? '', /boom/)
  await assert.rejects(bridge.armBrief(), /schedule says no/)
  assert.match(store.get<string>('schedule.briefError') ?? '', /schedule says no/, 'kept for the next visit')
})

test('the settings endpoint shows the tasks, and says nothing is available when the Host has no service', async () => {
  const { runtime, fake } = setup([entry({ id: 'schedule-9', title: '早报', prompt: 'summarise the news', time: '08:00:00.000' })])
  const handlers = apiHandlers(runtime)
  const shown = await handlers['/settings']!({ lang: 'zh' }) as { view: { schedule: { tasks: Array<{ title: string; mine: boolean }> } } }
  assert.equal(shown.view.schedule.tasks.length, 1)
  assert.deepEqual(shown.view.schedule.tasks.map(t => t.title), ['早报'])
  assert.equal(shown.view.schedule.tasks[0]!.mine, false)

  const armed = await handlers['/schedule/brief/arm']!({ lang: 'zh' }) as { schedule: { brief: { armed: boolean } } }
  assert.equal(armed.schedule.brief.armed, true)
  assert.equal(fake.tasks.size, 2, 'the brief joins the tasks already there')

  runtime.schedule = undefined
  const bare = await handlers['/settings']!({ lang: 'zh' }) as { view: { schedule: unknown } }
  assert.equal(bare.view.schedule, null, 'no service: the page explains instead of offering buttons')
  await assert.rejects(handlers['/schedule/brief/arm']!({ lang: 'zh' }), /自动化任务服务/)
})

/** Both languages of what the secretary said, so a test can read either. */
const said = (e: unknown) => (e as MishuError).text

test('running a task that is already running, and deleting one twice, say so plainly', async () => {
  const { bridge, fake } = setup([entry({ id: 'schedule-5', title: 'x', prompt: 'y' })])
  const pending: ScheduleLike = { ...fake.service, async run({ id }) { return { id, code: 'schedule_execution_pending' } } }
  bridge.replace(pending)
  await assert.rejects(bridge.run('schedule-5'), (e: MishuError) => {
    assert.match(said(e).zh, /正在跑/)
    assert.match(said(e).en, /already running/)
    return true
  })

  bridge.replace(fake.service)
  await assert.rejects(bridge.run('schedule-missing'), (e: MishuError) => /已经不在了/.test(said(e).zh))
  await bridge.delete('schedule-5')
  await assert.rejects(bridge.delete('schedule-5'), (e: MishuError) => /已经不在了/.test(said(e).zh))
})
