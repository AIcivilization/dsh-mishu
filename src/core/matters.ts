/**
 * What you do to a matter by hand, and what the secretary learns from it.
 *
 * Reopening something a rule closed counts as a correction against that
 * rule. A rule whose corrections pass the threshold is demoted: its
 * conclusions stop closing matters and are shown to you instead.
 */

import type { Matter, MatterStatus, MishuStore } from './store.ts'

export interface DemotionPolicy {
  /** Rule closures needed before its error rate is trusted. */
  minFired: number
  /** Corrections / closures above which the rule is demoted. */
  maxErrorRate: number
}

export const DEFAULT_DEMOTION: DemotionPolicy = { minFired: 10, maxErrorRate: 0.2 }

export function isDemoted(store: MishuStore, reason: string, policy: DemotionPolicy = DEFAULT_DEMOTION): boolean {
  const stats = store.ruleStats().find(s => s.reason === reason)
  if (stats === undefined || stats.fired < policy.minFired) return false
  return stats.corrected / stats.fired > policy.maxErrorRate
}

export interface UserChange {
  matter: Matter
  previous: Matter
  /** Set when this undid a rule's or the source's conclusion. */
  corrected?: string
}

/** Mark done, dismiss or reopen a matter by hand. */
export function setStatusByUser(store: MishuStore, id: number, status: MatterStatus, now: number): UserChange | undefined {
  const previous = store.matterById(id)
  if (previous === undefined) return undefined
  if (previous.status === status) return { matter: previous, previous }
  const reopening = status === 'open'
  const corrected = reopening && previous.closedBy !== 'user' && previous.closedBy !== null ? previous.reason ?? undefined : undefined
  const matter = store.transaction(() => {
    if (corrected !== undefined) store.bumpRule(corrected, 'corrected')
    store.log(now, `user-${status}`, { id, key: previous.key, from: previous.status, reason: previous.reason, ...corrected === undefined ? {} : { corrected } })
    return store.updateMatter(id, {
      status,
      closedBy: reopening ? null : 'user',
      closedAt: reopening ? null : now,
      reason: reopening ? 'reopened' : status === 'done' ? 'done-by-you' : 'dismissed-by-you',
      overrideAt: now,
      snoozeUntil: null,
    }, now)
  })
  return { matter, previous, ...corrected === undefined ? {} : { corrected } }
}

/**
 * "Remind me again on `until`": the matter stays open but leaves the to-do
 * list until that day. `until === null` brings it back now. Newer activity at
 * the source also brings it back.
 */
export function snoozeByUser(store: MishuStore, id: number, until: string | null, now: number): Matter | undefined {
  const matter = store.matterById(id)
  if (matter === undefined || matter.status !== 'open') return undefined
  store.log(now, until === null ? 'user-unsnooze' : 'user-snooze', { id, key: matter.key, until })
  return store.updateMatter(id, { snoozeUntil: until, overrideAt: now }, now)
}

/** Open and not snoozed past `today`: what is on your list right now. */
export function isActive(matter: Matter, today: string): boolean {
  return matter.status === 'open' && (matter.snoozeUntil === null || matter.snoozeUntil <= today)
}
