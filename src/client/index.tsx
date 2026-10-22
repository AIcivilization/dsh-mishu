/**
 * Browser half: a "小秘书 / Secretary" entry in the left sidebar that opens
 * the board as a full page in the main area. The sidebar entry and the page
 * share one id, the same way DSH's own task manager is wired.
 */

import { MishuBoard } from './Board.tsx'
import { STYLES } from './styles.ts'

export const PACKAGE_NAME = 'dsh-mishu'
export const inject = ['slots', 'locale']

/** Shared by the sidebar entry and the main page it opens. */
export const PANEL_ID = 'dsh-mishu'
const NS = 'dsh-mishu'

interface ClientContext {
  effect(fn: () => () => void, label?: string): void
  inject(deps: string[], callback: (ctx: ClientContext & { uiWorkspace: WorkspaceLike }) => void): void
  locale: {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string) => string
    getSnapshot(): { active: string }
  }
  slots: {
    inject(name: string, fn: () => () => void): void
    register(definition: Record<string, unknown>, component: unknown): () => void
  }
}

interface WorkspaceLike {
  startSession(workspaceId?: string, options?: { prompt?: string; clearPreviousDraft?: boolean }): void
}

/**
 * Opens a new chat with `prompt` in its input box, unsent. Set while DSH's
 * workspace service is available; without it "+AI" falls back to the clipboard.
 */
let openChat: ((prompt: string) => void) | undefined

/** Clipboard-with-check outline; drawn inline so it works in every DSH release. */
function MishuIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4h6v3H9z" />
      <path d="M9 12l2 2 4-4" />
      <path d="M9 17h6" />
    </svg>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh: { panel: '小秘书' }, en: { panel: 'Secretary' } }), 'dsh-mishu: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshPlugin = PACKAGE_NAME
    style.textContent = STYLES
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-mishu: styles')

  const t = ctx.locale.bind(NS)
  const locale = () => ctx.locale.getSnapshot().active
  ctx.inject(['uiWorkspace'], (workspaceCtx) => {
    workspaceCtx.effect(() => {
      openChat = prompt => workspaceCtx.uiWorkspace.startSession(undefined, { prompt, clearPreviousDraft: true })
      return () => { openChat = undefined }
    }, 'dsh-mishu: +AI opens a chat')
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ locale, openChat: (prompt: string) => (openChat === undefined ? false : (openChat(prompt), true)) }),
  }, MishuBoard))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t('panel'),
  }, MishuIcon))
}
