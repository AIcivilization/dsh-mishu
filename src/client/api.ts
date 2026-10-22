// Calls to the plugin's endpoints on DSH's own authenticated `/api` channel.

import type { BoardData, MatterDetail } from '../core/board.ts'

export type { BoardCard, BoardData, CardAction, DoneGroup, MatterDetail } from '../core/board.ts'

export interface NewItem {
  title: string
  due: string
  repeat: string
  category: string
  note: string
}

type Result<T> = ({ ok: true } & T) | { ok: false; message: string }

async function post<T>(path: string, body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const res = await fetch(new URL(`/api/dsh-mishu${path}`, document.baseURI), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value = await res.json().catch(() => null) as Result<T> | null
    if (value === null) return { ok: false, message: `HTTP ${res.status}` }
    return value
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export const mishuApi = {
  board: (lang: string) => post<{ board: BoardData }>('/board', { lang }),
  sync: (lang: string) => post<{ board: BoardData }>('/sync', { lang }),
  action: (lang: string, target: 'matter' | 'series', id: number, action: string, days?: number) =>
    post<{ board: BoardData }>('/action', { lang, target, id, action, ...days === undefined ? {} : { days } }),
  detail: (lang: string, id: number) => post<{ detail: MatterDetail }>('/detail', { lang, id }),
  preview: (lang: string, item: NewItem) => post<{ text: string }>('/preview', { lang, item }),
  add: (lang: string, item: NewItem) => post<{ id: number; board: BoardData }>('/add', { lang, item }),
  ask: (lang: string, ask: AskTopic) => post<{ prompt: string }>('/ask', { lang, ask }),
}

/** What a "+AI" button asks about. */
export type AskTopic =
  | { kind: 'matter'; id: number }
  | { kind: 'series'; id: number }
  | { kind: 'summary' }
  | { kind: 'github-error' }
  | { kind: 'mail-error'; accountId: number }
  | { kind: 'mail-setup'; preset: string; error?: string }

export interface AccountView {
  id: number
  label: string
  address: string
  preset: string
  host: string
  port: number
  secure: boolean
  user: string
  enabled: boolean
  sinceDays: number
  hasPassword: boolean
  envName: string
  /** The address belongs to another provider than the server. */
  mismatch: string | null
  report: { at: number; messages: number; opened: number; closed: number; error?: { zh: string; en: string } } | null
}

export interface PresetView {
  id: string
  label: string
  host: string
  port: number
  secure: boolean
  supported: boolean
  howTo: string
  domains: string[]
  setupUrl: string | null
  passwordLength: number | null
}

export interface SettingsView {
  lang: 'zh' | 'en'
  settings: {
    language: 'auto' | 'zh' | 'en'
    githubEnabled: boolean
    markRead: 'off' | 'shadow' | 'on'
    leadDays: Record<string, number>
  }
  github: {
    tokenEnv: string
    token: { found: true; from: 'env' | 'keychain' | 'gh' } | { found: false; text: string }
    newTokenUrl: string
    deviceLogin: boolean
    lastSync: { at: number; notifications: number; error?: { zh: string; en: string } } | null
  }
  secrets: { kind: string; available: boolean; why?: string; file?: { path: string; why: string } }
  accounts: AccountView[]
  presets: PresetView[]
}

export type AccountDraft = Partial<Omit<AccountView, 'hasPassword' | 'envName' | 'report' | 'mismatch'>>

export const restartApi = {
  info: (lang: string) => post<{ supported: true } | { supported: false; why: string }>('/restart/info', { lang }),
  restart: (lang: string) => post<{ restarting: true }>('/restart', { lang }),
}

export type DeviceView =
  | { state: 'idle' }
  | { state: 'waiting'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'done'; login: string }
  | { state: 'failed'; message: string }

export const settingsApi = {
  load: (lang: string) => post<{ view: SettingsView }>('/settings', { lang }),
  save: (lang: string, settings: Partial<SettingsView['settings']>) => post<{ view: SettingsView }>('/settings/save', { lang, settings }),
  testGithub: (lang: string) => post<{ login: string; from: string }>('/github/test', { lang }),
  saveToken: (lang: string, token: string) => post<{ login: string; view: SettingsView }>('/github/token/save', { lang, token }),
  deleteToken: (lang: string) => post<{ view: SettingsView }>('/github/token/delete', { lang }),
  deviceStart: (lang: string) => post<{ login: DeviceView }>('/github/device/start', { lang }),
  deviceStatus: (lang: string) => post<{ login: DeviceView; view?: SettingsView }>('/github/device/status', { lang }),
  deviceCancel: (lang: string) => post<{ login: DeviceView }>('/github/device/cancel', { lang }),
  saveMail: (lang: string, account: AccountDraft, password: string) => post<{ id: number; view: SettingsView }>('/mail/save', { lang, account, password }),
  testMail: (lang: string, account: AccountDraft, password: string) => post<{ unread: number }>('/mail/test', { lang, account, password }),
  deleteMail: (lang: string, id: number) => post<{ view: SettingsView }>('/mail/delete', { lang, id }),
  syncMail: (lang: string, id: number) => post<{ view: SettingsView }>('/mail/sync', { lang, id }),
}
