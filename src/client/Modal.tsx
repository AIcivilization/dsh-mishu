/**
 * A dialog over the page: Esc or a click outside closes it. Used for
 * "Sign in with GitHub" and adding a mail account. Rendered into
 * document.body, so no container of DSH's layout can clip it.
 */

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="mishu-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="mishu-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mishu-modal-head">
          <h2>{title}</h2>
          <button type="button" className="mishu-btn mishu-btn-quiet" aria-label="×" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
