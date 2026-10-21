import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderBrief } from '../src/core/brief.ts'
import { addSeries, describeSeries, resolveSeries, stopSeries, tickManual, upcoming } from '../src/core/manual.ts'
import { setStatusByUser } from '../src/core/matters.ts'
import { MishuStore } from '../src/core/store.ts'
import { dayOf } from '../src/core/time.ts'
import { addApproval } from '../src/dsh/tools.ts'
import { DEFAULT_LEAD_DAYS } from '../src/core/recur.ts'
import type { MishuError } from '../src/core/i18n.ts'
import { at } from './helpers.ts'

function tellAndTick(store: MishuStore, input: Parameters<typeof resolveSeries>[0], when: number) {
  const series = addSeries(store, resolveSeries(input), when)
  tickManual(store, dayOf(when), when)
  return series
}

test('acceptance: passport expiring 2027-03-10 starts reminding on 2026-12-10', () => {
  const store = MishuStore.open(':memory:')
  const series = tellAndTick(store, { title: '护照到期', due: '2027-03-10', category: 'document' }, at('2026-10-21'))
  assert.equal(series.leadDays, 90)
  assert.equal(store.openMatters().length, 0, 'not on the list in October')
  assert.equal(upcoming(store, '2026-10-21', 200)[0]?.remind, '2026-12-10')

  assert.equal(tickManual(store, '2026-12-09', at('2026-12-09')).length, 0)
  const created = tickManual(store, '2026-12-10', at('2026-12-10'))
  assert.equal(created.length, 1)
  assert.equal(created[0]!.dueDay, '2027-03-10')
  assert.equal(store.seriesById(series.id)!.active, false, 'a one-off is used up once it is on the list')
  assert.equal(tickManual(store, '2026-12-11', at('2026-12-11')).length, 0, 'idempotent')
})

test('acceptance: rent on the 15th appears on the 12th, closes when paid, and comes back next month', () => {
  const store = MishuStore.open(':memory:')
  tellAndTick(store, { title: '交房租', due: '2026-11-15', repeat: 'monthly', category: 'bill' }, at('2026-10-21'))
  assert.equal(store.openMatters().length, 0)

  tickManual(store, '2026-11-11', at('2026-11-11'))
  assert.equal(store.openMatters().length, 0)
  tickManual(store, '2026-11-12', at('2026-11-12'))
  const [november] = store.openMatters()
  assert.equal(november?.dueDay, '2026-11-15')

  setStatusByUser(store, november!.id, 'done', at('2026-11-14'))
  assert.equal(store.openMatters().length, 0, '"交了" closes this month')

  tickManual(store, '2026-12-11', at('2026-12-11'))
  assert.equal(store.openMatters().length, 0)
  tickManual(store, '2026-12-12', at('2026-12-12'))
  assert.deepEqual(store.openMatters().map(m => m.dueDay), ['2026-12-15'])
})

test('an unpaid month stays on the list as overdue next to the new one', () => {
  const store = MishuStore.open(':memory:')
  tellAndTick(store, { title: '交房租', due: '2026-11-15', repeat: 'monthly', category: 'bill' }, at('2026-10-21'))
  tickManual(store, '2026-12-12', at('2026-12-12'))
  assert.deepEqual(store.openMatters().map(m => m.dueDay), ['2026-11-15', '2026-12-15'])
  assert.match(renderBrief(store, { now: at('2026-12-12'), lang: 'zh' }), /交房租 · 2026-11-15（周日）到期，已过 27 天 ⚠/)
  assert.match(renderBrief(store, { now: at('2026-12-12'), lang: 'en' }), /To handle \(2\)\n#1 \[Noted·Bill\] 交房租 · 2026-11-15 \(Sun\) due, 27 days overdue ⚠/)
})

test('something already due is on the list at once', () => {
  const store = MishuStore.open(':memory:')
  tellAndTick(store, { title: '交物业费', due: '2026-10-22', category: 'bill' }, at('2026-10-21'))
  assert.deepEqual(store.openMatters().map(m => m.title), ['交物业费'])
})

test('a stopped series stops', () => {
  const store = MishuStore.open(':memory:')
  const series = tellAndTick(store, { title: '交房租', due: '2026-11-15', repeat: 'monthly', category: 'bill' }, at('2026-10-21'))
  stopSeries(store, series.id, at('2026-10-22'))
  tickManual(store, '2026-11-12', at('2026-11-12'))
  assert.equal(store.openMatters().length, 0)
})

test('bad input is refused with a reason, before anything is saved', () => {
  assert.throws(() => resolveSeries({ title: '交房租', due: '下个月初' }), (e: MishuError) => /不是有效的日期/.test(e.text.zh) && /not a valid date/.test(e.message))
  assert.throws(() => resolveSeries({ title: '', due: '2026-11-15' }), (e: MishuError) => /空的/.test(e.text.zh))
  assert.throws(() => resolveSeries({ title: 'x', due: '2026-11-15', leadDays: -1 }), (e: MishuError) => /lead days/.test(e.message))
})

test('the approval card shows what was understood', () => {
  const card = addApproval({ title: '护照到期', due: '2027-03-10', category: 'document' }, DEFAULT_LEAD_DAYS, at('2026-10-21'))
  assert.equal(card?.zh, [
    '小秘书要记下这件事，请核对：',
    '事项：护照到期',
    '类别：证件',
    '日期：2027-03-10（周三，140 天后）',
    '提醒：提前 90 天（从 2026-12-10 开始出现在待处理里）',
  ].join('\n'))
  assert.equal(card?.en, [
    'The secretary will note this. Please check:',
    'Item: 护照到期',
    'Category: Document',
    'Date: 2027-03-10 (Wed, in 140 days)',
    'Reminder: 90 days ahead (on the list from 2026-12-10)',
  ].join('\n'))
  const rent = addApproval({ title: '交房租', due: '2026-11-15', repeat: 'monthly', category: 'bill', note: '转给房东' }, DEFAULT_LEAD_DAYS, at('2026-10-21'))!
  assert.match(rent.zh, /重复：每月 15 日；下一次 2026-11-15（周日，25 天后）/)
  assert.match(rent.zh, /提前 3 天（从 2026-11-12 开始/)
  assert.match(rent.zh, /备注：转给房东/)
  assert.match(rent.en, /Repeats: monthly on day 15; next 2026-11-15 \(Sun, in 25 days\)/)
  assert.equal(addApproval({ title: 'x', due: 'soon' }, DEFAULT_LEAD_DAYS, at('2026-10-21')), undefined)
  assert.match(describeSeries(resolveSeries({ title: '旧账单', due: '2026-10-01' }), '2026-10-21', 'zh'), /已经过去了/)
  assert.match(describeSeries(resolveSeries({ title: 'Old bill', due: '2026-10-01' }), '2026-10-21', 'en'), /this date has passed/)
})
