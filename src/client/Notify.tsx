/**
 * "When and how to tell you": the daily brief, urgent items right away,
 * quiet hours, and the channels (this computer's notifications, a Feishu
 * bot). Times follow the time zone of this browser, sent to the host the
 * first time this section shows.
 */

import { useEffect, useState } from 'react'
import { settingsApi, type NotifySettingsView, type SettingsView } from './api.ts'
import { Fold } from './Fold.tsx'
import { Modal } from './Modal.tsx'
import { TEXT, type UiLang } from './text.ts'

type Take = (result: { ok: true; view: SettingsView } | { ok: false; message: string }, saved?: string) => void

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    return ''
  }
}

export function NotifySection({ view, lang, locale, take }: { view: SettingsView; lang: UiLang; locale: () => string; take: Take }) {
  const t = TEXT[lang]
  const notify = view.notify.settings
  const [tested, setTested] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [feishuOpen, setFeishuOpen] = useState(false)

  const save = async (patch: Partial<NotifySettingsView>) => take(await settingsApi.saveNotify(locale(), patch), t.sSaved)
  useEffect(() => {
    // Reminders go by your clock, also when DSH runs on a server in another zone.
    const zone = browserZone()
    if (notify.timeZone === '' && zone !== '') void settingsApi.saveNotify(locale(), { timeZone: zone }).then(r => take(r))
  }, [notify.timeZone, locale])

  const test = async (channel: string) => {
    setTested({ ...tested, [channel]: { ok: true, text: t.sTesting } })
    const r = await settingsApi.testNotify(locale(), channel)
    setTested({ ...tested, [channel]: r.ok ? { ok: true, text: t.nTestSent } : { ok: false, text: r.message } })
  }
  const time = (value: string, onChange: (value: string) => void) => (
    <input type="time" step={60} value={value} onChange={e => { if (e.target.value !== '') onChange(e.target.value) }} />
  )
  const last = view.notify.last

  return (
    <>
      <div className="mishu-notify-row">
        <label className="mishu-check"><input type="checkbox" checked={notify.brief.enabled} onChange={e => { void save({ brief: { ...notify.brief, enabled: e.target.checked } }) }} />{t.nBrief}</label>
        {time(notify.brief.time, value => { void save({ brief: { ...notify.brief, time: value } }) })}
      </div>
      <div className="mishu-notify-row">
        <label className="mishu-check"><input type="checkbox" checked={notify.urgent} onChange={e => { void save({ urgent: e.target.checked }) }} />{t.nUrgent}</label>
      </div>
      <div className="mishu-notify-row">
        <label className="mishu-check"><input type="checkbox" checked={notify.quiet.enabled} onChange={e => { void save({ quiet: { ...notify.quiet, enabled: e.target.checked } }) }} />{t.nQuiet}</label>
        {time(notify.quiet.from, value => { void save({ quiet: { ...notify.quiet, from: value } }) })}
        <span className="mishu-hint">{t.nTo}</span>
        {time(notify.quiet.to, value => { void save({ quiet: { ...notify.quiet, to: value } }) })}
      </div>
      <p className="mishu-hint">{t.nZone(notify.timeZone || browserZone())}</p>

      <h3>{t.nChannels}</h3>
      {view.notify.channels.map((channel) => {
        const result = tested[channel.id]
        const feishu = channel.id === 'feishu'
        return (
          <Fold
            key={channel.id}
            id={`channel-${channel.id}`}
            title={feishu ? t.nFeishu : t.nDesktop}
            aside={(
              <label className="mishu-check mishu-check-inline" title={channel.available ? undefined : channel.why}>
                <input type="checkbox" checked={channel.enabled} disabled={!channel.available}
                  onChange={e => { void save({ channels: { ...notify.channels, [channel.id]: e.target.checked } }) }} />
              </label>
            )}
          >
            <div className={`mishu-card-note ${channel.available ? '' : 'mishu-warn'}`}>
              {channel.available ? (feishu ? t.nFeishuOn : t.nDesktopOn) : channel.why}
            </div>
            <div className="mishu-actions">
              {channel.available ? <button type="button" className="mishu-btn" onClick={() => { void test(channel.id) }}>{t.nTest}</button> : null}
              {feishu ? <button type="button" className={view.notify.feishu.configured ? 'mishu-btn' : 'mishu-btn primary'} onClick={() => setFeishuOpen(true)}>{view.notify.feishu.configured ? t.nFeishuChange : t.nFeishuConnect}</button> : null}
              {feishu && view.notify.feishu.configured ? (
                <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => {
                  if (window.confirm(t.nFeishuRemoveConfirm)) void settingsApi.deleteFeishu(locale()).then(r => take(r))
                }}>{t.nFeishuRemove}</button>
              ) : null}
              {result === undefined ? null : <span className={result.ok ? 'mishu-hint' : 'mishu-hint mishu-danger'}>{result.text}</span>}
            </div>
          </Fold>
        )
      })}
      {last === null ? null : <p className="mishu-hint">{t.nLast(new Date(last.at).toLocaleString(), last.kind, last.results)}</p>}
      {feishuOpen ? <FeishuDialog lang={lang} locale={locale} onDone={(next) => { setFeishuOpen(false); if (next !== undefined) take({ ok: true, view: next }, t.nFeishuSaved) }} /> : null}
    </>
  )
}

/** Connect a Feishu custom bot: where to make one, then its address (and signing secret). */
function FeishuDialog({ lang, locale, onDone }: { lang: UiLang; locale: () => string; onDone: (view?: SettingsView) => void }) {
  const t = TEXT[lang]
  const [webhook, setWebhook] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const connect = async () => {
    setBusy(true)
    setError(undefined)
    const r = await settingsApi.saveFeishu(locale(), webhook, secret)
    setBusy(false)
    if (r.ok) onDone(r.view)
    else setError(r.message)
  }
  return (
    <Modal title={t.nFeishuConnect} onClose={() => onDone()}>
      <div className="mishu-steps">
        <ol>{t.nFeishuSteps.map((step, i) => <li key={i}>{step}</li>)}</ol>
      </div>
      <label className="mishu-field">{t.nWebhook}
        <input value={webhook} autoComplete="off" spellCheck={false} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" onChange={(e) => { setWebhook(e.target.value); setError(undefined) }} />
      </label>
      <label className="mishu-field">{t.nSecret}
        <input type="password" value={secret} autoComplete="off" spellCheck={false} onChange={(e) => { setSecret(e.target.value); setError(undefined) }} />
      </label>
      <p className="mishu-hint">{t.nFeishuPrivacy}</p>
      {error === undefined ? null : <div className="mishu-preview mishu-danger">{error}</div>}
      <div className="mishu-actions">
        <button type="button" className="mishu-btn primary" disabled={busy || webhook.trim() === ''} onClick={() => { void connect() }}>{busy ? t.sTesting : t.nFeishuTry}</button>
        <button type="button" className="mishu-btn" onClick={() => onDone()}>{t.sCancel}</button>
      </div>
    </Modal>
  )
}
