/**
 * Folding verdicts into matters, shared by every source.
 *
 * A source judges its messages; this decides what that means for the matter
 * on your list: create it, close it (by rule), reopen it on newer activity,
 * or leave your own decision alone until the source shows something newer.
 */

import { encode } from './i18n.ts'
import type { Verdict } from './github/rules.ts'
import type { Matter, MishuStore } from './store.ts'

/** `Promise.all` with at most `limit` in flight, results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Create, update, close or reopen the matter a verdict is about. */
export function applyVerdict(store: MishuStore, source: string, verdict: Verdict & { activityAt: number }, now: number, counts: { opened: number; closed: number }): Matter {
  const existing = store.matterByKey(verdict.matterKey)
  if (existing === undefined) {
    const matter = store.insertMatter({
      key: verdict.matterKey,
      source,
      kind: verdict.kind,
      title: encode(verdict.title),
      note: verdict.note === null ? null : encode(verdict.note),
      explain: JSON.stringify(verdict.explain),
      url: verdict.url,
      status: verdict.status,
      reason: verdict.reason,
      closedBy: verdict.status === 'done' ? 'rule' : null,
      activityAt: verdict.activityAt,
    }, now)
    if (verdict.status === 'done') {
      store.bumpRule(verdict.reason, 'fired')
      counts.closed++
    } else {
      counts.opened++
    }
    return matter
  }

  // Your own decision stands until the source shows something newer.
  const userHeld = existing.overrideAt !== null && verdict.activityAt <= existing.overrideAt
  const facts = { title: encode(verdict.title), note: verdict.note === null ? null : encode(verdict.note), url: verdict.url ?? existing.url, kind: verdict.kind, activityAt: verdict.activityAt, explain: JSON.stringify(verdict.explain) }
  if (userHeld) return store.updateMatter(existing.id, { activityAt: verdict.activityAt, explain: facts.explain }, now)

  if (verdict.status === 'open') {
    if (existing.status !== 'open') counts.opened++
    // Newer activity than your last decision: back on the list, snooze or not.
    return store.updateMatter(existing.id, { ...facts, status: 'open', reason: verdict.reason, closedBy: null, closedAt: null, overrideAt: null, snoozeUntil: null }, now)
  }
  if (existing.status === 'open') {
    store.bumpRule(verdict.reason, 'fired')
    counts.closed++
    return store.updateMatter(existing.id, { ...facts, status: 'done', reason: verdict.reason, closedBy: 'rule', closedAt: now }, now)
  }
  return store.updateMatter(existing.id, facts, now)
}


/**
 * Messages that left the source's unread list were read somewhere else; once
 * every message of an open matter is read, the matter closes with `reason`.
 * `keep` decides which missing messages to leave alone (e.g. mail that only
 * fell out of the time window).
 */
export function closeReadElsewhere(
  store: MishuStore, source: string, seen: Set<string>, touched: Set<string>, now: number, reason: string,
  keep: (message: { id: string; updatedAt: number }) => boolean = () => false,
): number {
  let closed = 0
  for (const message of store.unreadMessages(source)) {
    if (seen.has(message.id) || keep(message)) continue
    store.setMessageUnread(message.id, false)
    store.setWouldMarkRead(message.id, false)
  }
  for (const matter of store.mattersOfSource(source)) {
    if (matter.status !== 'open' || touched.has(matter.key)) continue
    if (store.messagesOfMatter(matter.key).some(m => m.unread)) continue
    store.updateMatter(matter.id, { status: 'done', reason, closedBy: 'source', closedAt: now }, now)
    closed++
  }
  return closed
}
