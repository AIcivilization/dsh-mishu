/**
 * The bridge to DSH's own Schedule service (`@deepseek-ai/dsh-schedule`, the
 * "自动化任务" page).
 *
 * Two directions, both kept small on purpose:
 *
 * - The daily brief can be handed to Schedule: the same text the desktop
 *   notification carries, delivered as a turn in a conversation instead. That
 *   is the one task the secretary creates on its own, and it is marked in its
 *   prompt so a later visit recognises it even after you edited the title.
 * - Every task on the Host is listed for the settings page, so what the
 *   secretary scheduled and what you scheduled yourself sit in one place.
 *
 * Schedule is optional: a Host without the service simply has no bridge, and
 * the page says so instead of offering a button that cannot work.
 */

import { bi, BRIEF_MARK, briefPrompt, briefTiming, briefTitle, BRIEF_TASK_KEY, isBriefTask, sortTasks, taskView, type ScheduleEntry, type ScheduleTaskView } from '../core/index.ts'
import type { Lang } from '../core/i18n.ts'
import { MishuError } from '../core/i18n.ts'
import type { MishuStore } from '../core/store.ts'

/** The slice of `ScheduleService` this plugin uses. */
export interface ScheduleLike {
  list(request?: { active?: boolean; limit?: number; offset?: number }): Promise<{ items: ScheduleEntry[]; shown: number; total: number }>
  view(request: { id: string }): Promise<ScheduleEntry | { id: string; code: string }>
  create(request: { title: string; prompt: string; timing: Record<string, unknown>; target?: Record<string, unknown> }): Promise<ScheduleEntry | { id: string; code: string }>
  edit(request: { id: string; action: 'update' | 'delete'; patch?: Record<string, unknown>; expectedUpdatedAt?: string }): Promise<ScheduleEntry | { id: string; code: string; deleted?: boolean }>
  run(request: { id: string }): Promise<ScheduleEntry | { id: string; code: string }>
}

/** A code the service returns instead of throwing (`schedule_not_found`, `schedule_conflict`, …). */
const isMiss = (value: unknown): value is { id: string; code: string } =>
  typeof value === 'object' && value !== null && 'code' in value && typeof (value as { code: unknown }).code === 'string'

/** The service's own words, wrapped so the page shows one sentence in one language. */
function wrap(error: unknown, _lang: Lang): MishuError {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  const hint = typeof code === 'string' ? `（${code}）` : ''
  return new MishuError(bi(`DSH 的自动化任务没接受这个请求：${message}${hint}`, `DSH's scheduled tasks refused this: ${message}${hint}`))
}

export interface ScheduleView {
  /** False when this Host has no Schedule service: the page then explains instead of offering buttons. */
  available: boolean
  tasks: ScheduleTaskView[]
  brief: {
    /** The task id this notebook created, if it is still on the Host. */
    id: string | null
    /** The brief's time, as the reminder settings have it. */
    time: string
    timeZone: string
    /** Whether the brief is currently armed as a task. */
    armed: boolean
    /** Last thing the service said when it was asked to arm it, if it failed. */
    error: string | null
  }
}

const BRIEF_ERROR_KEY = 'schedule.briefError'

export class ScheduleBridge {
  private service: ScheduleLike
  private readonly store: () => MishuStore | undefined
  private readonly lang: () => Lang
  /** The brief's time and zone, as the reminder settings hold them. */
  private readonly briefClock: () => { time: string; timeZone: string }

  constructor(service: ScheduleLike, store: () => MishuStore | undefined, lang: () => Lang, briefClock: () => { time: string; timeZone: string }) {
    this.service = service
    this.store = store
    this.lang = lang
    this.briefClock = briefClock
  }

  /** A restarted service: same bridge, new handle. */
  replace(service: ScheduleLike): void {
    this.service = service
  }

  /** The page's language when it asked, else the notebook's. A task's wording is read by a person, not logged. */
  private useLang(lang?: Lang): Lang {
    return lang ?? this.lang()
  }

  private savedId(): string | undefined {
    return this.store()?.get<string>(BRIEF_TASK_KEY)
  }

  /** Every task on the Host, newest rules first, plus whether the brief is armed. */
  async view(asked?: Lang): Promise<ScheduleView> {
    const lang = this.useLang(asked)
    const briefId = this.savedId()
    let entries: ScheduleEntry[] = []
    let error: string | null = null
    try {
      const page = await this.service.list({ limit: 100 })
      entries = page.items
    } catch (problem) {
      error = wrap(problem, lang).text[lang]
    }
    const store = this.store()
    const clock = this.briefClock()
    const timing = briefTiming(clock.time, clock.timeZone)
    const armed = entries.some(entry => isBriefTask(entry, briefId) && (entry.status ?? 'active') === 'active')
    return {
      available: true,
      tasks: sortTasks(entries.map(entry => taskView(entry, lang, briefId))),
      brief: {
        id: briefId ?? null,
        time: clock.time,
        timeZone: timing.time_zone,
        armed,
        error: error ?? store?.get<string>(BRIEF_ERROR_KEY) ?? null,
      },
    }
  }

  /**
   * Arm the brief as a daily task, or move it when the time changed. Reuses
   * the task it made before — editing it in the automation page keeps it.
   */
  async armBrief(asked?: Lang): Promise<ScheduleView> {
    const store = this.store()
    if (store === undefined) throw new MishuError(bi('小秘书的记事本没有打开', 'the notebook is not open'))
    const lang = this.useLang(asked)
    const clock = this.briefClock()
    const timing = { kind: 'daily', daily: briefTiming(clock.time, clock.timeZone) }
    const request = { title: briefTitle(lang), prompt: briefPrompt(lang), timing }
    const existing = this.savedId()
    try {
      let id = existing
      if (id !== undefined) {
        const current = await this.service.view({ id })
        if (isMiss(current)) id = undefined
        else {
          const updated = await this.service.edit({
            id,
            action: 'update',
            patch: { ...request, active: true },
            ...current.updatedAt === undefined ? {} : { expectedUpdatedAt: current.updatedAt },
          })
          if (isMiss(updated)) id = undefined
        }
      }
      if (id === undefined) {
        const created = await this.service.create({ ...request, target: { kind: 'new_once', create: {} } })
        if (isMiss(created)) throw new MishuError(bi(`自动化任务没有建成：${created.code}`, `the task was not created: ${created.code}`))
        id = created.id
        store.set(BRIEF_TASK_KEY, id)
      }
      store.set(BRIEF_ERROR_KEY, null)
      store.log(Date.now(), 'schedule-brief', { id, time: clock.time, zone: briefTiming(clock.time, clock.timeZone).time_zone })
    } catch (problem) {
      const wrapped = problem instanceof MishuError ? problem : wrap(problem, lang)
      store.set(BRIEF_ERROR_KEY, wrapped.text[lang])
      throw wrapped
    }
    return this.view(lang)
  }

  /**
   * Move the brief when its time changed on the settings page, and say
   * nothing when it was never armed. Errors are kept, not thrown: this runs
   * behind a save that has already succeeded.
   */
  async followBrief(asked?: Lang): Promise<void> {
    const store = this.store()
    const id = this.savedId()
    if (store === undefined || id === undefined) return
    try {
      const current = await this.service.view({ id })
      if (isMiss(current)) {
        store.set(BRIEF_TASK_KEY, null)
        return
      }
      if ((current.status ?? 'active') !== 'active') return
      const clock = this.briefClock()
      const timing = briefTiming(clock.time, clock.timeZone)
      if (current.kind === 'daily' && current.time === timing.time && current.timeZone === timing.time_zone) return
      const updated = await this.service.edit({
        id,
        action: 'update',
        patch: { timing: { kind: 'daily', daily: timing } },
        ...current.updatedAt === undefined ? {} : { expectedUpdatedAt: current.updatedAt },
      })
      const lang = this.useLang(asked)
      if (isMiss(updated)) store.set(BRIEF_ERROR_KEY, bi(`改不动：${updated.code}`, `could not move it: ${updated.code}`)[lang])
      else store.log(Date.now(), 'schedule-brief-moved', { id, time: clock.time })
    } catch (problem) {
      const lang = this.useLang(asked)
      store.set(BRIEF_ERROR_KEY, wrap(problem, lang).text[lang])
    }
  }

  /** Take the brief task off the Host; the desktop notification is unaffected. */
  async disarmBrief(asked?: Lang): Promise<ScheduleView> {
    const store = this.store()
    if (store === undefined) throw new MishuError(bi('小秘书的记事本没有打开', 'the notebook is not open'))
    const lang = this.useLang(asked)
    const id = this.savedId()
    if (id !== undefined) {
      try {
        const result = await this.service.edit({ id, action: 'delete' })
        // Already gone is the same as gone.
        if (isMiss(result) && result.code !== 'schedule_not_found') throw new MishuError(bi(`删不掉：${result.code}`, `could not delete: ${result.code}`))
      } catch (problem) {
        throw problem instanceof MishuError ? problem : wrap(problem, lang)
      }
      store.set(BRIEF_TASK_KEY, null)
      store.log(Date.now(), 'schedule-brief-off', { id })
    }
    store.set(BRIEF_ERROR_KEY, null)
    return this.view(lang)
  }

  /** Delete any task on the Host — the secretary only ever deletes its own, but the page lists all. */
  async delete(id: string, asked?: Lang): Promise<ScheduleView> {
    const lang = this.useLang(asked)
    try {
      const result = await this.service.edit({ id, action: 'delete' })
      if (isMiss(result) && result.code === 'schedule_not_found') throw new MishuError(bi('这个任务已经不在了', 'that task is already gone'))
    } catch (problem) {
      throw problem instanceof MishuError ? problem : wrap(problem, lang)
    }
    if (this.savedId() === id) this.store()?.set(BRIEF_TASK_KEY, null)
    return this.view(lang)
  }

  /** Run a task now, without waiting for its time. */
  async run(id: string, asked?: Lang): Promise<ScheduleView> {
    const lang = this.useLang(asked)
    try {
      const result = await this.service.run({ id })
      if (isMiss(result)) {
        throw new MishuError(result.code === 'schedule_execution_pending'
          ? bi('这个任务正在跑，等它跑完', 'that task is already running')
          : bi('这个任务已经不在了', 'that task is already gone'))
      }
    } catch (problem) {
      throw problem instanceof MishuError ? problem : wrap(problem, lang)
    }
    return this.view(lang)
  }
}
