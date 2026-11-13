/**
 * When a message should leave by itself.
 *
 * A scheduled message is a draft that has an instant attached, so it is the
 * draft row that carries the time (no second table to keep in step). The
 * time must name its timezone: "09:00" means nothing without one, and
 * guessing on the user's behalf is how a mail goes out at the wrong hour.
 */

import { bi, MishuError } from '../i18n.ts'
import type { Draft, MishuStore } from '../store.ts'
import type { MailAccount } from './account.ts'

/** At least this far ahead — enough time to see the card and change your mind. */
const MIN_AHEAD_MS = 30_000
/** At most this far ahead, so a typo in the year cannot park mail forever. */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** The instant a scheduled message goes at, as epoch milliseconds. */
export function scheduledTime(value: unknown, now: number): number {
  if (typeof value !== 'string' || value.length > 40 || !ISO_WITH_ZONE.test(value)) {
    throw new MishuError(bi(
      '定时时间要带时区，例如 2026-11-20T09:00:00+08:00。',
      'a scheduled time needs its timezone, e.g. 2026-11-20T09:00:00+08:00.',
    ))
  }
  const at = Date.parse(value)
  if (!Number.isFinite(at)) {
    throw new MishuError(bi(`「${value}」不是一个时间。`, `"${value}" is not a time.`))
  }
  if (at < now + MIN_AHEAD_MS) {
    throw new MishuError(bi('定时发送至少要留在 30 秒以后。', 'a scheduled send must be at least 30 seconds ahead.'))
  }
  if (at > now + MAX_AHEAD_MS) {
    throw new MishuError(bi('定时发送最多排一年以内。', 'a scheduled send can be at most a year ahead.'))
  }
  return at
}

/** Whether a draft is waiting for its time. */
export function isScheduled(draft: Draft): boolean {
  return draft.state === 'scheduled' && draft.sendAt !== null
}

/**
 * Put a draft on the clock at `sendAt` (epoch ms). It must be the revision the
 * user was looking at, and still an unsent draft — a message already scheduled
 * is rescheduled rather than scheduled twice.
 */
export function scheduleDraft(store: MishuStore, account: MailAccount, id: string, revision: number, sendAt: number, now: number): Draft {
  const current = store.draftById(id)
  if (current === undefined || current.account !== account.id) throw new MishuError(bi('这封草稿已经不在了', 'this draft is gone'))
  if (current.state === 'sent') throw new MishuError(bi('这封草稿已经发出去了', 'this draft has already been sent'))
  if (current.state === 'sending') throw new MishuError(bi('这封草稿正在发，等它发完。', 'this draft is being sent right now; wait for it.'))
  if (current.revision !== revision) {
    throw new MishuError(bi(
      `这封草稿在别处改过了（现在是第 ${current.revision} 版），先刷新再定时。`,
      `this draft changed elsewhere (it is at revision ${current.revision}); refresh before scheduling it.`,
    ))
  }
  if (current.to.trim() === '' && current.cc.trim() === '' && current.bcc.trim() === '') {
    throw new MishuError(bi('这封草稿还没有收件人，定了时也发不出去。', 'this draft has no recipients; it would fail when its time came.'))
  }
  const next = store.updateDraft(id, revision, { state: 'scheduled', sendAt, error: null }, now)
  if (next === undefined) {
    throw new MishuError(bi('这封草稿刚被改过，先看看再定时。', 'this draft was just edited; look at it before scheduling.'))
  }
  return next
}

/** Take a draft off the clock; it goes back to being an ordinary draft. */
export function cancelSchedule(store: MishuStore, id: string, revision: number, now: number): Draft {
  const current = store.draftById(id)
  if (current === undefined) throw new MishuError(bi('这封草稿已经不在了', 'this draft is gone'))
  if (current.state !== 'scheduled') throw new MishuError(bi('这封草稿没有定时。', 'this draft is not scheduled.'))
  if (current.revision !== revision) {
    throw new MishuError(bi('这封草稿刚被改过，先看看再取消。', 'this draft was just edited; look at it before cancelling.'))
  }
  const next = store.updateDraft(id, revision, { state: 'draft', sendAt: null }, now)
  if (next === undefined) throw new MishuError(bi('这封草稿刚被改过，先看看再取消。', 'this draft was just edited; look at it before cancelling.'))
  return next
}

/** The scheduled drafts whose time has come, oldest first. */
export function dueDrafts(store: MishuStore, now: number): Draft[] {
  return store.dueDrafts(now)
}
