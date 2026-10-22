/**
 * Settings you change on the settings page, and your mail accounts.
 *
 * The profile's config gives the defaults; what you set on the page is kept
 * in the notebook and wins. Mail accounts keep only where and who — the
 * password goes to the system keychain (see secrets.ts), never here.
 */

import type { MarkReadMode } from './github/sync.ts'
import { MishuError, bi, type Lang } from './i18n.ts'
import { normalizePassword, resolveAccount, secretAccount, type MailAccount } from './mail/account.ts'
import { MAIL_SOURCE } from './mail/sync.ts'
import { CATEGORIES, type Category } from './recur.ts'
import { secretFromEnv, type SecretStore } from './secrets.ts'
import type { MishuStore } from './store.ts'

export interface Defaults {
  language: 'auto' | Lang
  githubEnabled: boolean
  markRead: MarkReadMode
  leadDays: Record<Category, number>
}

export interface UserSettings {
  language?: Defaults['language']
  githubEnabled?: boolean
  markRead?: MarkReadMode
  leadDays?: Partial<Record<Category, number>>
}

const SETTINGS_KEY = 'settings'
const ACCOUNTS_KEY = 'mail.accounts'
const NEXT_ID_KEY = 'mail.nextId'

export function effectiveSettings(store: MishuStore, defaults: Defaults): Defaults {
  const saved = store.get<UserSettings>(SETTINGS_KEY) ?? {}
  return {
    language: saved.language ?? defaults.language,
    githubEnabled: saved.githubEnabled ?? defaults.githubEnabled,
    markRead: saved.markRead ?? defaults.markRead,
    leadDays: { ...defaults.leadDays, ...saved.leadDays },
  }
}

/** Check what the page sent and keep it; throws a sentence a person can act on. */
export function saveSettings(store: MishuStore, input: UserSettings, now: number): void {
  const next: UserSettings = { ...store.get<UserSettings>(SETTINGS_KEY) ?? {} }
  if (input.language !== undefined) {
    if (!['auto', 'zh', 'en'].includes(input.language)) throw new MishuError(bi('语言只能是 auto、zh 或 en', 'language must be auto, zh or en'))
    next.language = input.language
  }
  if (input.githubEnabled !== undefined) next.githubEnabled = input.githubEnabled === true
  if (input.markRead !== undefined) {
    if (!['off', 'shadow', 'on'].includes(input.markRead)) throw new MishuError(bi('自动标已读只能是 off、shadow 或 on', 'mark read must be off, shadow or on'))
    next.markRead = input.markRead
  }
  if (input.leadDays !== undefined) {
    const lead: Partial<Record<Category, number>> = {}
    for (const [category, days] of Object.entries(input.leadDays)) {
      if (!CATEGORIES.includes(category as Category)) continue
      if (!Number.isInteger(days) || days < 0 || days > 366) throw new MishuError(bi('提前天数要是 0 到 366 的整数', 'lead days must be a whole number from 0 to 366'))
      lead[category as Category] = days
    }
    next.leadDays = lead
  }
  store.set(SETTINGS_KEY, next)
  store.log(now, 'settings', next)
}

export function mailAccounts(store: MishuStore): MailAccount[] {
  return store.get<MailAccount[]>(ACCOUNTS_KEY) ?? []
}

/**
 * Add (no id) or update an account. A new password, when given, goes to the
 * keychain before the account is saved, so a failed keychain write leaves
 * nothing half-saved. Without a usable keychain the password is not kept
 * anywhere: the account is saved and reads it from the environment variable
 * shown on the settings page (`secretEnvName`).
 */
export async function saveMailAccount(store: MishuStore, secrets: SecretStore, input: Partial<MailAccount>, password: string | undefined, now: number): Promise<MailAccount> {
  const accounts = mailAccounts(store)
  const existing = input.id === undefined ? undefined : accounts.find(a => a.id === input.id)
  if (input.id !== undefined && existing === undefined) throw new MishuError(bi(`没有 #${input.id} 这个邮箱账户`, `there is no mail account #${input.id}`))
  const id = existing?.id ?? (store.get<number>(NEXT_ID_KEY) ?? 1)
  const account = resolveAccount({ ...existing, ...input }, id)
  const keychain = (await secrets.status()).available
  if (keychain && password !== undefined && password !== '') await secrets.set(secretAccount(id), normalizePassword(account.preset, password))
  else if (keychain && existing === undefined && await secrets.get(secretAccount(id)) === undefined && secretFromEnv(secretAccount(id)) === undefined) {
    throw new MishuError(bi('新邮箱要填密码（授权码）', 'a new account needs its password (app password)'))
  }
  store.set(ACCOUNTS_KEY, existing === undefined ? [...accounts, account] : accounts.map(a => (a.id === id ? account : a)))
  if (existing === undefined) store.set(NEXT_ID_KEY, id + 1)
  store.log(now, existing === undefined ? 'mail-account-add' : 'mail-account-update', { id, host: account.host, address: account.address })
  return account
}

/** Remove an account, its keychain entry, and close what is still open from it. */
export async function deleteMailAccount(store: MishuStore, secrets: SecretStore, id: number, now: number): Promise<boolean> {
  const accounts = mailAccounts(store)
  if (!accounts.some(a => a.id === id)) return false
  await secrets.delete(secretAccount(id))
  store.transaction(() => {
    store.set(ACCOUNTS_KEY, accounts.filter(a => a.id !== id))
    for (const matter of store.mattersOfSource(MAIL_SOURCE)) {
      if (matter.status === 'open' && matter.key.startsWith(`mail:${id}:`)) {
        store.updateMatter(matter.id, { status: 'done', reason: 'account-removed', closedBy: 'source', closedAt: now }, now)
      }
    }
    store.log(now, 'mail-account-delete', { id })
  })
  return true
}
