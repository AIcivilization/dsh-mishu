/**
 * The colourful "+AI" button, the same everywhere on the page.
 *
 * It asks the host for the text that explains `topic`, then opens a new DSH
 * chat with that text in the input box — unsent, so you read what would go to
 * the model and press send yourself. Without DSH's workspace service it
 * copies the text instead and says so.
 */

import { useState } from 'react'
import { mishuApi, type AskTopic } from './api.ts'
import { TEXT, type UiLang } from './text.ts'

export type OpenChat = (prompt: string) => boolean

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function AskAI({ topic, lang, locale, openChat, compact = false }: {
  topic: AskTopic
  lang: UiLang
  locale: () => string
  openChat: OpenChat
  compact?: boolean
}) {
  const t = TEXT[lang]
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>()
  const [busy, setBusy] = useState(false)

  const ask = async () => {
    setBusy(true)
    const result = await mishuApi.ask(locale(), topic)
    setBusy(false)
    if (!result.ok) {
      setNote({ ok: false, text: `${t.aiFailed}${result.message}` })
      return
    }
    if (openChat(result.prompt)) {
      setNote({ ok: true, text: t.aiOpened })
    } else {
      setNote(await copy(result.prompt) ? { ok: true, text: t.aiCopied } : { ok: false, text: `${t.aiFailed}clipboard` })
    }
    setTimeout(() => setNote(undefined), 6000)
  }

  return (
    <span className="mishu-ai-wrap">
      <button
        type="button"
        className={`mishu-ai ${compact ? 'compact' : ''}`}
        title={t.aiTitle}
        aria-label={t.aiTitle}
        disabled={busy}
        onClick={(event) => { event.stopPropagation(); void ask() }}
      >
        {t.ai}
      </button>
      {note === undefined ? null : <span className={`mishu-ai-note ${note.ok ? '' : 'mishu-danger'}`} role="status">{note.text}</span>}
    </span>
  )
}
