/**
 * Reaching you without you opening the board: a daily brief, urgent items
 * as they come, and quiet hours.
 *
 * Urgent means someone is waiting on you or it is due today:
 *   - things you told it: due today or overdue
 *   - GitHub: a review requested, a mention, an assignment
 *   - mail: a meeting invitation
 * Everything else waits for the daily brief. Each urgent item is sent once
 * (again only when it changes reason or due day); turning reminders on does
 * not send what was already on the board. During quiet hours nothing is
 * sent; what came up is sent when they end.
 *
 * Times are read in the time zone your browser reported, so a server
 * running on UTC still sends the brief at your morning.
 */

import type { BoardData } from './board.ts'
import { reasonLabel } from './brief.ts'
import { bi, decode, MishuError, type Bi, type Lang } from './i18n.ts'
import { isActive } from './matters.ts'
import type { Matter, MishuStore } from './store.ts'
import { dayOf } from './time.ts'

export interface NotifySettings {
  brief: { enabled: boolean; time: string }
  urgent: boolean
  quiet: { enabled: boolean; from: string; to: string }
  /** IANA zone from your browser; empty: this computer's own. */
  timeZone: string
  channels: { desktop: boolean; feishu: boolean }
}

export const DEFAULT_NOTIFY: NotifySettings = {
  brief: { enabled: true, time: '09:00' },
  urgent: true,
  quiet: { enabled: true, from: '22:00', to: '08:00' },
  timeZone: '',
  channels: { desktop: true, feishu: false },
}

export const URGENT_REASONS = ['review-requested', 'mentioned', 'assigned', 'mail-invite']

export type ChannelId = keyof NotifySettings['channels']

export interface Message {
  kind: 'brief' | 'urgent' | 'test'
  title: string
  /** One or two lines, for a system notification. */
  body: string
  /** The whole message, for a chat. */
  text: string
}

export interface Channel {
  id: ChannelId
  status(): Promise<{ available: true } | { available: false; why: Bi }>
  send(message: Message): Promise<void>
}

export interface NotifyReport {
  at: number
  kind: Message['kind']
  count: number
  results: Array<{ channel: ChannelId; ok: boolean; error?: string }>
}

interface NotifyState {
  /** Local day the brief went out. */
  briefDay?: string
  /** Urgent keys already sent, with when. */
  sent: Record<string, number>
}

const SETTINGS_KEY = 'notify.settings'
const STATE_KEY = 'notify.state'
export const NOTIFY_REPORT_KEY = 'notify.last'

export function notifySettings(store: MishuStore): NotifySettings {
  const saved = store.get<Partial<NotifySettings>>(SETTINGS_KEY) ?? {}
  return {
    brief: { ...DEFAULT_NOTIFY.brief, ...saved.brief },
    urgent: saved.urgent ?? DEFAULT_NOTIFY.urgent,
    quiet: { ...DEFAULT_NOTIFY.quiet, ...saved.quiet },
    timeZone: saved.timeZone ?? DEFAULT_NOTIFY.timeZone,
    channels: { ...DEFAULT_NOTIFY.channels, ...saved.channels },
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Check what the page sent and keep it; throws a sentence a person can act on. */
export function saveNotifySettings(store: MishuStore, input: Partial<NotifySettings>, now: number): NotifySettings {
  const current = notifySettings(store)
  const next: NotifySettings = {
    brief: { ...current.brief, ...input.brief },
    urgent: input.urgent ?? current.urgent,
    quiet: { ...current.quiet, ...input.quiet },
    timeZone: input.timeZone ?? current.timeZone,
    channels: { ...current.channels, ...input.channels },
  }
  for (const time of [next.brief.time, next.quiet.from, next.quiet.to]) {
    if (!TIME.test(time)) throw new MishuError(bi(`时间要写成 08:30 这样：${time}`, `Write times like 08:30: ${time}`))
  }
  if (next.timeZone !== '') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: next.timeZone })
    } catch {
      throw new MishuError(bi(`不认识这个时区：${next.timeZone}`, `Unknown time zone: ${next.timeZone}`))
    }
  }
  store.set(SETTINGS_KEY, next)
  store.log(now, 'notify-settings', next)
  return next
}

/** The day and minute of the day in a time zone ('' = this computer's). */
export function localClock(now: number, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...timeZone === '' ? {} : { timeZone },
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now))
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '00'
  return { day: `${part('year')}-${part('month')}-${part('day')}`, minutes: Number(part('hour')) * 60 + Number(part('minute')) }
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

/** Whether a minute of the day is inside quiet hours, which may run past midnight. */
export function inQuiet(minutes: number, quiet: NotifySettings['quiet']): boolean {
  if (!quiet.enabled) return false
  const from = minutesOf(quiet.from)
  const to = minutesOf(quiet.to)
  if (from === to) return false
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

/** Open items someone is waiting on, or due today. */
export function urgentMatters(store: MishuStore, today: string): Matter[] {
  return store.openMatters().filter(m => isActive(m, today) && (
    m.source === 'manual' ? m.dueDay !== null && m.dueDay <= today : URGENT_REASONS.includes(m.reason ?? '')
  ))
}

const urgentKey = (m: Matter) => `${m.id}:${m.reason ?? ''}:${m.dueDay ?? ''}`

const SIGN = bi('打开小秘书看板处理。', 'Open the secretary board to handle them.')

function urgentMessage(matters: Matter[], lang: Lang): Message {
  const zh = lang === 'zh'
  const line = (m: Matter) => {
    const why = m.source === 'manual' ? (zh ? `${m.dueDay} 到期` : `due ${m.dueDay}`) : reasonLabel(m.reason, lang)
    return `• ${decode(m.title, lang)}${why === '' ? '' : `（${why}）`}`
  }
  const first = decode(matters[0]!.title, lang)
  return {
    kind: 'urgent',
    title: zh ? `小秘书：${matters.length} 件急事` : `Secretary: ${matters.length} urgent`,
    body: matters.length === 1 ? first : (zh ? `${first} 等 ${matters.length} 件` : `${first} and ${matters.length - 1} more`),
    text: [zh ? `小秘书：${matters.length} 件急事` : `Secretary: ${matters.length} urgent`, ...matters.slice(0, 10).map(line),
      ...matters.length > 10 ? [zh ? `…还有 ${matters.length - 10} 件` : `…and ${matters.length - 10} more`] : [], SIGN[lang]].join('\n'),
  }
}

/** The brief, from what the board shows; `undefined` when there is nothing to tell. */
export function briefMessage(board: BoardData, lang: Lang): Message | undefined {
  const zh = lang === 'zh'
  const { handle, remember } = board.columns
  if (handle.length === 0 && board.metrics.dueSoon === 0) return undefined
  const lines = handle.slice(0, 10).map(card => `• ${card.title}（${card.meta}）`)
  const soon = remember.filter(card => card.tone !== 'normal').slice(0, 5).map(card => `• ${card.title}（${card.meta}）`)
  const title = zh ? '小秘书 · 今日简报' : 'Secretary · daily brief'
  return {
    kind: 'brief',
    title,
    body: board.summary,
    text: [title, board.summary,
      ...lines.length > 0 ? ['', zh ? '要你处理：' : 'To handle:', ...lines] : [],
      ...handle.length > 10 ? [zh ? `…还有 ${handle.length - 10} 件` : `…and ${handle.length - 10} more`] : [],
      ...soon.length > 0 ? ['', zh ? '快到期：' : 'Coming up:', ...soon] : [],
      '', SIGN[lang]].join('\n'),
  }
}

export function testMessage(lang: Lang): Message {
  return lang === 'zh'
    ? { kind: 'test', title: '小秘书', body: '提醒能送到这里。', text: '小秘书：提醒能送到这里。' }
    : { kind: 'test', title: 'Secretary', body: 'Reminders reach you here.', text: 'Secretary: reminders reach you here.' }
}

/** Send to every enabled channel; one failing does not stop the others. */
export async function deliver(store: MishuStore, channels: Channel[], message: Message, count: number, now: number): Promise<NotifyReport> {
  const results: NotifyReport['results'] = []
  for (const channel of channels) {
    try {
      await channel.send(message)
      results.push({ channel: channel.id, ok: true })
    } catch (error) {
      results.push({ channel: channel.id, ok: false, error: error instanceof MishuError ? error.text.en : (error as Error).message })
    }
  }
  const report: NotifyReport = { at: now, kind: message.kind, count, results }
  if (message.kind !== 'test') store.set(NOTIFY_REPORT_KEY, report)
  // Counts and channels only: titles never go to the log.
  store.log(now, 'notify', { kind: message.kind, count, results: results.map(r => ({ channel: r.channel, ok: r.ok })) })
  return report
}

/**
 * One look at the clock: send what is due. Called every minute and after
 * each sync. `channels` are the enabled ones; `board` builds the brief.
 */
export async function notifyTick(options: {
  store: MishuStore
  now: number
  lang: Lang
  channels: Channel[]
  board: () => BoardData
}): Promise<NotifyReport[]> {
  const { store, now, lang, channels } = options
  const settings = notifySettings(store)
  if (channels.length === 0) return []
  const clock = localClock(now, settings.timeZone)
  const today = dayOf(now)
  const urgent = urgentMatters(store, today)
  let state = store.get<NotifyState>(STATE_KEY)
  if (state === undefined) {
    // First look: what is already on the board is not news, and a brief whose time has passed waits for tomorrow.
    state = { sent: Object.fromEntries(urgent.map(m => [urgentKey(m), now])) }
    if (clock.minutes >= minutesOf(settings.brief.time)) state.briefDay = clock.day
    store.set(STATE_KEY, state)
    return []
  }
  const reports: NotifyReport[] = []
  if (!inQuiet(clock.minutes, settings.quiet)) {
    const fresh = settings.urgent ? urgent.filter(m => state!.sent[urgentKey(m)] === undefined) : []
    if (fresh.length > 0) {
      reports.push(await deliver(store, channels, urgentMessage(fresh, lang), fresh.length, now))
      for (const m of fresh) state.sent[urgentKey(m)] = now
    }
    if (settings.brief.enabled && state.briefDay !== clock.day && clock.minutes >= minutesOf(settings.brief.time)) {
      state.briefDay = clock.day
      const board = options.board()
      const message = briefMessage(board, lang)
      if (message !== undefined) reports.push(await deliver(store, channels, message, board.columns.handle.length, now))
    }
  }
  // Forget what was sent for items closed a week ago.
  const open = new Set(urgent.map(urgentKey))
  for (const [key, at] of Object.entries(state.sent)) if (!open.has(key) && now - at > 7 * 86_400_000) delete state.sent[key]
  store.set(STATE_KEY, state)
  return reports
}
