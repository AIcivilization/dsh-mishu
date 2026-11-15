import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BoardCard, MatterDetail } from '../src/core/board.ts'
import { cardText } from '../src/client/cardText.ts'

// The "copy" button on an unfolded card copies what the card shows, as plain
// text: no markup, no labels the page does not use, nothing hidden.

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 12,
    target: 'matter',
    source: 'github',
    title: 'example-org/demo-app · e2e 在 feature-y 上失败',
    meta: '10-21 08:00 通知 · 失败在 e2e',
    note: null,
    url: 'https://github.com/example-org/demo-app/actions/runs/1',
    tone: 'danger',
    actions: ['open', 'done', 'snooze', 'dismiss'],
    explain: {
      what: '一次 CI 失败。',
      why: 'e2e 这一步失败了。',
      fix: '打开日志看是哪条用例。',
      link: { label: '看失败日志', url: 'https://github.com/example-org/demo-app/actions/runs/1' },
    },
    ...over,
  }
}

const detail: MatterDetail = {
  id: 12,
  title: 'example-org/demo-app · e2e 在 feature-y 上失败',
  status: 'open',
  reason: 'CI 还是红的',
  explain: null,
  did: ['GitHub 上没有改动。'],
  messages: [
    { title: 'e2e failed on feature-y', at: '10-21 08:00', why: null },
    { title: 'e2e failed on feature-y', at: '10-21 07:30', why: null },
  ],
}

test('a card to handle copies its title, what it is, the problem, what to do and the link', () => {
  const text = cardText(card(), detail, 'handle', 'zh')
  assert.equal(text, [
    'example-org/demo-app · e2e 在 feature-y 上失败',
    '10-21 08:00 通知 · 失败在 e2e',
    '',
    '是什么：一次 CI 失败。',
    '问题在哪：e2e 这一步失败了。',
    '怎么办：打开日志看是哪条用例。',
    '链接：https://github.com/example-org/demo-app/actions/runs/1',
    '',
    '小秘书做了什么：',
    '- GitHub 上没有改动。',
    '',
    '来自这 2 条通知：',
    '- 10-21 08:00 e2e failed on feature-y',
    '- 10-21 07:30 e2e failed on feature-y',
  ].join('\n'))
})

test('the same card in English uses English labels and no full-width colon', () => {
  const text = cardText(card(), detail, 'handle', 'en')
  assert.match(text, /^example-org\/demo-app/)
  assert.match(text, /\nWhat: 一次 CI 失败。/)
  assert.match(text, /\nWhat to do: 打开日志看是哪条用例。/)
  assert.match(text, /\nWhat the secretary did:\n- GitHub 上没有改动。/)
})

test('a snoozed card says why it is being kept, not what the problem is', () => {
  const text = cardText(card({ url: null, explain: { what: '交房租', why: '11-19 到期。', fix: null } }), undefined, 'remember', 'zh')
  assert.match(text, /情况：11-19 到期。/)
  assert.doesNotMatch(text, /问题在哪/)
  assert.doesNotMatch(text, /链接/, 'no link means no empty line for it')
})

test('a closed card tells the story the detail gives, and still lists what was done', () => {
  const closed = card({
    title: 'example-org/demo-lib#8 Issue #8',
    explain: { what: '一个 issue。', why: '你在 10-20 标了完成。', fix: '不该做的事' },
  })
  const text = cardText(closed, {
    ...detail,
    status: 'done',
    explain: { what: '一个 issue。', why: '别人已经关闭了它。', fix: null },
    did: ['10-20 这些通知已经被看过。'],
  }, 'done', 'zh')
  assert.match(text, /为什么关掉：别人已经关闭了它。/)
  assert.doesNotMatch(text, /不该做的事/, 'a closed card has no "what to do"')
  assert.match(text, /- 10-20 这些通知已经被看过。/)
})

test('a card without an explanation falls back to its note or link, never to an empty label', () => {
  const bare = card({ explain: null, note: '备注一句话', url: 'https://example.test/x' })
  const text = cardText(bare, undefined, 'handle', 'zh')
  assert.equal(text, [
    'example-org/demo-app · e2e 在 feature-y 上失败',
    '10-21 08:00 通知 · 失败在 e2e',
    '',
    '备注：备注一句话',
  ].join('\n'))

  const linked = card({ explain: null, note: null })
  assert.match(cardText(linked, undefined, 'handle', 'zh'), /\n链接：https:\/\/github\.com\/example-org\/demo-app\/actions\/runs\/1$/)
})

test('a thing you told the secretary copies without the detail fetch', () => {
  const series = card({
    target: 'series',
    source: 'manual',
    title: '交房租',
    meta: '2026-11-19 到期 · 11-16 提醒 · 每月 19 日',
    url: null,
    tone: 'normal',
    actions: ['stop'],
    explain: { what: '你交代的账单：交房租', why: '2026-11-19 到期，还没到提醒的时候。', fix: null },
  })
  const text = cardText(series, undefined, 'remember', 'zh')
  assert.equal(text, [
    '交房租',
    '2026-11-19 到期 · 11-16 提醒 · 每月 19 日',
    '',
    '是什么：你交代的账单：交房租',
    '情况：2026-11-19 到期，还没到提醒的时候。',
  ].join('\n'))
})

test('a closed card copies before its detail arrives, and never says what to do', () => {
  const closed = card({ title: 'example-org/demo-lib#8 Issue #8', explain: { what: '一个 issue。', why: '你在 10-20 标了完成。', fix: '去回复一句' } })
  const text = cardText(closed, undefined, 'done', 'zh')
  assert.match(text, /为什么关掉：你在 10-20 标了完成。/)
  assert.doesNotMatch(text, /去回复一句/)
})
