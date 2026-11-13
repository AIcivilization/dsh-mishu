/**
 * The mail page: folders on the left, a list in the middle, one message on the
 * right, and a composer over the whole thing.
 *
 * The page never holds a message of its own: every list, body and folder comes
 * from the host, and after any change (marking read, moving, sending) the page
 * asks again instead of patching what it has. That is the same rule the board
 * follows, and it is why a message that changed in another client looks right
 * here too.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  mailApi, settingsApi,
  type AccountView, type DraftView, type MailBody, type MailFolder, type MailListPage,
  type MailSearchResult, type MailSummary, type MarkAction,
} from './api.ts'
import { Modal } from './Modal.tsx'
import { TEXT, type UiLang } from './text.ts'

/** The composer's fields, kept as text so a half-typed address is not lost. */
interface Compose {
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  attachments: string
}

const EMPTY: Compose = { to: '', cc: '', bcc: '', subject: '', text: '', attachments: '' }

/** One attachment path per line, blanks dropped. */
function lines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(line => line !== '')
}

function draftOf(draft: DraftView): Compose {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
    attachments: draft.attachments.join('\n'),
  }
}

function when(date: number, locale: string): string {
  const at = new Date(date)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * Turn what a `<input type="datetime-local">` gives (wall clock, no zone) into
 * an instant that names its zone. The browser parses the value as local time,
 * so the offset it prints is the one the user meant — which is the whole
 * reason the server refuses a time without one.
 */
function zonedIso(local: string): string | undefined {
  const at = new Date(local)
  if (local === '' || Number.isNaN(at.getTime())) return undefined
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, '0')
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/**
 * Which folder the mailbox itself calls Trash. Deleting inside Trash has to be
 * the permanent kind, because moving a message to where it already is does
 * nothing and would look like it worked.
 */
function trashOf(folders: readonly MailFolder[]): string {
  const found = folders.find(folder => folder.specialUse === '\\Trash' || /^(trash|deleted items|deleted messages|已删除|已删除邮件|废纸篓|回收站)$/i.test(folder.path))
  return found?.path ?? 'Trash'
}

function who(from: MailSummary['from']): string {
  if (from === null) return '—'
  return from.name === '' ? from.address : from.name
}

export function MishuMail({ lang, locale }: { lang: UiLang; locale: () => string }) {
  const t = TEXT[lang]
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [account, setAccount] = useState<number | undefined>()
  const [folders, setFolders] = useState<MailFolder[]>([])
  const [folder, setFolder] = useState('INBOX')
  const [page, setPage] = useState<MailListPage | undefined>()
  const [found, setFound] = useState<MailSearchResult | undefined>()
  const [open, setOpen] = useState<MailBody | undefined>()
  const [drafts, setDrafts] = useState<DraftView[]>([])
  const [query, setQuery] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [composing, setComposing] = useState<Compose | undefined>()
  const [editing, setEditing] = useState<{ id: string; revision: number } | undefined>()
  // A reply keeps the thread only if it goes out through the reply endpoint,
  // so which message is being answered has to survive until the send.
  const [answering, setAnswering] = useState<{ folder: string; uid: number; mode: 'reply' | 'reply-all' | 'forward' } | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()
  // Which folder is being renamed, and the name typed for a new one.
  const [renaming, setRenaming] = useState<string | undefined>()
  const [naming, setNaming] = useState<string | undefined>()
  // The wall clock typed into the composer's schedule row; '' means no row.
  const [scheduledAt, setScheduledAt] = useState<string>('')
  // Uids ticked in the list. A selection only ever means messages in the
  // folder on screen, and changing folder is the same as unticking everything.
  const [picked, setPicked] = useState<number[]>([])

  const fail = (result: { ok: false; message: string } | { ok: true }) => {
    if (!result.ok) setError(result.message)
  }

  const pick = useCallback(async () => {
    const view = await settingsApi.load(locale())
    if (!view.ok) {
      setError(view.message)
      return
    }
    const enabled = view.view.accounts.filter(a => a.enabled)
    setAccounts(enabled)
    setAccount(current => current ?? enabled[0]?.id)
  }, [locale])

  useEffect(() => { void pick() }, [pick])

  const loadFolders = useCallback(async () => {
    if (account === undefined) return
    const result = await mailApi.folders(locale(), account)
    if (result.ok) setFolders(result.folders)
    else fail(result)
  }, [account, locale])

  const loadPage = useCallback(async (target = folder, offset = 0) => {
    if (account === undefined) return
    const result = await mailApi.list(locale(), account, { folder: target, limit: 30, offset, unreadOnly })
    if (!result.ok) {
      fail(result)
      return
    }
    setPage(previous => offset > 0 && previous !== undefined && previous.folder === target
      ? { ...result.page, messages: [...previous.messages, ...result.page.messages] }
      : result.page)
    setError(undefined)
  }, [account, folder, locale, unreadOnly])

  const loadDrafts = useCallback(async () => {
    if (account === undefined) return
    const result = await mailApi.drafts(locale(), account)
    if (result.ok) setDrafts(result.drafts)
    else fail(result)
  }, [account, locale])

  /**
   * Folders are made, renamed and deleted from here; each call hands back the
   * server's list, so the panel never shows a folder that is not really there.
   */
  const folderAction = async (action: 'create' | 'rename' | 'delete', path: string, next?: string) => {
    if (account === undefined) return
    const result = action === 'create'
      ? await mailApi.createFolder(locale(), account, path)
      : action === 'rename'
        ? await mailApi.renameFolder(locale(), account, path, next ?? '')
        : await mailApi.deleteFolder(locale(), account, path)
    if (!result.ok) {
      fail(result)
      return
    }
    setFolders(result.folders)
    setRenaming(undefined)
    setNaming(undefined)
    setNote(action === 'delete' ? t.mailFolderGone(path) : t.mailFolderSaved)
    // A folder that just went away cannot stay selected.
    if (action === 'delete' && folder === path) setFolder('INBOX')
  }

  useEffect(() => {
    if (account === undefined) return
    void loadFolders()
    void loadDrafts()
  }, [account, loadFolders, loadDrafts])

  useEffect(() => {
    setOpen(undefined)
    setFound(undefined)
    setPicked([])
    void loadPage(folder, 0)
  }, [folder, unreadOnly, loadPage])

  const readOne = async (item: MailSummary) => {
    if (account === undefined) return
    setBusy(true)
    const result = await mailApi.read(locale(), account, item.folder, item.uid)
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setOpen(result.message)
    setError(undefined)
    // Reading a message is what "read" means, so the list is asked again.
    void loadPage(folder, 0)
  }

  const mark = async (action: 'read' | 'unread' | 'star' | 'unstar', item: MailSummary) => {
    if (account === undefined) return
    const result = await mailApi.mark(locale(), account, item.folder, item.uid, action)
    if (!result.ok) {
      fail(result)
      return
    }
    void loadPage(folder, 0)
    if (open !== undefined && open.uid === item.uid) setOpen({ ...open, seen: action === 'read', flagged: action === 'star' })
  }

  const move = async (item: MailSummary, destination: string) => {
    if (account === undefined || destination === '') return
    const result = await mailApi.mark(locale(), account, item.folder, item.uid, 'move', destination)
    if (!result.ok) {
      fail(result)
      return
    }
    setOpen(undefined)
    void loadPage(folder, 0)
  }

  /**
   * One action over everything ticked. Nothing is guessed: delete asks first,
   * purge asks with the word Trash in it, and the selection is cleared after.
   */
  const batch = async (action: MarkAction, confirmText?: string, destination?: string) => {
    if (account === undefined || picked.length === 0) {
      setError(t.mailPickSome)
      return
    }
    if (confirmText !== undefined && !window.confirm(confirmText)) return
    setBusy(true)
    const result = await mailApi.markMany(locale(), account, folder, picked, action, destination)
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    const done = result.results.length
    setNote(action === 'delete' ? t.mailDeleted(done) : action === 'purge' ? t.mailPurged(done) : action === 'move' ? t.mailMoved(done, destination ?? '') : t.mailChanged(done))
    setPicked([])
    setOpen(undefined)
    setError(undefined)
    void loadPage(folder, 0)
    void loadFolders()
  }

  /** One message, straight from the read pane; same endpoints as the bar. */
  const remove = async (item: MailBody) => {
    if (account === undefined) return
    const trash = trashOf(folders)
    const already = item.folder === trash
    if (!window.confirm(already ? t.mailPurgeConfirm(1) : t.mailDeleteManyConfirm(1))) return
    const result = await mailApi.mark(locale(), account, item.folder, item.uid, already ? 'purge' : 'delete')
    if (!result.ok) {
      fail(result)
      return
    }
    setNote(already ? t.mailPurged(1) : t.mailDeleted(1))
    setOpen(undefined)
    setError(undefined)
    void loadPage(folder, 0)
    void loadFolders()
  }

  const search = async () => {
    if (account === undefined) return
    const text = query.trim()
    if (text === '') {
      setFound(undefined)
      return
    }
    setBusy(true)
    const result = await mailApi.search(locale(), account, text, { folder, limit: 30 })
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setFound(result.found)
    setError(undefined)
  }

  const saveAttachment = async (item: MailBody, index: number) => {
    if (account === undefined) return
    const result = await mailApi.attachment(locale(), account, item.folder, item.uid, index)
    if (!result.ok) {
      fail(result)
      return
    }
    setNote(t.mailSaved(result.file.path))
  }

  const send = async () => {
    if (account === undefined || composing === undefined) return
    // What was opened from the drawer is a draft: sending it has to go through
    // the draft (after saving the edits), or the drawer keeps a copy of a
    // message that has already left.
    if (editing !== undefined) {
      setBusy(true)
      const saved = await mailApi.editDraft(locale(), account, editing.id, editing.revision, {
        ...composing, attachments: lines(composing.attachments), reply: answering,
      })
      if (!saved.ok) {
        setBusy(false)
        fail(saved)
        return
      }
      let live = saved.draft
      if (live.state === 'scheduled') {
        const off = await mailApi.cancelSchedule(locale(), live.id, live.revision)
        if (!off.ok) {
          setBusy(false)
          fail(off)
          return
        }
        live = off.draft
      }
      const sent = await mailApi.sendDraft(locale(), account, live.id, live.revision)
      setBusy(false)
      if (!sent.ok) {
        fail(sent)
        void loadDrafts()
        return
      }
      setComposing(undefined)
      setEditing(undefined)
      setAnswering(undefined)
      setScheduledAt('')
      setError(undefined)
      setNote(t.mailSent(sent.sent.messageId))
      void loadDrafts()
      void loadPage(folder, 0)
      return
    }
    setBusy(true)
    const draft = { ...composing, attachments: lines(composing.attachments) }
    // Answering goes through the reply endpoint: it fills the recipients from
    // the original and keeps In-Reply-To, so the message joins the thread.
    const result = answering === undefined
      ? await mailApi.send(locale(), account, draft)
      : await mailApi.reply(locale(), account, answering.folder, answering.uid, answering.mode, draft.text, {
        attachments: draft.attachments,
        bcc: draft.bcc,
        ...answering.mode === 'forward' ? { to: draft.to, cc: draft.cc } : {},
      })
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setComposing(undefined)
    setAnswering(undefined)
    setError(undefined)
    setNote(t.mailSent(result.sent.messageId))
    void loadPage(folder, 0)
  }

  const keep = async () => {
    if (account === undefined || composing === undefined) return
    const draft = { ...composing, attachments: lines(composing.attachments), reply: answering }
    const result = editing === undefined
      ? await mailApi.saveDraft(locale(), account, draft)
      : await mailApi.editDraft(locale(), account, editing.id, editing.revision, draft)
    if (!result.ok) {
      fail(result)
      return
    }
    setComposing(undefined)
    setEditing(undefined)
    setAnswering(undefined)
    setNote(t.mailDraftSaved)
    void loadDrafts()
  }

  /**
   * Put what is being written on the clock. The draft is saved first (a
   * scheduled send is a draft with a time), so the message is in the drawer
   * even if the clock is refused.
   */
  const scheduleLater = async () => {
    if (account === undefined || composing === undefined) return
    const when = zonedIso(scheduledAt)
    if (when === undefined) {
      setError(t.mailScheduleBad)
      return
    }
    setBusy(true)
    const draft = { ...composing, attachments: lines(composing.attachments), reply: answering }
    const kept = editing === undefined
      ? await mailApi.saveDraft(locale(), account, draft)
      : await mailApi.editDraft(locale(), account, editing.id, editing.revision, draft)
    if (!kept.ok) {
      setBusy(false)
      fail(kept)
      return
    }
    const result = await mailApi.scheduleDraft(locale(), account, kept.draft.id, kept.draft.revision, when)
    setBusy(false)
    if (!result.ok) {
      fail(result)
      void loadDrafts()
      return
    }
    setComposing(undefined)
    setEditing(undefined)
    setAnswering(undefined)
    setScheduledAt('')
    setError(undefined)
    setNote(t.mailScheduled(when))
    void loadDrafts()
  }

  const unschedule = async (draft: DraftView) => {
    const result = await mailApi.cancelSchedule(locale(), draft.id, draft.revision)
    if (!result.ok) {
      fail(result)
      return
    }
    setNote(t.mailScheduleOff)
    void loadDrafts()
  }

  /**
   * A scheduled draft is not a draft any more, so the ordinary send would be
   * refused; take it off the clock first, then send what it says.
   */
  const sendKept = async (draft: DraftView) => {
    if (account === undefined) return
    let live = draft
    if (draft.state === 'scheduled') {
      const off = await mailApi.cancelSchedule(locale(), draft.id, draft.revision)
      if (!off.ok) {
        fail(off)
        return
      }
      live = off.draft
    }
    const result = await mailApi.sendDraft(locale(), account, live.id, live.revision)
    if (!result.ok) {
      fail(result)
      void loadDrafts()
      return
    }
    setNote(t.mailSent(result.sent.messageId))
    void loadDrafts()
  }

  const throwAway = async (draft: DraftView) => {
    const result = await mailApi.deleteDraft(locale(), draft.id)
    if (!result.ok) {
      fail(result)
      return
    }
    void loadDrafts()
  }

  const reply = (item: MailBody, mode: 'reply' | 'reply-all' | 'forward') => {
    setEditing(undefined)
    setAnswering({ folder: item.folder, uid: item.uid, mode })
    const mine = (accounts.find(a => a.id === account)?.address ?? '').toLowerCase()
    // Reply-all shows the others in Cc; the server works the list out again
    // from the original when it sends, so this is only what you see.
    const others = mode === 'reply-all'
      ? [...item.to, ...item.cc].map(a => a.address).filter(a => a !== '' && a.toLowerCase() !== mine && a !== item.from?.address)
      : []
    setComposing({
      ...EMPTY,
      subject: mode === 'forward' ? `Fwd: ${item.subject}` : `Re: ${item.subject}`,
      to: mode === 'forward' ? '' : (item.from?.address ?? ''),
      cc: [...new Set(others)].join(', '),
      text: mode === 'forward'
        ? `\n\n---------- Forwarded message ----------\n${item.text}`
        : `\n\n${item.text.split('\n').map(line => `> ${line}`).join('\n')}`,
    })
  }

  const messages = found !== undefined ? found.messages : (page?.messages ?? [])
  const total = found !== undefined ? found.messages.length : (page?.total ?? 0)
  const folderChoices = useMemo(() => {
    if (folders.length > 0) return folders
    return [{ path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: [] as string[] }] as MailFolder[]
  }, [folders])

  if (accounts.length === 0) return <div className="mishu-mail"><p className="mishu-empty">{t.mailNoAccount}</p></div>

  return (
    <div className="mishu-mail">
      {error === undefined ? null : <div className="mishu-error">{t.failed}{error}</div>}
      {note === undefined ? null : <div className="mishu-ok mishu-mail-note">{note}</div>}
      <div className="mishu-mail-bar">
        {accounts.length > 1 ? (
          <select value={account ?? ''} onChange={(event) => setAccount(Number(event.target.value))} aria-label={t.mailAccount}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.label || a.address}</option>)}
          </select>
        ) : <span className="mishu-mail-who">{accounts[0]?.label || accounts[0]?.address}</span>}
        <label className="mishu-check mishu-check-inline">
          <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />{t.mailUnreadOnly}
        </label>
        <input
          className="mishu-mail-search"
          value={query}
          placeholder={t.mailSearchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void search() }}
        />
        <button type="button" className="mishu-btn" disabled={busy} onClick={() => { void search() }}>{t.mailSearch}</button>
        <button type="button" className="mishu-btn" disabled={busy} onClick={() => { setFound(undefined); setQuery(''); void loadPage(folder, 0) }}>{t.mailRefresh}</button>
        <button type="button" className="mishu-btn primary" onClick={() => { setEditing(undefined); setAnswering(undefined); setScheduledAt(''); setComposing({ ...EMPTY }) }}>{t.mailCompose}</button>
      </div>

      <div className="mishu-mail-body">
        <div className="mishu-mail-folders">
          <div className="mishu-mail-label">{t.mailFolders}</div>
          {folderChoices.map(item => (
            <div key={item.path} className={`mishu-mail-folder-row${item.path === folder ? ' active' : ''}`}>
              <button
                type="button"
                className={`mishu-mail-folder${item.path === folder ? ' active' : ''}`}
                onClick={() => { setFound(undefined); setFolder(item.path) }}
              >
                <span>{item.name}</span>
                {item.unread === undefined ? null : <small>{item.unread}</small>}
              </button>
              {/* The mailbox's own folders are not ours to rename or delete. */}
              {item.specialUse === null ? (
                <span className="mishu-mail-folder-tools">
                  <button type="button" title={t.mailFolderRename} onClick={() => { setNaming(undefined); setRenaming(item.path) }}>✎</button>
                  <button type="button" title={t.mailFolderDelete} onClick={() => { void folderAction('delete', item.path) }}>✕</button>
                </span>
              ) : null}
            </div>
          ))}
          {renaming === undefined ? null : (
            <form className="mishu-mail-folder-form" onSubmit={(event) => {
              event.preventDefault()
              const typed = new FormData(event.currentTarget).get('name')
              void folderAction('rename', renaming, String(typed ?? ''))
            }}>
              <input name="name" defaultValue={renaming} aria-label={t.mailFolderName} autoFocus />
              <button type="submit" className="mishu-btn">{t.mailFolderRename}</button>
            </form>
          )}
          {naming === undefined ? (
            <button type="button" className="mishu-btn mishu-mail-folder-new" onClick={() => { setRenaming(undefined); setNaming('') }}>{t.mailNewFolder}</button>
          ) : (
            <form className="mishu-mail-folder-form" onSubmit={(event) => {
              event.preventDefault()
              const typed = new FormData(event.currentTarget).get('name')
              void folderAction('create', String(typed ?? ''))
            }}>
              <input name="name" placeholder={t.mailFolderName} aria-label={t.mailFolderName} autoFocus />
              <button type="submit" className="mishu-btn">{t.mailNewFolder}</button>
            </form>
          )}
          {drafts.length === 0 ? null : (
            <>
              <div className="mishu-mail-label">{t.mailDrafts}</div>
              {drafts.map(draft => (
                <div key={draft.id} className="mishu-mail-draft">
                  <button type="button" className="mishu-mail-draft-title" onClick={() => { setEditing({ id: draft.id, revision: draft.revision }); setAnswering(draft.reply ?? undefined); setComposing(draftOf(draft)); setScheduledAt('') }}>
                    {draft.subject || t.mailNoSubject}
                  </button>
                  {draft.state === 'scheduled' && draft.sendAt !== null
                    ? <div className="mishu-mail-draft-when">{t.mailDue(when(draft.sendAt, locale()))}</div>
                    : null}
                  {draft.error === null ? null : <div className="mishu-mail-draft-why">{draft.error}</div>}
                  <div className="mishu-mail-draft-actions">
                    <button type="button" className="mishu-btn" onClick={() => { void sendKept(draft) }}>{t.mailSendDraft}</button>
                    {draft.state === 'scheduled'
                      ? <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => { void unschedule(draft) }}>{t.mailScheduleCancel}</button>
                      : null}
                    <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => { void throwAway(draft) }}>{t.mailDeleteDraft}</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="mishu-mail-list">
          {messages.length === 0 ? <p className="mishu-empty">{t.mailNoMessages}</p> : null}
          {/* A search can return messages from other folders, and a uid only
              means something inside its own folder — so ticking is for the
              folder list only. */}
          {messages.length === 0 || found !== undefined ? null : (
            <div className="mishu-mail-selectbar">
              <label className="mishu-check mishu-check-inline">
                <input
                  type="checkbox"
                  checked={picked.length > 0 && picked.length === messages.length}
                  onChange={(event) => setPicked(event.target.checked ? messages.map(item => item.uid) : [])}
                />{t.mailSelectAll}
              </label>
              {picked.length === 0 ? null : <span className="mishu-mail-picked">{t.mailSelected(picked.length)}</span>}
              {picked.length === 0 ? null : (
                <>
                  <button type="button" className="mishu-btn" disabled={busy} onClick={() => { void batch('read') }}>{t.mailMarkReadMany}</button>
                  <button type="button" className="mishu-btn" disabled={busy} onClick={() => { void batch('unread') }}>{t.mailMarkUnreadMany}</button>
                  <select className="mishu-mail-move" defaultValue="" onChange={(event) => { void batch('move', undefined, event.target.value); event.target.value = '' }}>
                    <option value="">{t.mailMoveTo}</option>
                    {folderChoices.filter(f => f.path !== folder).map(f => <option key={f.path} value={f.path}>{f.name}</option>)}
                  </select>
                  {folder === trashOf(folders) ? (
                    <button type="button" className="mishu-btn" disabled={busy} onClick={() => { void batch('purge', t.mailPurgeConfirm(picked.length)) }}>{t.mailPurge}</button>
                  ) : (
                    <button type="button" className="mishu-btn" disabled={busy} onClick={() => { void batch('delete', t.mailDeleteManyConfirm(picked.length)) }}>{t.mailDeleteMany}</button>
                  )}
                </>
              )}
            </div>
          )}
          {messages.map(item => (
            <div key={`${item.folder}-${item.uid}`} className="mishu-mail-line">
              {found !== undefined ? null : (
                <input
                  type="checkbox"
                  className="mishu-mail-pick"
                  aria-label={t.mailSelectAll}
                  checked={picked.includes(item.uid)}
                  onChange={(event) => setPicked(current => event.target.checked ? [...current, item.uid] : current.filter(uid => uid !== item.uid))}
                />
              )}
              <button
                type="button"
                className={`mishu-mail-item${item.seen ? '' : ' unread'}${open?.uid === item.uid && open.folder === item.folder ? ' active' : ''}`}
                onClick={() => { void readOne(item) }}
              >
                <div className="mishu-mail-item-top">
                  <span className="mishu-mail-from">{who(item.from)}</span>
                  <span className="mishu-mail-date">{when(item.date, locale())}</span>
                </div>
                <div className="mishu-mail-subject">
                  {item.flagged ? '★ ' : ''}{item.subject || t.mailNoSubject}
                  {item.hasAttachments ? <span className="mishu-mail-tag">📎</span> : null}
                  {item.hasCalendar ? <span className="mishu-mail-tag">🗓</span> : null}
                </div>
              </button>
            </div>
          ))}
          {found !== undefined || page === undefined || page.messages.length >= total ? null : (
            <button type="button" className="mishu-btn mishu-mail-more" onClick={() => { void loadPage(folder, page.messages.length) }}>{t.mailLoadMore}</button>
          )}
        </div>

        <div className="mishu-mail-read">
          {open === undefined ? <p className="mishu-empty">{t.mailPickOne}</p> : (
            <>
              <h2 className="mishu-mail-title">{open.subject || t.mailNoSubject}</h2>
              <div className="mishu-mail-meta">
                <span>{t.mailFrom}：{open.from === null ? '—' : `${open.from.name} <${open.from.address}>`}</span>
                <span>{t.mailDate}：{when(open.date, locale())}</span>
              </div>
              <div className="mishu-actions">
                <button type="button" className="mishu-btn" onClick={() => { void mark(open.seen ? 'unread' : 'read', open) }}>{open.seen ? t.mailMarkUnread : t.mailMarkRead}</button>
                <button type="button" className="mishu-btn" onClick={() => { void mark(open.flagged ? 'unstar' : 'star', open) }}>{open.flagged ? t.mailUnstar : t.mailStar}</button>
                <button type="button" className="mishu-btn" onClick={() => reply(open, 'reply')}>{t.mailReply}</button>
                <button type="button" className="mishu-btn" onClick={() => reply(open, 'reply-all')}>{t.mailReplyAll}</button>
                <button type="button" className="mishu-btn" onClick={() => reply(open, 'forward')}>{t.mailForward}</button>
                <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => { void remove(open) }}>
                  {open.folder === trashOf(folders) ? t.mailPurge : t.mailDeleteOne}
                </button>
                <select className="mishu-mail-move" defaultValue="" onChange={(event) => { void move(open, event.target.value); event.target.value = '' }}>
                  <option value="">{t.mailMoveTo}</option>
                  {folderChoices.filter(f => f.path !== open.folder).map(f => <option key={f.path} value={f.path}>{f.name}</option>)}
                </select>
              </div>
              {open.attachments.length === 0 ? null : (
                <div className="mishu-mail-attachments">
                  <div className="mishu-mail-label">{t.mailAttachments}</div>
                  {open.attachments.map(file => (
                    <div key={file.index} className="mishu-mail-attachment">
                      <span>{file.filename} · {Math.max(1, Math.round(file.size / 1024))} KB</span>
                      <button type="button" className="mishu-btn" onClick={() => { void saveAttachment(open, file.index) }}>{t.mailDownload}</button>
                    </div>
                  ))}
                </div>
              )}
              <pre className="mishu-mail-text">{open.text}</pre>
              {open.truncated ? <p className="mishu-hint">{t.mailTruncated}</p> : null}
            </>
          )}
        </div>
      </div>

      {composing === undefined ? null : (
        <Modal title={editing === undefined ? t.mailCompose : t.mailDrafts} onClose={() => { setComposing(undefined); setEditing(undefined); setAnswering(undefined); setScheduledAt('') }}>
          <label className="mishu-field">{t.mailTo}
            <input value={composing.to} onChange={(event) => setComposing({ ...composing, to: event.target.value })} placeholder="a@example.com, b@example.com" />
          </label>
          <div className="mishu-row">
            <label className="mishu-field">Cc
              <input value={composing.cc} onChange={(event) => setComposing({ ...composing, cc: event.target.value })} />
            </label>
            <label className="mishu-field">Bcc
              <input value={composing.bcc} onChange={(event) => setComposing({ ...composing, bcc: event.target.value })} />
            </label>
          </div>
          <label className="mishu-field">{t.mailSubject}
            <input value={composing.subject} onChange={(event) => setComposing({ ...composing, subject: event.target.value })} />
          </label>
          <label className="mishu-field">{t.mailBody}
            <textarea rows={10} value={composing.text} onChange={(event) => setComposing({ ...composing, text: event.target.value })} />
          </label>
          <label className="mishu-field">{t.mailAttachPaths}
            <textarea rows={2} value={composing.attachments} onChange={(event) => setComposing({ ...composing, attachments: event.target.value })} />
          </label>
          <label className="mishu-field">{t.mailScheduleAt}
            <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
          </label>
          <div className="mishu-actions">
            <button type="button" className="mishu-btn primary" disabled={busy} onClick={() => { void send() }}>{t.mailSend}</button>
            <button type="button" className="mishu-btn" disabled={busy} onClick={() => { void keep() }}>{t.mailSaveDraft}</button>
            {scheduledAt === '' ? null : (
              <button type="button" className="mishu-btn" disabled={busy} onClick={() => { void scheduleLater() }}>{t.mailSchedule}</button>
            )}
            <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => { setComposing(undefined); setEditing(undefined); setAnswering(undefined); setScheduledAt('') }}>{t.cancel}</button>
          </div>
          <p className="mishu-hint">{t.mailSendHint}</p>
          <p className="mishu-hint">{t.mailScheduleHint}</p>
        </Modal>
      )}
    </div>
  )
}
