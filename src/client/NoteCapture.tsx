/**
 * Capture from anywhere: one key, one box, saved.
 *
 * The tab is where notes are read; this is where they are made. It sits at
 * the window level rather than inside the page, because the thought usually
 * arrives while you are doing something else — having to open the panel first
 * is exactly the friction the whole feature exists to remove.
 *
 * It is also deliberately quiet: the box opens with focus in it, saves on
 * Ctrl/Cmd+Enter, closes on Escape, and says nothing else. No confirmation
 * dialog, no "saved!" toast to dismiss. If a capture fails, the box stays open
 * with the text still in it — losing what you typed would be the one
 * unforgivable outcome here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { STYLES } from './styles.ts'

/** The key: Alt+Space, the same muscle memory the standalone note plugin used. */
export const CAPTURE_SHORTCUT = { alt: true, code: 'Space' }

const WORDS = {
  zh: {
    title: '记一条',
    placeholder: '想到什么就记下来…（Ctrl+Enter 保存，Esc 关掉）',
    save: '记下来',
    saving: '保存中…',
    cancel: '关掉',
    failed: '没存上：',
    empty: '还没写东西。',
    duplicate: (title: string) => `你之前记过很像的：「${title}」。两条都留着。`,
    due: (day: string) => `认出日期：${day}`,
    organized: '已交给模型整理，稍等一下会出现在便签里。',
  },
  en: {
    title: 'Jot it down',
    placeholder: 'Whatever it is… (Ctrl+Enter saves, Esc closes)',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Close',
    failed: 'Not saved: ',
    empty: 'Nothing written yet.',
    duplicate: (title: string) => `You wrote something close before: "${title}". Both are kept.`,
    due: (day: string) => `Date noticed: ${day}`,
    organized: 'Handed to the model; it will show up in the notes shortly.',
  },
} as const

export type CaptureLang = keyof typeof WORDS

interface CaptureResult {
  ok: boolean
  message?: string
  note?: { id: string; title: string }
  duplicate?: { id: string; title: string; score: number } | null
  due?: { day: string; label: string } | null
}

async function post(path: string, body: Record<string, unknown>): Promise<CaptureResult> {
  try {
    const res = await fetch(new URL(`/api/dsh-mishu${path}`, document.baseURI), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value = await res.json().catch(() => null) as CaptureResult | null
    return value ?? { ok: false, message: `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The capture box. Rendered into `document.body` so no panel's overflow can
 * clip it, and so it works whether or not the board page is open.
 */
export function NoteCapture({ lang, organize, onSaved, onClose }: {
  lang: CaptureLang
  /** Whether the "let AI organise" setting is on; the checkbox only shows when it is. */
  organize: boolean
  onSaved?: () => void
  onClose: () => void
}) {
  const t = WORDS[lang]
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const area = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    area.current?.focus()
  }, [])

  // Escape closes, but never while a save is in flight: the text would go with it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])

  const save = useCallback(async () => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    setError(undefined)
    const result = await post('/note-capture', { lang, text, organize })
    setBusy(false)
    if (!result.ok) {
      // The text stays in the box; nothing is thrown away on a failure.
      setError(result.message ?? '')
      return
    }
    const title = result.note?.title ?? ''
    const extra = [
      result.duplicate == null ? undefined : t.duplicate(result.duplicate.title),
      result.due == null ? undefined : t.due(result.due.day),
    ].filter((line): line is string => line !== undefined)
    if (extra.length === 0) {
      setNote(title)
      onSaved?.()
      onClose()
      return
    }
    // Something worth reading: stay open, say it, and let the next Esc close.
    setNote([...extra].join(' · '))
    setText('')
    onSaved?.()
  }, [busy, lang, onClose, onSaved, organize, t, text])

  return createPortal(
    <div
      className="mishu-capture-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <div className="mishu-capture" role="dialog" aria-modal="true" aria-label={t.title}>
        <div className="mishu-capture-head">
          <h2>{t.title}</h2>
          <button type="button" className="mishu-btn mishu-btn-quiet" aria-label={t.cancel} onClick={onClose} disabled={busy}>×</button>
        </div>
        <textarea
          ref={area}
          className="mishu-capture-box"
          value={text}
          placeholder={t.placeholder}
          rows={5}
          onChange={(event) => { setText(event.target.value); setNote(undefined) }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              void save()
            }
          }}
        />
        {error === undefined ? null : <div className="mishu-error">{t.failed}{error}</div>}
        {note === undefined ? null : <div className="mishu-hint">{note}</div>}
        <div className="mishu-actions">
          <button type="button" className="mishu-btn primary" onClick={() => { void save() }} disabled={busy || text.trim() === ''}>
            {busy ? t.saving : t.save}
          </button>
          <button type="button" className="mishu-btn" onClick={onClose} disabled={busy}>{t.cancel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Install the window-level shortcut.
 *
 * `capture: true` because the composer swallows Space while it has focus, and
 * Alt+Space inside a chat is exactly when you want to jot something down.
 */
export function installCaptureShortcut(open: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || (event.code !== CAPTURE_SHORTCUT.code && event.key !== ' ')) return
    event.preventDefault()
    event.stopPropagation()
    open()
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}

/** The capture styles, kept next to the component that needs them. */
export const CAPTURE_STYLES = `
.mishu-capture-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.42);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px}
.mishu-capture{width:min(560px,100%);background:var(--dsw-alias-bg-layer-0,Canvas);border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:12px;padding:14px 16px 12px;box-shadow:0 18px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary,CanvasText);font-size:13px}
.mishu-capture-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mishu-capture-head h2{margin:0;font-size:14px;font-weight:600}
.mishu-capture-box{width:100%;box-sizing:border-box;resize:vertical;font:inherit;font-size:13px;line-height:1.5;color:inherit;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;padding:8px 10px}
.mishu-capture .mishu-actions{display:flex;gap:8px;justify-content:flex-end}
`

/** Both style sheets in one tag, so the overlay looks right even on the board's first render. */
export const ALL_STYLES = `${STYLES}${CAPTURE_STYLES}`
