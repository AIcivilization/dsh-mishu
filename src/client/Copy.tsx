/**
 * The little "copy" button on an unfolded card.
 *
 * It copies what the card shows as plain text (see cardText.ts) and says so
 * for a moment, then goes quiet again. The text is built when you click, not
 * when the card opens, so it always matches what is on screen.
 */

import { useEffect, useRef, useState } from 'react'
import { copyText } from './clipboard.ts'
import { TEXT, type UiLang } from './text.ts'

export function CopyButton({ text, lang }: { text: () => string; lang: UiLang }) {
  const t = TEXT[lang]
  const [note, setNote] = useState<'ok' | 'failed' | undefined>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])

  const run = async () => {
    const ok = await copyText(text())
    setNote(ok ? 'ok' : 'failed')
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNote(undefined), 2000)
  }

  return (
    <span className="mishu-copy-wrap">
      <button
        type="button"
        className={`mishu-btn mishu-btn-quiet mishu-copy ${note === 'ok' ? 'done' : ''}`}
        title={t.copyTitle}
        aria-label={t.copyTitle}
        onClick={(event) => { event.stopPropagation(); void run() }}
      >
        {note === 'ok' ? t.copied : note === 'failed' ? t.copyFailed : t.copy}
      </button>
    </span>
  )
}
