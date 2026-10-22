/**
 * The secretary's running state, shared by the command, the tools and the
 * page's API: the notebook, the effective settings (config defaults with
 * what you set on the settings page on top), the keychain, and one sync of
 * every source at a time.
 */

import {
  dayOf, detectLang, effectiveSettings, GitHubClient, ImapFetcher, mailAccounts, mailReportKey, renderBrief,
  resolveGithubToken, secretAccount, secretFromEnv, syncGithub, syncMail, systemSecrets, tickManual, bi,
  type Defaults, type GithubSyncReport, type Lang, type MailAccount, type MailFetcher, type MailSyncReport, type MishuStore,
  restartPlan, scheduleRestart, type RestartPlan, type SecretStore, type TokenResult,
} from '../core/index.ts'
import type { MishuConfig } from './config.ts'

interface Logger { info(message: string): void; warn(message: string): void }

export class Runtime {
  store: MishuStore | undefined
  readonly config: MishuConfig
  readonly secrets: SecretStore
  readonly fetcher: MailFetcher
  private readonly logger: Logger
  private syncing: Promise<void> | undefined
  /** How DSH restarts; tests swap it so they never restart anything. */
  restarter: { plan(): RestartPlan; schedule(plan: Exclude<RestartPlan, { kind: 'none' }>): { log: string } } = { plan: () => restartPlan(), schedule: scheduleRestart }

  constructor(config: MishuConfig, logger: Logger, secrets: SecretStore = systemSecrets(), fetcher: MailFetcher = new ImapFetcher()) {
    this.config = config
    this.logger = logger
    this.secrets = secrets
    this.fetcher = fetcher
  }

  defaults(): Defaults {
    return { language: this.config.language, githubEnabled: this.config.github.enabled, markRead: this.config.github.markRead, leadDays: this.config.leadDays }
  }

  settings(): Defaults {
    return this.store === undefined ? this.defaults() : effectiveSettings(this.store, this.defaults())
  }

  /** The language fixed by settings, or `undefined` for auto. */
  fixedLang(): Lang | undefined {
    const language = this.settings().language
    return language === 'auto' ? undefined : language
  }

  lang(): Lang {
    return this.fixedLang() ?? detectLang()
  }

  accounts(): MailAccount[] {
    return this.store === undefined ? [] : mailAccounts(this.store)
  }

  brief(lang: Lang = this.lang()): string {
    const store = this.store
    if (store === undefined) return lang === 'zh' ? '小秘书的记事本没有打开' : 'The secretary\'s notebook is not open'
    const now = Date.now()
    tickManual(store, dayOf(now), now)
    const settings = this.settings()
    return renderBrief(store, {
      now, lang, upcomingDays: this.config.upcomingDays,
      github: { enabled: settings.githubEnabled, markRead: settings.markRead },
      mailAccounts: this.accounts(),
    })
  }

  /** The password for an account: keychain first, then the documented environment variable. */
  async mailPassword(id: number): Promise<string | undefined> {
    try {
      const stored = await this.secrets.get(secretAccount(id))
      if (stored !== undefined) return stored
    } catch {
      // keychain unavailable: fall through to the environment
    }
    return secretFromEnv(secretAccount(id))
  }

  /** The GitHub token: environment, then the keychain, then the GitHub CLI. */
  githubToken(): Promise<TokenResult> {
    return resolveGithubToken({ envName: this.config.github.tokenEnv, useGhCli: this.config.github.useGhCli, secrets: this.secrets })
  }

  private async syncGithubNow(store: MishuStore): Promise<void> {
    const settings = this.settings()
    if (!settings.githubEnabled) return
    const token = await this.githubToken()
    if ('error' in token) {
      const report: GithubSyncReport = { at: Date.now(), notifications: 0, opened: 0, closed: 0, wouldMarkRead: 0, markedRead: 0, checkFailures: 0, apiCalls: 0, error: token.error }
      store.set('github.lastSync', report)
      this.logger.warn(`dsh-mishu: ${token.error.en}`)
      return
    }
    const report = await syncGithub({
      store, gh: new GitHubClient({ token: token.token }), now: Date.now(),
      markRead: settings.markRead, markReadReasons: this.config.github.markReadReasons,
    })
    this.logger.info(`dsh-mishu: github sync ${report.error?.en ?? `ok (${report.notifications} notifications, +${report.opened} open, ${report.closed} closed, ${report.apiCalls} calls)`}`)
  }

  /** One account; the result is also kept as its last report. */
  async syncMailAccount(account: MailAccount): Promise<MailSyncReport | undefined> {
    const store = this.store
    if (store === undefined) return undefined
    const password = await this.mailPassword(account.id)
    if (password === undefined) {
      const report: MailSyncReport = {
        at: Date.now(), account: account.id, messages: 0, opened: 0, closed: 0,
        error: bi('没有找到这个邮箱的密码（授权码）。到设置页重新填一次。', 'No password (app password) found for this account. Enter it again on the settings page.'),
      }
      store.set(mailReportKey(account.id), report)
      return report
    }
    const report = await syncMail({ store, account, fetcher: this.fetcher, password, now: Date.now() })
    // Counts only: subjects and addresses never go to the log.
    this.logger.info(`dsh-mishu: mail #${account.id} ${report.error === undefined ? `ok (${report.messages} unread, +${report.opened} open, ${report.closed} closed)` : 'failed'}`)
    return report
  }

  /** Every source once; concurrent callers share the sync in flight. */
  syncAll(): Promise<void> {
    const store = this.store
    if (store === undefined) return Promise.resolve()
    this.syncing ??= (async () => {
      await this.syncGithubNow(store).catch(error => this.logger.warn(`dsh-mishu: github sync failed (${(error as Error).message})`))
      for (const account of this.accounts().filter(a => a.enabled)) {
        await this.syncMailAccount(account).catch(error => this.logger.warn(`dsh-mishu: mail #${account.id} sync failed (${(error as Error).message})`))
      }
    })().finally(() => { this.syncing = undefined })
    return this.syncing
  }

  /** Resolves when the sync in flight (if any) is done. */
  idle(): Promise<void> {
    return this.syncing ?? Promise.resolve()
  }
}
