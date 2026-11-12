/**
 * The brief as a DSH scheduled task, and every task DSH already has.
 *
 * Two things live here because they answer one question — "when does the
 * secretary speak up": the daily brief can be handed to DSH's own scheduler,
 * so it arrives as a conversation turn instead of a desktop notification; and
 * the tasks on this Host are listed, so what the secretary made and what you
 * made yourself sit in one place.
 *
 * The task list is read-only apart from "run now" and "delete": a task's
 * wording is the agent's prompt, and editing it belongs in DSH's own
 * automation page.
 */

import { useState } from 'react'
import { settingsApi, type ScheduleTaskView, type ScheduleView, type SettingsView } from './api.ts'
import { Fold } from './Fold.tsx'
import { TEXT, type UiLang } from './text.ts'

type Take = (result: { ok: true; view: SettingsView } | { ok: false; message: string }, saved?: string) => void

export function ScheduleSection({ view, lang, locale, take }: { view: SettingsView; lang: UiLang; locale: () => string; take: Take }) {
  const t = TEXT[lang]
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const schedule = view.schedule

  if (schedule === null) {
    return (
      <>
        <h3>{t.nSchedule}</h3>
        <p className="mishu-hint">{t.nScheduleNoService}</p>
      </>
    )
  }

  const act = async (key: string, call: () => Promise<{ ok: true; view: SettingsView } | { ok: false; message: string }>, saved?: string) => {
    setBusy(key)
    const result = await call()
    setBusy(undefined)
    setError(result.ok ? undefined : result.message)
    take(result, saved)
  }

  /** A task change answers with the schedule alone, so the settings view is refreshed from it. */
  const afterTask = (result: { ok: true; schedule: ScheduleView } | { ok: false; message: string }) => {
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(undefined)
    take({ ok: true, view: { ...view, schedule: result.schedule } })
  }

  return (
    <>
      <h3>{t.nSchedule}</h3>
      <p className="mishu-hint">{t.nScheduleHint}</p>
      {schedule.brief.armed ? (
        <>
          <p className="mishu-ok">{t.nScheduleArmed}</p>
          <div className="mishu-actions">
            <button type="button" className="mishu-btn" disabled={busy !== undefined} onClick={() => {
              if (window.confirm(t.nScheduleDisarmConfirm)) void act('disarm', () => settingsApi.disarmBrief(locale()))
            }}>{t.nScheduleDisarm}</button>
          </div>
        </>
      ) : (
        <div className="mishu-actions">
          <button type="button" className="mishu-btn" disabled={busy !== undefined} onClick={() => { void act('arm', () => settingsApi.armBrief(locale()), t.sSaved) }}>
            {busy === 'arm' ? t.loading : t.nScheduleArm}
          </button>
        </div>
      )}
      {schedule.brief.error === null ? null : <div className="mishu-error">{schedule.brief.error}</div>}
      {error === undefined ? null : <div className="mishu-error">{error}</div>}

      <h3>{t.nScheduleTasks}</h3>
      {schedule.tasks.length === 0 ? <p className="mishu-empty">{t.nScheduleNone}</p> : schedule.tasks.map(task => (
        <TaskRow
          key={task.id}
          task={task}
          lang={lang}
          locale={locale}
          busy={busy === task.id}
          onRun={() => { setBusy(task.id); void settingsApi.runTask(locale(), task.id).then((r) => { setBusy(undefined); afterTask(r) }) }}
          onDelete={() => { setBusy(task.id); void settingsApi.deleteTask(locale(), task.id).then((r) => { setBusy(undefined); afterTask(r) }) }}
        />
      ))}
    </>
  )
}

/** One task: its rule in words, when it next runs, and the two things worth doing to it. */
function TaskRow({ task, lang, locale, busy, onRun, onDelete }: {
  task: ScheduleTaskView; lang: UiLang; locale: () => string; busy: boolean
  onRun: () => void; onDelete: () => void
}) {
  const t = TEXT[lang]
  const state = task.status === 'ended' ? t.nScheduleEnded : task.status === 'paused' ? t.nSchedulePaused : task.next === null ? '' : t.nScheduleNext(task.next)
  return (
    <Fold id={`task-${task.id}`} title={`${task.title}${task.mine ? ` · ${t.nScheduleMine}` : ''}`}>
      <div className="mishu-card-meta">{task.when}{state === '' ? '' : ` · ${state}`}</div>
      <div className="mishu-card-meta">
        {task.running ? t.nScheduleRunning : ''}
        {task.lastDelivery === null ? '' : `${task.running ? ' · ' : ''}${t.nScheduleLast(task.lastDelivery)}`}
      </div>
      <div className="mishu-card-note">{t.nSchedulePrompt}：{task.prompt}</div>
      <div className="mishu-actions">
        <button type="button" className="mishu-btn" disabled={busy || task.status === 'ended'} onClick={onRun}>{busy ? t.loading : t.nScheduleRunNow}</button>
        <button type="button" className="mishu-btn mishu-btn-quiet" disabled={busy} onClick={() => {
          if (window.confirm(t.nScheduleDeleteConfirm)) onDelete()
        }}>{t.sDelete}</button>
      </div>
    </Fold>
  )
}
