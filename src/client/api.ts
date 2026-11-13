// Calls to the plugin's endpoints on DSH's own authenticated `/api` channel.

import type { BoardData, MatterDetail } from '../core/board.ts'
import type {
  DraftView, MailBody, MailFolder, MailListPage, MailMarkResult, MailSearchResult, MailSummary,
} from '../core/index.ts'

export type { BoardCard, BoardData, CardAction, DoneGroup, MatterDetail } from '../core/board.ts'
export type { DraftView, MailBody, MailFolder, MailListPage, MailMarkResult, MailSearchResult, MailSummary } from '../core/index.ts'

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
  | { kind: 'watch-error'; watchId: number }
  | { kind: 'watch-setup' }

export interface AccountView {
  id: number
  label: string
  address: string
  preset: string
  host: string
  port: number
  secure: boolean
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
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
  smtp: { host: string; port: number; secure: boolean }
  supported: boolean
  howTo: string
  domains: string[]
  steps: Array<{ text: string; link?: { url: string; label: string } }>
  passwordLength: number | null
}

export interface WatchView {
  id: number
  label: string
  url: string
  keywords: string
  enabled: boolean
  intervalMinutes: number
  /** "checked 3 hours ago, 12 entries" or the error. */
  status: string
  /** "tell me when it mentions …" */
  summary: string
  report: { at: number; items: number; opened: number; closed: number; error?: { zh: string; en: string } } | null
}

export interface WatchDraft {
  id?: number
  label: string
  url: string
  keywords: string
  enabled: boolean
  intervalMinutes: number
}

export interface WatchTest {
  items: number
  title: string
  excerpt: string
  keywordHit?: boolean
  keyword?: string
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
  watches: WatchView[]
  notify: {
    settings: NotifySettingsView
    channels: Array<{ id: 'desktop' | 'feishu'; enabled: boolean; available: boolean; why?: string }>
    feishu: { configured: boolean }
    last: { at: number; kind: 'brief' | 'urgent' | 'test'; count: number; results: Array<{ channel: string; ok: boolean; error?: string }> } | null
  }
  presets: PresetView[]
  /** DSH's own scheduled tasks; null when this Host has no Schedule service. */
  schedule: ScheduleView | null
}

export interface ScheduleTaskView {
  id: string
  title: string
  when: string
  next: string | null
  status: 'active' | 'paused' | 'ended'
  prompt: string
  mine: boolean
  running: boolean
  lastDelivery: string | null
}

export interface ScheduleView {
  available: boolean
  tasks: ScheduleTaskView[]
  brief: { id: string | null; time: string; timeZone: string; armed: boolean; error: string | null }
}

export type AccountDraft = Partial<Omit<AccountView, 'hasPassword' | 'envName' | 'report' | 'mismatch'>>

export const restartApi = {
  info: (lang: string) => post<{ supported: true } | { supported: false; why: string }>('/restart/info', { lang }),
  restart: (lang: string) => post<{ restarting: true; reconnect?: boolean }>('/restart', { lang }),
}

export interface NotifySettingsView {
  brief: { enabled: boolean; time: string }
  urgent: boolean
  quiet: { enabled: boolean; from: string; to: string }
  timeZone: string
  channels: { desktop: boolean; feishu: boolean }
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
  saveNotify: (lang: string, notify: Partial<NotifySettingsView>) => post<{ view: SettingsView }>('/notify/save', { lang, notify }),
  testNotify: (lang: string, channel: string) => post<{ sent: true }>('/notify/test', { lang, channel }),
  saveFeishu: (lang: string, webhook: string, secret: string) => post<{ view: SettingsView }>('/feishu/save', { lang, webhook, secret }),
  deleteFeishu: (lang: string) => post<{ view: SettingsView }>('/feishu/delete', { lang }),
  deviceStart: (lang: string) => post<{ login: DeviceView }>('/github/device/start', { lang }),
  deviceStatus: (lang: string) => post<{ login: DeviceView; view?: SettingsView }>('/github/device/status', { lang }),
  deviceCancel: (lang: string) => post<{ login: DeviceView }>('/github/device/cancel', { lang }),
  saveMail: (lang: string, account: AccountDraft, password: string) => post<{ id: number; view: SettingsView }>('/mail/save', { lang, account, password }),
  testMail: (lang: string, account: AccountDraft, password: string) =>
    post<{ unread: number; smtp: 'ok' | 'failed' | 'none'; smtpError?: string }>('/mail/test', { lang, account, password }),
  deleteMail: (lang: string, id: number) => post<{ view: SettingsView }>('/mail/delete', { lang, id }),
  syncMail: (lang: string, id: number) => post<{ view: SettingsView }>('/mail/sync', { lang, id }),
  saveWatch: (lang: string, watch: WatchDraft) => post<{ id: number; view: SettingsView }>('/watch/save', { lang, watch }),
  testWatch: (lang: string, watch: WatchDraft) => post<WatchTest>('/watch/test', { lang, watch }),
  deleteWatch: (lang: string, id: number) => post<{ view: SettingsView }>('/watch/delete', { lang, id }),
  syncWatch: (lang: string, id: number) => post<{ board: BoardData; view: SettingsView }>('/watch/sync', { lang, id }),
  armBrief: (lang: string) => post<{ view: SettingsView; schedule: ScheduleView }>('/schedule/brief/arm', { lang }),
  disarmBrief: (lang: string) => post<{ view: SettingsView; schedule: ScheduleView }>('/schedule/brief/disarm', { lang }),
  runTask: (lang: string, id: string) => post<{ schedule: ScheduleView }>('/schedule/run', { lang, id }),
  deleteTask: (lang: string, id: string) => post<{ schedule: ScheduleView }>('/schedule/delete', { lang, id }),
}

/** Mail: listing, reading, writing, drafts. All of it goes through the same
 *  authenticated channel; nothing here touches the network directly. */
export interface MailDraft {
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  attachments: string[]
  /** Set when this draft answers or forwards a message, so sending keeps the thread. */
  reply?: { folder: string; uid: number; mode: 'reply' | 'reply-all' | 'forward' } | undefined
}

/** Delete means "into Trash"; purge means gone for good and only counts inside Trash. */
export type MarkAction = 'read' | 'unread' | 'star' | 'unstar' | 'move' | 'delete' | 'purge'

export const mailApi = {
  list: (lang: string, account: number | undefined, options: { folder?: string; limit?: number; offset?: number; unreadOnly?: boolean }) =>
    post<{ page: MailListPage }>('/mail/list', { lang, account, ...options }),
  read: (lang: string, account: number | undefined, folder: string, uid: number, maxChars?: number) =>
    post<{ message: MailBody }>('/mail/read', { lang, account, folder, uid, ...maxChars === undefined ? {} : { maxChars } }),
  search: (lang: string, account: number | undefined, query: string, options: { folder?: string; fields?: string[]; limit?: number; bodyLimit?: number }) =>
    post<{ found: MailSearchResult }>('/mail/search', { lang, account, query, ...options }),
  mark: (lang: string, account: number | undefined, folder: string, uid: number, action: MarkAction, destination?: string) =>
    post<{ result: MailMarkResult }>('/mail/mark', { lang, account, folder, uid, action, ...destination === undefined ? {} : { destination } }),
  markMany: (lang: string, account: number | undefined, folder: string, uids: number[], action: MarkAction, destination?: string) =>
    post<{ results: MailMarkResult[] }>('/mail/mark/many', { lang, account, folder, uids, action, ...destination === undefined ? {} : { destination } }),
  folders: (lang: string, account: number | undefined) => post<{ folders: MailFolder[] }>('/mail/folders', { lang, account }),
  createFolder: (lang: string, account: number | undefined, path: string) =>
    post<{ folders: MailFolder[] }>('/mail/folder/create', { lang, account, path }),
  renameFolder: (lang: string, account: number | undefined, from: string, to: string) =>
    post<{ folders: MailFolder[] }>('/mail/folder/rename', { lang, account, from, to }),
  deleteFolder: (lang: string, account: number | undefined, path: string) =>
    post<{ folders: MailFolder[] }>('/mail/folder/delete', { lang, account, path }),
  attachment: (lang: string, account: number | undefined, folder: string, uid: number, index: number) =>
    post<{ file: { filename: string; contentType: string; size: number; path: string } }>('/mail/attachment', { lang, account, folder, uid, index }),
  send: (lang: string, account: number | undefined, draft: MailDraft) =>
    post<{ sent: { messageId: string; accepted: string[]; rejected: string[]; response: string } }>('/mail/send', { lang, account, ...draft }),
  reply: (lang: string, account: number | undefined, folder: string, uid: number, mode: 'reply' | 'reply-all' | 'forward', text: string, options: { to?: string; cc?: string; bcc?: string; attachments?: string[] } = {}) =>
    post<{ sent: { messageId: string; accepted: string[]; rejected: string[]; response: string } }>('/mail/reply', { lang, account, folder, uid, mode, text, ...options }),
  drafts: (lang: string, account: number | undefined) => post<{ drafts: DraftView[] }>('/mail/draft/list', { lang, account }),
  saveDraft: (lang: string, account: number | undefined, draft: MailDraft) => post<{ draft: DraftView }>('/mail/draft/save', { lang, account, ...draft }),
  editDraft: (lang: string, account: number | undefined, draftId: string, revision: number, draft: MailDraft) =>
    post<{ draft: DraftView }>('/mail/draft/edit', { lang, account, id: draftId, revision, ...draft }),
  deleteDraft: (lang: string, draftId: string) => post<{ deleted: string }>('/mail/draft/delete', { lang, id: draftId }),
  sendDraft: (lang: string, account: number | undefined, draftId: string, revision: number) =>
    post<{ sent: { messageId: string } }>('/mail/draft/send', { lang, account, id: draftId, revision }),
  scheduleDraft: (lang: string, account: number | undefined, draftId: string, revision: number, sendAt: string) =>
    post<{ draft: DraftView }>('/mail/draft/schedule', { lang, account, id: draftId, revision, sendAt }),
  cancelSchedule: (lang: string, draftId: string, revision: number) =>
    post<{ draft: DraftView }>('/mail/draft/cancel', { lang, id: draftId, revision }),
}
