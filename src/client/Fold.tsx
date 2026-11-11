/**
 * Folded cards for the settings page: a title that opens and closes, with the
 * card's content underneath. Settings are a stack of these, and only one is
 * open at a time — opening another folds the last, the same way the board's
 * cards behave. Cards can nest (a mail account inside "where it looks", a
 * channel inside "when to tell you"), and each level folds on its own, so
 * opening an account never closes the panel it lives in.
 */

import { createContext, useContext, useState, type ReactNode } from 'react'

const FoldCtx = createContext<{ open: string | undefined; toggle: (key: string) => void }>({ open: undefined, toggle: () => {} })

export function FoldGroup({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | undefined>()
  return <FoldCtx.Provider value={{ open, toggle: key => setOpen(current => (current === key ? undefined : key)) }}>{children}</FoldCtx.Provider>
}

export function Fold({ id, title, aside, className = '', children }: { id: string; title: ReactNode; aside?: ReactNode; className?: string; children: ReactNode }) {
  const parent = useContext(FoldCtx)
  const [inner, setInner] = useState<string | undefined>()
  const open = parent.open === id
  return (
    <div className={`mishu-card mishu-fold${open ? ' open' : ''}${className === '' ? '' : ` ${className}`}`}>
      <div
        className="mishu-card-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => parent.toggle(id)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          parent.toggle(id)
        }}
      >
        <span className="mishu-caret" aria-hidden="true" />
        <span className="mishu-card-title">{title}</span>
        {/* A switch on the title row works without opening the card, so it must not fold it. */}
        {aside === undefined ? null : <span className="mishu-card-aside" onClick={event => event.stopPropagation()}>{aside}</span>}
      </div>
      {open ? (
        <div className="mishu-card-body">
          <FoldCtx.Provider value={{ open: inner, toggle: key => setInner(current => (current === key ? undefined : key)) }}>{children}</FoldCtx.Provider>
        </div>
      ) : null}
    </div>
  )
}
