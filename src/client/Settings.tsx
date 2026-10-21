/**
 * The settings page: language and warning times, GitHub, mail accounts.
 *
 * Passwords are typed here and sent once to the host, which hands them
 * straight to the system keychain; the page never receives one back. The
 * page only shows what the host answers with.
 */

import { useEffect, useState } from 'react'
import { settingsApi, type AccountDraft, type AccountView, type SettingsView } from './api.ts'
import { TEXT, type UiLang } from './text.ts'

const CATEGORIES = ['document', 'bill', 'birthday', 'renewal', 'other'] as const

export function MishuSettings({ lang, locale }: { lang: UiLang; locale: () => string }) {
  const t = TEXT[lang]
  const [view, setView] = useState<SettingsView | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [lead, setLead] = useState<Record<string, number>>({})
  const [githubTest, setGithubTest] = useState<string | undefined>()
  const [confirmOn, setConfirmOn] = useState(false)
  const [editing, setEditing] = useState<AccountDraft | undefined>()

  const take = (result: { ok: true; view: SettingsView } | { ok: false; message: string }, saved?: string) => {
    if (result.ok) {
      setView(result.view)
      setLead(result.view.settings.leadDays)
      setError(undefined)
      setNote(saved)
    } else {
      setError(result.message)
    }
  }

  useEffect(() => { void settingsApi.load(locale()).then(r => take(r)) }, [locale])

  if (view === undefined) {
    return <div className="mishu-settings">{error === undefined ? <p className="mishu-empty">{t.loading}</p> : <div className="mishu-error">{t.failed}{error}</div>}</div>
  }

  const save = async (settings: Partial<SettingsView['settings']>) => take(await settingsApi.save(locale(), settings), t.sSaved)
  const token = view.github.token
  const secretKind = t.secretKinds[view.secrets.kind] ?? view.secrets.kind

  return (
    <div className="mishu-settings">
      {error === undefined ? null : <div className="mishu-error">{t.failed}{error}</div>}
      {note === undefined ? null : <div className="mishu-ok">{note}</div>}

      <section className="mishu-panel">
        <h2>{t.sGeneral}</h2>
        <label className="mishu-field">{t.sLanguage}
          <select value={view.settings.language} onChange={e => { void save({ language: e.target.value as SettingsView['settings']['language'] }) }}>
            <option value="auto">{t.sLanguageAuto}</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <div className="mishu-field">{t.sLead}</div>
        <div className="mishu-grid5">
          {CATEGORIES.map(c => (
            <label key={c} className="mishu-field">{t.categories[c]}
              <input type="number" min={0} max={366} value={lead[c] ?? 0} onChange={e => setLead({ ...lead, [c]: Number(e.target.value) })} />
            </label>
          ))}
        </div>
        <button type="button" className="mishu-btn primary" onClick={() => { void save({ leadDays: lead }) }}>{t.sSave}</button>
      </section>

      <section className="mishu-panel">
        <h2>{t.sGithub}</h2>
        <label className="mishu-check"><input type="checkbox" checked={view.settings.githubEnabled} onChange={e => { void save({ githubEnabled: e.target.checked }) }} />{t.sGithubOn}</label>
        <div className="mishu-row-explain">
          <span className="mishu-row-label">{t.sToken}</span>
          <span className={token.found ? '' : 'mishu-danger'}>{token.found ? (token.from === 'env' ? t.sTokenEnv(view.github.tokenEnv) : t.sTokenGh) : token.text}</span>
        </div>
        <div className="mishu-actions">
          <button type="button" className="mishu-btn" onClick={() => {
            setGithubTest(t.sTesting)
            void settingsApi.testGithub(locale()).then(r => setGithubTest(r.ok ? t.sGithubOk(r.login) : `${t.failed}${r.message}`))
          }}>{t.sTest}</button>
          {githubTest === undefined ? null : <span className="mishu-hint">{githubTest}</span>}
        </div>
        <label className="mishu-field">{t.sMarkRead}
          <select value={view.settings.markRead} onChange={(e) => {
            const value = e.target.value as SettingsView['settings']['markRead']
            if (value === 'on') setConfirmOn(true)
            else void save({ markRead: value })
          }}>
            <option value="off">{t.sMarkOff}</option>
            <option value="shadow">{t.sMarkShadow}</option>
            <option value="on">{t.sMarkOn}</option>
          </select>
        </label>
        {confirmOn ? (
          <div className="mishu-banner">
            <div>{t.sMarkConfirm}</div>
            <div className="mishu-actions">
              <button type="button" className="mishu-btn primary" onClick={() => { setConfirmOn(false); void save({ markRead: 'on' }) }}>{t.sConfirm}</button>
              <button type="button" className="mishu-btn" onClick={() => setConfirmOn(false)}>{t.sCancel}</button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="mishu-panel">
        <h2>{t.sMail}</h2>
        <p className="mishu-hint">{t.sMailPrivacy}</p>
        <p className={view.secrets.available ? 'mishu-hint' : 'mishu-hint mishu-warn'}>{view.secrets.available ? t.sSecretsAt(secretKind) : t.sSecretsNone}</p>
        {view.accounts.length === 0 ? <p className="mishu-empty">{t.sNoAccounts}</p> : view.accounts.map(account => (
          <AccountRow key={account.id} account={account} lang={lang} locale={locale}
            onEdit={() => setEditing({ ...account })}
            onView={next => take(next)} />
        ))}
        {editing === undefined
          ? <button type="button" className="mishu-btn mishu-add-toggle" onClick={() => setEditing({ preset: 'qq', sinceDays: 14, enabled: true })}>{t.sAddAccount}</button>
          : <AccountForm draft={editing} view={view} lang={lang} locale={locale} onDone={(next) => { setEditing(undefined); if (next !== undefined) take({ ok: true, view: next }, t.sSaved) }} />}
      </section>

      <section className="mishu-panel">
        <h2>{t.sFeishu}</h2>
        <p className="mishu-hint">{t.sComing}</p>
      </section>
    </div>
  )
}

function AccountRow({ account, lang, locale, onEdit, onView }: {
  account: AccountView; lang: UiLang; locale: () => string; onEdit: () => void
  onView: (result: { ok: true; view: SettingsView } | { ok: false; message: string }) => void
}) {
  const t = TEXT[lang]
  const [busy, setBusy] = useState(false)
  const report = account.report
  const status = report === null ? t.sNeverChecked
    : report.error !== undefined ? report.error[lang]
      : (lang === 'zh' ? `${new Date(report.at).toLocaleString()} 收信，${report.messages} 封未读` : `checked ${new Date(report.at).toLocaleString()}, ${report.messages} unread`)
  return (
    <div className="mishu-card">
      <div className="mishu-card-title">{account.label}{account.enabled ? '' : ` (${lang === 'zh' ? '已停用' : 'disabled'})`}</div>
      <div className="mishu-card-meta">{account.address} · {account.host}:{account.port}</div>
      <div className={`mishu-card-note ${report?.error === undefined ? '' : 'mishu-danger'}`}>{status}</div>
      {account.hasPassword ? null : <div className="mishu-card-note mishu-warn">{t.sEnvHint(account.envName)}</div>}
      <div className="mishu-actions">
        <button type="button" className="mishu-btn" disabled={busy} onClick={() => { setBusy(true); void settingsApi.syncMail(locale(), account.id).then((r) => { setBusy(false); onView(r) }) }}>{busy ? t.sTesting : t.sCheckNow}</button>
        <button type="button" className="mishu-btn" onClick={onEdit}>{t.sEdit}</button>
        <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => {
          if (window.confirm(t.sDeleteConfirm)) void settingsApi.deleteMail(locale(), account.id).then(onView)
        }}>{t.sDelete}</button>
      </div>
    </div>
  )
}

function AccountForm({ draft, view, lang, locale, onDone }: {
  draft: AccountDraft; view: SettingsView; lang: UiLang; locale: () => string; onDone: (view?: SettingsView) => void
}) {
  const t = TEXT[lang]
  const [account, setAccount] = useState<AccountDraft>(draft)
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>()
  const [busy, setBusy] = useState(false)
  const preset = view.presets.find(p => p.id === account.preset) ?? view.presets[view.presets.length - 1]!
  const custom = preset.id === 'custom'
  const existing = draft.id !== undefined
  const set = (patch: AccountDraft) => { setAccount({ ...account, ...patch }); setMessage(undefined) }

  const test = async () => {
    setBusy(true)
    setMessage({ ok: true, text: t.sTesting })
    const r = await settingsApi.testMail(locale(), account, password)
    setBusy(false)
    setMessage(r.ok ? { ok: true, text: t.sMailOk(r.unread) } : { ok: false, text: r.message })
  }
  const save = async () => {
    setBusy(true)
    const r = await settingsApi.saveMail(locale(), account, password)
    setBusy(false)
    if (r.ok) {
      setPassword('')
      onDone(r.view)
    } else {
      setMessage({ ok: false, text: r.message })
    }
  }

  return (
    <div className="mishu-add">
      <label className="mishu-field">{t.sProvider}
        <select value={account.preset} onChange={e => set({ preset: e.target.value })}>
          {view.presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <p className={preset.supported ? 'mishu-hint' : 'mishu-hint mishu-danger'}>{preset.howTo}</p>
      <label className="mishu-field">{t.sAddress}<input type="email" value={account.address ?? ''} autoComplete="off" onChange={e => set({ address: e.target.value })} /></label>
      <div className="mishu-row">
        <label className="mishu-field">{t.sLabel}<input value={account.label ?? ''} onChange={e => set({ label: e.target.value })} /></label>
        <label className="mishu-field">{t.sUser}<input value={account.user ?? ''} placeholder={account.address ?? ''} autoComplete="off" onChange={e => set({ user: e.target.value })} /></label>
      </div>
      <label className="mishu-field">{t.sPassword}
        <input type="password" value={password} autoComplete="new-password" placeholder={existing ? t.sPasswordKeep : ''} onChange={(e) => { setPassword(e.target.value); setMessage(undefined) }} />
      </label>
      {custom ? (
        <div className="mishu-row">
          <label className="mishu-field">{t.sHost}<input value={account.host ?? ''} onChange={e => set({ host: e.target.value })} /></label>
          <label className="mishu-field">{t.sPort}<input type="number" value={account.port ?? 993} onChange={e => set({ port: Number(e.target.value) })} /></label>
        </div>
      ) : null}
      <div className="mishu-row">
        <label className="mishu-field">{t.sSince}<input type="number" min={1} max={90} value={account.sinceDays ?? 14} onChange={e => set({ sinceDays: Number(e.target.value) })} /></label>
        <label className="mishu-check"><input type="checkbox" checked={account.enabled !== false} onChange={e => set({ enabled: e.target.checked })} />{t.sEnabled}</label>
      </div>
      {message === undefined ? null : <div className={`mishu-preview ${message.ok ? '' : 'mishu-danger'}`}>{message.text}</div>}
      <div className="mishu-actions">
        <button type="button" className="mishu-btn" disabled={busy || !preset.supported} onClick={() => { void test() }}>{t.sTest}</button>
        <button type="button" className="mishu-btn primary" disabled={busy || !preset.supported} onClick={() => { void save() }}>{t.sSave}</button>
        <button type="button" className="mishu-btn" onClick={() => onDone()}>{t.sCancel}</button>
      </div>
    </div>
  )
}
