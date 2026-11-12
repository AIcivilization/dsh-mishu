/**
 * The secretary's running state, shared by the command, the tools and the
 * page's API: the notebook, the effective settings (config defaults with
 * what you set on the settings page on top), the keychain, and one sync of
 * every source at a time.
 */

import {
  dayOf, detectLang, effectiveSettings, GitHubClient, ImapFetcher, mailAccounts, mailReportKey, renderBrief,
  buildBoard, DesktopChannel, FeishuChannel, FileSecrets, GithubDeviceLogin, KeychainOrFile, notifySettings, notifyTick, mishuPaths, resolveGithubToken, secretAccount, secretFromEnv, syncGithub, syncMail, systemSecrets, tickManual, bi,
  type Defaults, type GithubSyncReport, type Lang, type MailAccount, type MailFetcher, type MailSyncReport, type MishuStore,
  restartPlan, scheduleRestart, type Channel, type ChannelId, type NotifyReport, type RestartPlan, type RestartStarted, type SecretStore, type TokenResult,
  dueWatches, httpFetch, syncWatch, watchReportKey, watchSources, DEFAULT_NOTIFY, type WatchFetch, type WatchReport, type WatchSource,
} from '../core/index.ts'
import type { MishuConfig } from './config.ts'
import { ScheduleBridge, type ScheduleLike } from './schedule.ts'

interface Logger { info(message: string): void; warn(message: string): void }

export class Runtime {
  store: MishuStore | undefined
  readonly config: MishuConfig
  readonly secrets: SecretStore
  readonly fetcher: MailFetcher
  /** How watched addresses are read; tests swap it for a fake. */
  watchFetch: WatchFetch = httpFetch
  private readonly logger: Logger
  private syncing: Promise<void> | undefined
  /** Where reminders can go; tests swap them for recorders. */
  channels: Record<ChannelId, Channel>
  private notifying: Promise<NotifyReport[]> | undefined
  /** "Sign in with GitHub" in progress, if any; tests swap it to replay GitHub. */
  githubLogin: GithubDeviceLogin
  /** How DSH restarts; tests swap it so they never restart anything. */
  restarter: { plan(): RestartPlan; schedule(plan: Exclude<RestartPlan, { kind: 'none' }>): RestartStarted } = { plan: () => restartPlan(), schedule: plan => scheduleRestart(plan) }
  /**
   * DSH's own scheduled tasks, when this Host has them. Attached by the shell
   * once the `schedule` service shows up; absent on a Host without it.
   */
  schedule: ScheduleBridge | undefined

  constructor(
    config: MishuConfig,
    logger: Logger,
    secrets: SecretStore = new KeychainOrFile(systemSecrets(), new FileSecrets(mishuPaths(config.home).secrets)),
    fetcher: MailFetcher = new ImapFetcher(),
  ) {
    this.config = config
    this.logger = logger
    this.secrets = secrets
    this.githubLogin = new GithubDeviceLogin({ clientId: config.github.clientId, secrets })
    this.channels = { desktop: new DesktopChannel(), feishu: new FeishuChannel(secrets) }
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

  watches(): WatchSource[] {
    return this.store === undefined ? [] : watchSources(this.store)
  }

  /**
   * Wire in DSH's Schedule service, once. The bridge reads the brief's time
   * from the reminder settings, so a brief moved on this page moves the task
   * too. Called again with the same service (a service restart) keeps the
   * bridge and hands it the new handle.
   */
  attachSchedule(service: ScheduleLike): ScheduleBridge {
    if (this.schedule !== undefined) {
      this.schedule.replace(service)
      return this.schedule
    }
    this.schedule = new ScheduleBridge(
      service,
      () => this.store,
      () => this.lang(),
      () => {
        const settings = this.store === undefined ? DEFAULT_NOTIFY : notifySettings(this.store)
        return { time: settings.brief.time, timeZone: settings.timeZone }
      },
    )
    return this.schedule
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
      watches: this.watches(),
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
        error: bi('没有找到这个邮箱的密码（授权码）。在设置页点这个邮箱的「编辑」，重新填一次。', 'No password (app password) found for this account. On the settings page, click Edit on this account and enter it again.'),
      }
      store.set(mailReportKey(account.id), report)
      return report
    }
    const report = await syncMail({ store, account, fetcher: this.fetcher, password, now: Date.now() })
    // Counts only: subjects and addresses never go to the log.
    this.logger.info(`dsh-mishu: mail #${account.id} ${report.error === undefined ? `ok (${report.messages} unread, +${report.opened} open, ${report.closed} closed)` : 'failed'}`)
    return report
  }

  /** One watch; the result is also kept as its last report. */
  async syncWatchSource(source: WatchSource): Promise<WatchReport | undefined> {
    const store = this.store
    if (store === undefined) return undefined
    const report = await syncWatch({ store, source, fetcher: this.watchFetch, now: Date.now() })
    this.logger.info(`dsh-mishu: watch #${source.id} ${report.error === undefined ? `ok (${report.items} items, +${report.opened} open, ${report.closed} closed)` : 'failed'}`)
    return report
  }

  /** The channels that are turned on and work on this computer. */
  async activeChannels(): Promise<Channel[]> {
    const store = this.store
    if (store === undefined) return []
    const enabled = notifySettings(store).channels
    const active: Channel[] = []
    for (const id of Object.keys(enabled) as ChannelId[]) {
      if (enabled[id] && (await this.channels[id].status()).available) active.push(this.channels[id])
    }
    return active
  }

  /** The board as the brief describes it. */
  board(now: number, lang: Lang = this.lang()) {
    const settings = this.settings()
    return buildBoard(this.store!, { now, lang, github: { enabled: settings.githubEnabled, markRead: settings.markRead }, mailAccounts: this.accounts(), watches: this.watches() })
  }

  /** Send what is due now: urgent items, the daily brief. One at a time. */
  notify(now: number = Date.now()): Promise<NotifyReport[]> {
    const store = this.store
    if (store === undefined) return Promise.resolve([])
    this.notifying ??= (async () => {
      const lang = this.lang()
      return notifyTick({ store, now, lang, channels: await this.activeChannels(), board: () => this.board(now, lang) })
    })().catch((error) => {
      this.logger.warn(`dsh-mishu: reminders failed (${(error as Error).message})`)
      return []
    }).finally(() => { this.notifying = undefined })
    return this.notifying
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
      for (const source of dueWatches(store, Date.now())) {
        await this.syncWatchSource(source).catch(error => this.logger.warn(`dsh-mishu: watch #${source.id} failed (${(error as Error).message})`))
      }
      // What the sync turned up may be urgent.
      await this.notify()
    })().finally(() => { this.syncing = undefined })
    return this.syncing
  }

  /** Resolves when the sync in flight (if any) is done. */
  idle(): Promise<void> {
    return this.syncing ?? Promise.resolve()
  }
}
