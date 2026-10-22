/**
 * The settings page: language and warning times, GitHub, mail accounts.
 *
 * Passwords are typed here and sent once to the host, which hands them
 * straight to the system keychain; the page never receives one back. The
 * page only shows what the host answers with.
 */

import { useEffect, useRef, useState } from 'react'
import { AskAI, type OpenChat } from './AskAI.tsx'
import { settingsApi, type AccountDraft, type AccountView, type DeviceView, type SettingsView } from './api.ts'
import { Modal } from './Modal.tsx'
import { TEXT, type UiLang } from './text.ts'

const CATEGORIES = ['document', 'bill', 'birthday', 'renewal', 'other'] as const

export function MishuSettings({ lang, locale, openChat }: { lang: UiLang; locale: () => string; openChat: OpenChat }) {
  const t = TEXT[lang]
  const [view, setView] = useState<SettingsView | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [lead, setLead] = useState<Record<string, number>>({})
  const [githubTest, setGithubTest] = useState<string | undefined>()
  const [confirmOn, setConfirmOn] = useState(false)
  const [pasting, setPasting] = useState(false)
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
          <span className={token.found ? '' : 'mishu-danger'}>
            {token.found ? (token.from === 'env' ? t.sTokenEnv(view.github.tokenEnv) : token.from === 'keychain' ? t.sTokenKeychain : t.sTokenGh) : token.text}
          </span>
        </div>
        {token.found ? (
          <div className="mishu-actions">
            <button type="button" className="mishu-btn" onClick={() => {
              setGithubTest(t.sTesting)
              void settingsApi.testGithub(locale()).then(r => setGithubTest(r.ok ? t.sGithubOk(r.login) : `${t.failed}${r.message}`))
            }}>{t.sTest}</button>
            {token.from === 'env' || pasting ? null : <button type="button" className="mishu-btn" onClick={() => setPasting(true)}>{t.sTokenReplace}</button>}
            {token.from === 'keychain' ? (
              <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => {
                if (window.confirm(t.sTokenRemoveConfirm)) void settingsApi.deleteToken(locale()).then(r => { setGithubTest(undefined); take(r) })
              }}>{t.sTokenRemove}</button>
            ) : null}
            {githubTest === undefined ? null : <span className="mishu-hint">{githubTest}</span>}
          </div>
        ) : null}
        {!token.found || pasting
          ? <GithubConnect view={view} lang={lang} locale={locale} onSaved={(next, login) => { setPasting(false); setGithubTest(t.sTokenSaved(login)); take({ ok: true, view: next }) }} onCancel={token.found ? () => setPasting(false) : undefined} />
          : null}
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
        <p className={view.secrets.available && view.secrets.file === undefined ? 'mishu-hint' : 'mishu-hint mishu-warn'}>
          {!view.secrets.available ? t.sSecretsNone(view.secrets.why ?? secretKind)
            : view.secrets.file !== undefined ? t.sSecretsFile(view.secrets.file.path, view.secrets.file.why)
              : t.sSecretsAt(secretKind)}
        </p>
        {view.accounts.length === 0 ? <p className="mishu-empty">{t.sNoAccounts}</p> : view.accounts.map(account => (
          <AccountRow key={account.id} account={account} secretsOk={view.secrets.available} lang={lang} locale={locale} openChat={openChat}
            onEdit={() => setEditing({ ...account })}
            onView={next => take(next)} />
        ))}
        <button type="button" className="mishu-btn mishu-add-toggle" onClick={() => setEditing({ preset: 'custom', sinceDays: 14, enabled: true })}>{t.sAddAccount}</button>
        {editing === undefined ? null : (
          <MailDialog draft={editing} view={view} lang={lang} locale={locale} openChat={openChat}
            onDone={(next, note) => { setEditing(undefined); if (next !== undefined) take({ ok: true, view: next }, note ?? t.sSaved) }} />
        )}
      </section>

      <section className="mishu-panel">
        <h2>{t.sFeishu}</h2>
        <p className="mishu-hint">{t.sComing}</p>
      </section>
    </div>
  )
}

/** Connect GitHub: "Sign in with GitHub" when an app is configured, pasting a token as the other way. */
function GithubConnect({ view, lang, locale, onSaved, onCancel }: {
  view: SettingsView; lang: UiLang; locale: () => string
  onSaved: (view: SettingsView, login: string) => void; onCancel: (() => void) | undefined
}) {
  const t = TEXT[lang]
  const [signingIn, setSigningIn] = useState(false)
  const [paste, setPaste] = useState(!view.github.deviceLogin)
  if (!view.github.deviceLogin) return <TokenForm view={view} lang={lang} locale={locale} onSaved={onSaved} onCancel={onCancel} />
  return (
    <>
      <div className="mishu-actions">
        <button type="button" className="mishu-btn primary" onClick={() => setSigningIn(true)}>{t.gLogin}</button>
        {paste ? null : <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => setPaste(true)}>{t.gPasteInstead}</button>}
        {onCancel === undefined ? null : <button type="button" className="mishu-btn" onClick={onCancel}>{t.sCancel}</button>}
      </div>
      {paste ? <TokenForm view={view} lang={lang} locale={locale} onSaved={onSaved} onCancel={undefined} /> : null}
      {signingIn ? <GithubLoginDialog lang={lang} locale={locale} onClose={() => setSigningIn(false)} onSaved={(next, login) => { setSigningIn(false); onSaved(next, login) }} /> : null}
    </>
  )
}

/** The device flow: show the code, open GitHub, wait for the host to receive the token. */
function GithubLoginDialog({ lang, locale, onClose, onSaved }: {
  lang: UiLang; locale: () => string; onClose: () => void; onSaved: (view: SettingsView, login: string) => void
}) {
  const t = TEXT[lang]
  const [login, setLogin] = useState<DeviceView | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const saved = useRef<{ view: SettingsView; login: string } | undefined>(undefined)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setLogin(undefined)
    setError(undefined)
    const poll = async () => {
      const r = await settingsApi.deviceStatus(locale())
      if (!alive) return
      if (!r.ok) { setError(r.message); return }
      setLogin(r.login)
      if (r.login.state === 'done' && r.view !== undefined) saved.current = { view: r.view, login: r.login.login }
      else if (r.login.state === 'waiting') timer = setTimeout(() => { void poll() }, 2000)
    }
    void settingsApi.deviceStart(locale()).then((r) => {
      if (!alive) return
      if (!r.ok) { setError(r.message); return }
      setLogin(r.login)
      timer = setTimeout(() => { void poll() }, 2000)
    })
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [attempt, locale])

  const close = () => {
    if (saved.current !== undefined) onSaved(saved.current.view, saved.current.login)
    else {
      void settingsApi.deviceCancel(locale())
      onClose()
    }
  }
  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => setCopied(false))
  }

  return (
    <Modal title={t.gLogin} onClose={close}>
      {error !== undefined ? (
        <>
          <div className="mishu-preview mishu-danger">{error}</div>
          <div className="mishu-actions"><button type="button" className="mishu-btn" onClick={close}>{t.gClose}</button></div>
        </>
      ) : login === undefined || login.state === 'idle' ? <p className="mishu-hint">{t.gStarting}</p>
        : login.state === 'waiting' ? (
          <>
            <div className="mishu-field">{t.gStep1}</div>
            <div className="mishu-code-row">
              <code className="mishu-code">{login.userCode}</code>
              <button type="button" className="mishu-btn" onClick={() => copy(login.userCode)}>{copied ? t.gCopied : t.gCopy}</button>
            </div>
            <div className="mishu-field">{t.gStep2}</div>
            <div className="mishu-actions">
              <button type="button" className="mishu-btn primary" onClick={() => window.open(login.verificationUri, '_blank', 'noopener')}>{t.gOpen}</button>
              <span className="mishu-hint">{t.gWaiting}</span>
            </div>
            <p className="mishu-hint">{t.gScopes}</p>
          </>
        ) : login.state === 'done' ? (
          <>
            <div className="mishu-ok">{t.gDone(login.login)}</div>
            <div className="mishu-actions"><button type="button" className="mishu-btn primary" onClick={close}>{t.gClose}</button></div>
          </>
        ) : (
          <>
            <div className="mishu-preview mishu-danger">{login.message}</div>
            <div className="mishu-actions">
              <button type="button" className="mishu-btn primary" onClick={() => { setCopied(false); setAttempt(attempt + 1) }}>{t.gRetry}</button>
              <button type="button" className="mishu-btn" onClick={close}>{t.gClose}</button>
            </div>
          </>
        )}
    </Modal>
  )
}

/** Paste a token: the host checks it with GitHub, then keeps it in the keychain. */
function TokenForm({ view, lang, locale, onSaved, onCancel }: {
  view: SettingsView; lang: UiLang; locale: () => string
  onSaved: (view: SettingsView, login: string) => void; onCancel: (() => void) | undefined
}) {
  const t = TEXT[lang]
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  if (!view.secrets.available) {
    return <p className="mishu-hint mishu-warn">{t.sTokenNoKeychain(view.github.tokenEnv, view.secrets.why ?? '')}</p>
  }
  const save = async () => {
    setBusy(true)
    setMessage(undefined)
    const r = await settingsApi.saveToken(locale(), token)
    setBusy(false)
    if (r.ok) {
      setToken('')
      onSaved(r.view, r.login)
    } else {
      setMessage(r.message)
    }
  }
  return (
    <div className="mishu-add">
      <label className="mishu-field">{t.sTokenPaste}
        <input type="password" value={token} autoComplete="off" spellCheck={false} placeholder="ghp_…" onChange={(e) => { setToken(e.target.value); setMessage(undefined) }} />
      </label>
      <p className="mishu-hint">{t.sTokenHow}</p>
      {message === undefined ? null : <div className="mishu-preview mishu-danger">{message}</div>}
      <div className="mishu-actions">
        <button type="button" className="mishu-btn" onClick={() => window.open(view.github.newTokenUrl, '_blank', 'noopener')}>{t.sTokenNew}</button>
        <button type="button" className="mishu-btn primary" disabled={busy || token.trim() === ''} onClick={() => { void save() }}>{busy ? t.sTesting : t.sTokenSave}</button>
        {onCancel === undefined ? null : <button type="button" className="mishu-btn" onClick={onCancel}>{t.sCancel}</button>}
      </div>
    </div>
  )
}

function AccountRow({ account, secretsOk, lang, locale, openChat, onEdit, onView }: {
  account: AccountView; secretsOk: boolean; lang: UiLang; locale: () => string; openChat: OpenChat; onEdit: () => void
  onView: (result: { ok: true; view: SettingsView } | { ok: false; message: string }) => void
}) {
  const t = TEXT[lang]
  const [busy, setBusy] = useState(false)
  const report = account.report
  // One line about the password when there is none; the sync's own error would only say it again.
  const status = !account.hasPassword ? (secretsOk ? t.sNoPassword : t.sEnvHint(account.envName))
    : report === null ? t.sNeverChecked
      : report.error !== undefined ? report.error[lang]
        : (lang === 'zh' ? `${new Date(report.at).toLocaleString()} 收信，${report.messages} 封未读` : `checked ${new Date(report.at).toLocaleString()}, ${report.messages} unread`)
  const failed = !account.hasPassword || report?.error !== undefined
  return (
    <div className="mishu-card">
      <div className="mishu-card-title">{account.label}{account.enabled ? '' : ` (${lang === 'zh' ? '已停用' : 'disabled'})`}</div>
      <div className="mishu-card-meta">{account.address} · {account.host}:{account.port}</div>
      {account.mismatch === null ? null : <div className="mishu-card-note mishu-warn">{account.mismatch}</div>}
      <div className={`mishu-card-note ${failed ? 'mishu-danger' : ''}`}>
        {status}
        {account.hasPassword && report?.error !== undefined ? <AskAI topic={{ kind: 'mail-error', accountId: account.id }} lang={lang} locale={locale} openChat={openChat} compact /> : null}
      </div>
      <div className="mishu-actions">
        <button type="button" className="mishu-btn" disabled={busy || !account.hasPassword} onClick={() => { setBusy(true); void settingsApi.syncMail(locale(), account.id).then((r) => { setBusy(false); onView(r) }) }}>{busy ? t.sTesting : t.sCheckNow}</button>
        <button type="button" className={account.hasPassword && account.mismatch === null ? 'mishu-btn' : 'mishu-btn primary'} onClick={onEdit}>{t.sEdit}</button>
        <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => {
          if (window.confirm(t.sDeleteConfirm)) void settingsApi.deleteMail(locale(), account.id).then(onView)
        }}>{t.sDelete}</button>
      </div>
    </div>
  )
}

/**
 * Add or edit a mail account in a dialog: the address picks the provider,
 * the provider's steps say where its app password comes from (with the page
 * to open), and "Test and save" only keeps an account that connects.
 */
function MailDialog({ draft, view, lang, locale, openChat, onDone }: {
  draft: AccountDraft; view: SettingsView; lang: UiLang; locale: () => string; openChat: OpenChat
  onDone: (view?: SettingsView, note?: string) => void
}) {
  const t = TEXT[lang]
  const existing = draft.id !== undefined
  const [account, setAccount] = useState<AccountDraft>(draft)
  // Once you pick a provider yourself (or edit an account), the address no longer changes it.
  const [picked, setPicked] = useState(existing)
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>()
  const [failedTest, setFailedTest] = useState(false)
  const [busy, setBusy] = useState(false)
  const preset = view.presets.find(p => p.id === account.preset) ?? view.presets[view.presets.length - 1]!
  const custom = preset.id === 'custom'
  const set = (patch: AccountDraft) => { setAccount({ ...account, ...patch }); setMessage(undefined); setFailedTest(false) }

  const setAddress = (address: string) => {
    const domain = address.trim().toLowerCase().split('@')[1] ?? ''
    const known = view.presets.find(p => p.domains.includes(domain))
    set({ address, ...picked ? {} : known !== undefined ? { preset: known.id } : domain.includes('.') ? { preset: 'custom' } : {} })
  }
  const typed = password.replace(/\s+/g, '')
  const lengthOff = preset.passwordLength !== null && typed !== '' && typed.length !== preset.passwordLength

  const save = async (unread?: number) => {
    const r = await settingsApi.saveMail(locale(), account, password)
    setBusy(false)
    if (r.ok) onDone(r.view, unread === undefined ? undefined : t.mSavedUnread(unread))
    else setMessage({ ok: false, text: r.message })
  }
  const testAndSave = async () => {
    setBusy(true)
    setMessage({ ok: true, text: t.sTesting })
    const r = await settingsApi.testMail(locale(), account, password)
    if (r.ok) {
      await save(r.unread)
    } else {
      setBusy(false)
      setFailedTest(true)
      setMessage({ ok: false, text: r.message })
    }
  }

  return (
    <Modal title={existing ? t.mTitleEdit : t.mTitleAdd} onClose={() => onDone()}>
      <label className="mishu-field">{t.sAddress}
        <input type="email" value={account.address ?? ''} autoComplete="off" autoFocus={!existing} onChange={e => setAddress(e.target.value)} />
      </label>
      <label className="mishu-field">{t.sProvider}
        <select value={account.preset} onChange={(e) => { setPicked(true); set({ preset: e.target.value }) }}>
          {view.presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      {/* After a failed test the steps light up: that is where the fix is. */}
      <div className={`mishu-steps${preset.supported ? '' : ' mishu-danger'}${failedTest ? ' attention' : ''}`}>
        {preset.steps.length === 0 ? preset.howTo : (
          <ol>
            {preset.steps.map((step, i) => (
              <li key={i}>
                {step.text}
                {step.link === undefined ? null : <> <button type="button" className="mishu-btn" onClick={() => window.open(step.link!.url, '_blank', 'noopener')}>{step.link.label}</button></>}
              </li>
            ))}
          </ol>
        )}
        {preset.supported ? (
          <div className="mishu-steps-help">
            {t.mStepsHelp}
            <AskAI topic={{ kind: 'mail-setup', preset: preset.id }} lang={lang} locale={locale} openChat={openChat} compact />
          </div>
        ) : null}
      </div>
      <label className="mishu-field">{t.sPassword}
        <input type="password" value={password} autoComplete="new-password" placeholder={existing && view.secrets.available ? t.sPasswordKeep : ''} onChange={(e) => { setPassword(e.target.value); setMessage(undefined); setFailedTest(false) }} />
      </label>
      {lengthOff ? <p className="mishu-hint mishu-warn">{t.mLength(preset.label, preset.passwordLength!, typed.length)}</p> : null}
      {view.secrets.available ? null : <p className="mishu-hint mishu-warn">{t.sPasswordTestOnly}</p>}
      {custom ? (
        <div className="mishu-row">
          <label className="mishu-field">{t.sHost}<input value={account.host ?? ''} placeholder="imap.example.com" onChange={e => set({ host: e.target.value })} /></label>
          <label className="mishu-field">{t.sPort}<input type="number" value={account.port ?? 993} onChange={e => set({ port: Number(e.target.value) })} /></label>
        </div>
      ) : null}
      <details className="mishu-more">
        <summary>{t.mMore}</summary>
        <div className="mishu-row">
          <label className="mishu-field">{t.sLabel}<input value={account.label ?? ''} placeholder={account.address ?? ''} onChange={e => set({ label: e.target.value })} /></label>
          <label className="mishu-field">{t.sUser}<input value={account.user ?? ''} placeholder={account.address ?? ''} autoComplete="off" onChange={e => set({ user: e.target.value })} /></label>
        </div>
        <div className="mishu-row">
          <label className="mishu-field">{t.sSince}<input type="number" min={1} max={90} value={account.sinceDays ?? 14} onChange={e => set({ sinceDays: Number(e.target.value) })} /></label>
          <label className="mishu-check"><input type="checkbox" checked={account.enabled !== false} onChange={e => set({ enabled: e.target.checked })} />{t.sEnabled}</label>
        </div>
      </details>
      {message === undefined ? null : (
        <div className={`mishu-preview ${message.ok ? '' : 'mishu-danger'}`}>
          {message.text}
          {message.ok || !preset.supported ? null : <AskAI topic={{ kind: 'mail-setup', preset: preset.id, error: message.text }} lang={lang} locale={locale} openChat={openChat} compact />}
        </div>
      )}
      <div className="mishu-actions">
        <button type="button" className="mishu-btn primary" disabled={busy || !preset.supported || (account.address ?? '') === ''} onClick={() => { void testAndSave() }}>{busy ? t.sTesting : t.mTestSave}</button>
        {failedTest ? <button type="button" className="mishu-btn mishu-btn-quiet" disabled={busy} onClick={() => { setBusy(true); void save() }}>{t.mSaveAnyway}</button> : null}
        <button type="button" className="mishu-btn" onClick={() => onDone()}>{t.sCancel}</button>
      </div>
    </Modal>
  )
}
