import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkRule, describeRepeat, occurrence, remindDay } from '../src/core/recur.ts'
import { addDays, addMonths, daysBetween, parseDay, relativeDay, weekday } from '../src/core/time.ts'

test('parseDay rejects days that do not exist', () => {
  assert.deepEqual(parseDay('2027-03-10'), { y: 2027, m: 3, d: 10 })
  assert.equal(parseDay('2026-02-29'), undefined)
  assert.equal(parseDay('2028-02-29')?.d, 29)
  assert.equal(parseDay('2026-13-01'), undefined)
  assert.equal(parseDay('下个月初'), undefined)
})

test('month arithmetic clamps to month end without drifting', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31')
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28')
  assert.equal(addMonths('2026-11-15', 2), '2027-01-15')
})

test('day differences and words', () => {
  assert.equal(daysBetween('2026-12-10', '2027-03-10'), 90)
  assert.equal(addDays('2027-03-10', -90), '2026-12-10')
  assert.equal(relativeDay('2026-10-21', '2026-10-21', 'zh'), '今天')
  assert.equal(relativeDay('2026-10-15', '2026-10-21', 'zh'), '已过 6 天')
  assert.equal(relativeDay('2026-10-15', '2026-10-21', 'en'), '6 days ago')
  assert.equal(relativeDay('2026-10-24', '2026-10-21', 'en'), 'in 3 days')
  assert.equal(weekday('2027-03-10', 'zh'), '周三')
  assert.equal(weekday('2027-03-10', 'en'), 'Wed')
})

test('occurrences are computed from the first due day', () => {
  const rent = { firstDue: '2026-01-31', repeat: 'monthly' as const, every: 1 }
  assert.deepEqual([0, 1, 2, 3].map(k => occurrence(rent, k)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  const inspection = { firstDue: '2027-05-01', repeat: 'yearly' as const, every: 2 }
  assert.equal(occurrence(inspection, 1), '2029-05-01')
  const once = { firstDue: '2027-03-10', repeat: 'none' as const, every: 1 }
  assert.equal(occurrence(once, 0), '2027-03-10')
  assert.equal(occurrence(once, 1), undefined)
  assert.equal(remindDay('2026-11-15', 3), '2026-11-12')
})

test('rules are checked and described in plain words', () => {
  assert.match(checkRule({ firstDue: '2026-02-30', repeat: 'monthly', every: 1 })?.zh ?? '', /不是有效的日期/)
  assert.match(checkRule({ firstDue: '2026-02-30', repeat: 'monthly', every: 1 })?.en ?? '', /not a valid date/)
  assert.match(checkRule({ firstDue: '2026-11-15', repeat: 'none', every: 2 })?.zh ?? '', /不重复/)
  assert.equal(checkRule({ firstDue: '2026-11-15', repeat: 'monthly', every: 1 }), undefined)
  assert.equal(describeRepeat({ firstDue: '2026-11-15', repeat: 'monthly', every: 1 }, 'zh'), '每月 15 日')
  assert.equal(describeRepeat({ firstDue: '2026-11-15', repeat: 'monthly', every: 1 }, 'en'), 'monthly on day 15')
  assert.equal(describeRepeat({ firstDue: '2026-10-26', repeat: 'weekly', every: 1 }, 'zh'), '每周一')
  assert.equal(describeRepeat({ firstDue: '2026-10-26', repeat: 'weekly', every: 2 }, 'en'), 'every 2 weeks on Mon')
  assert.equal(describeRepeat({ firstDue: '2027-05-01', repeat: 'yearly', every: 2 }, 'zh'), '每 2 年 5 月 1 日')
  assert.equal(describeRepeat({ firstDue: '2027-05-01', repeat: 'yearly', every: 1 }, 'en'), 'yearly on May 1')
})
