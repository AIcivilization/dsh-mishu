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
  describeMailError, MishuError, prepareMail, sendMail, verifySmtp, claimDraft, draftToCompose, draftView, editDraft, saveDraft,
  assertCustomFolder, folderPath,
  cancelSchedule as cancelScheduleIn, dueDrafts, scheduledTime, scheduleDraft as scheduleDraftIn,
  MAX_ATTACHMENT_DOWNLOAD, MAX_BATCH,
  type Draft, type DraftPatch, type DraftView, type MailAttachment, type MailBody, type MailCompose, type MailFolder,
  type MailListOptions, type MailListPage, type MailMarkAction, type MailMarkResult, type MailSearchOptions, type MailSearchResult,
  type NewDraft, type PreparedMail, type SendResult,
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

  /** One account by id. */
  account(id: number): MailAccount | undefined {
    return this.accounts().find(a => a.id === id)
  }

  /**
   * An account and its password, or a sentence saying which one is missing.
   * Every mail operation goes through here, so a disabled account is refused
   * the same way everywhere.
   */
  async mailAccess(id: number): Promise<{ account: MailAccount; password: string }> {
    const account = this.account(id)
    if (account === undefined) throw new MishuError(bi('没有这个邮箱', 'no such mail account'))
    const password = await this.mailPassword(account.id)
    if (password === undefined) {
      throw new MishuError(bi(
        '没有找到这个邮箱的密码（授权码）。在设置页点这个邮箱的「编辑」，重新填一次。',
        'No password (app password) found for this account. On the settings page, click Edit on this account and enter it again.',
      ))
    }
    return { account, password }
  }

  /**
   * Run one mail operation, turning a transport error into a sentence that
   * says what to do about it (the same wording the sync uses).
   */
  private async mailCall<T>(id: number, run: (account: MailAccount, password: string) => Promise<T>): Promise<T> {
    const { account, password } = await this.mailAccess(id)
    try {
      return await run(account, password)
    } catch (error) {
      if (error instanceof MishuError) throw error
      throw new MishuError(describeMailError(error, account))
    }
  }

  /** A page of a mailbox. */
  async mailList(id: number, options: MailListOptions = {}): Promise<MailListPage> {
    return await this.mailCall(id, async (account, password) => {
      if (this.fetcher.list === undefined) throw new MishuError(bi('这个版本读不了邮件列表', 'this build cannot list mail'))
      return await this.fetcher.list(account, password, options)
    })
  }

  /** One message with its body. */
  async mailRead(id: number, folder: string, uid: number, maxChars = 20_000): Promise<MailBody> {
    return await this.mailCall(id, async (account, password) => {
      if (this.fetcher.read === undefined) throw new MishuError(bi('这个版本读不了邮件正文', 'this build cannot read mail bodies'))
      return await this.fetcher.read(account, password, folder, uid, maxChars)
    })
  }

  /** Search one mailbox. */
  async mailSearch(id: number, options: MailSearchOptions): Promise<MailSearchResult> {
    return await this.mailCall(id, async (account, password) => {
      if (this.fetcher.search === undefined) throw new MishuError(bi('这个版本搜不了邮件', 'this build cannot search mail'))
      return await this.fetcher.search(account, password, options)
    })
  }

  /** Mark, star, move or delete one message. */
  async mailMark(id: number, folder: string, uid: number, action: MailMarkAction, destination?: string): Promise<MailMarkResult> {
    return await this.mailCall(id, async (account, password) => {
      if (this.fetcher.mark === undefined) throw new MishuError(bi('这个版本改不了邮件状态', 'this build cannot change mail state'))
      return await this.fetcher.mark(account, password, folder, uid, action, destination)
    })
  }

  /**
   * The same action on several messages. A fetcher without `markMany` is
   * asked one uid at a time, which is slower but says exactly the same thing.
   */
  async mailMarkMany(id: number, folder: string, uids: number[], action: MailMarkAction, destination?: string): Promise<MailMarkResult[]> {
    if (uids.length === 0) throw new MishuError(bi('要选一封邮件', 'pick at least one message'))
    if (uids.length > MAX_BATCH) throw new MishuError(bi(`一次最多 ${MAX_BATCH} 封`, `at most ${MAX_BATCH} messages at a time`))
    return await this.mailCall(id, async (account, password) => {
      if (this.fetcher.markMany !== undefined) return await this.fetcher.markMany(account, password, folder, uids, action, destination)
      if (this.fetcher.mark === undefined) throw new MishuError(bi('这个版本改不了邮件状态', 'this build cannot change mail state'))
      const results: MailMarkResult[] = []
      for (const uid of uids) results.push(await this.fetcher.mark(account, password, folder, uid, action, destination))
      return results
    })
  }

  /** Every folder the server has, with its counts. */
  async mailFolders(id: number): Promise<MailFolder[]> {
    return await this.mailCall(id, async (account, password) => {
      if (this.fetcher.folders === undefined) throw new MishuError(bi('这个版本读不了文件夹', 'this build cannot list folders'))
      return await this.fetcher.folders(account, password)
    })
  }

  /**
   * The mailbox's own folders are off limits: the check reads the live folder
   * list rather than trusting a name, so a label that happens to be called
   * "Archive" is still refused when the server says it is the archive.
   */
  async mailCreateFolder(id: number, path: string): Promise<MailFolder[]> {
    const clean = folderPath(path)
    const rows = await this.mailFolders(id)
    assertCustomFolder(clean, rows, 'create')
    const taken = rows.some(row => row.path.toLowerCase() === clean.toLowerCase())
    if (taken) throw new MishuError(bi(`已经有「${clean}」这个文件夹了`, `there is already a folder called "${clean}"`))
    await this.mailCall(id, async (account, password) => {
      if (this.fetcher.createFolder === undefined) throw new MishuError(bi('这个版本建不了文件夹', 'this build cannot create folders'))
      await this.fetcher.createFolder(account, password, clean)
    })
    return await this.mailFolders(id)
  }

  async mailRenameFolder(id: number, from: string, to: string): Promise<MailFolder[]> {
    const clean = folderPath(to)
    const rows = await this.mailFolders(id)
    assertCustomFolder(from, rows, 'rename')
    assertCustomFolder(clean, rows, 'rename')
    await this.mailCall(id, async (account, password) => {
      if (this.fetcher.renameFolder === undefined) throw new MishuError(bi('这个版本改不了文件夹名', 'this build cannot rename folders'))
      await this.fetcher.renameFolder(account, password, from, clean)
    })
    return await this.mailFolders(id)
  }

  async mailDeleteFolder(id: number, path: string): Promise<MailFolder[]> {
    const rows = await this.mailFolders(id)
    assertCustomFolder(path, rows, 'delete')
    const row = rows.find(item => item.path === path)
    if (row?.messages !== undefined && row.messages > 0) {
      throw new MishuError(bi(
        `「${path}」里还有 ${row.messages} 封信，先把它们移走或删掉。`,
        `"${path}" still holds ${row.messages} messages; move or delete them first.`,
      ))
    }
    await this.mailCall(id, async (account, password) => {
      if (this.fetcher.deleteFolder === undefined) throw new MishuError(bi('这个版本删不了文件夹', 'this build cannot delete folders'))
      await this.fetcher.deleteFolder(account, password, path)
    })
    return await this.mailFolders(id)
  }

  /** One attachment, as bytes; the caller decides where it goes. */
  async mailAttachment(id: number, folder: string, uid: number, index: number, maxBytes = MAX_ATTACHMENT_DOWNLOAD): Promise<MailAttachment> {
    return await this.mailCall(id, async (account, password) => {
      if (this.fetcher.attachment === undefined) throw new MishuError(bi('这个版本下不了附件', 'this build cannot download attachments'))
      return await this.fetcher.attachment(account, password, folder, uid, index, maxBytes)
    })
  }

  /** Check a compose request without sending: what the approval card shows. */
  async prepareMail(id: number, compose: MailCompose): Promise<PreparedMail> {
    const { account } = await this.mailAccess(id)
    return await prepareMail(compose, { account, cwd: this.config.home })
  }

  /** Send a prepared message. */
  async sendMail(id: number, mail: PreparedMail): Promise<SendResult> {
    return await this.mailCall(id, async (account, password) => await sendMail(account, password, mail))
  }

  /** Check that the password also opens SMTP (reading and sending share it). */
  async verifySmtp(id: number, password?: string): Promise<void> {
    const account = this.account(id)
    if (account === undefined) throw new MishuError(bi('没有这个邮箱', 'no such mail account'))
    const secret = password ?? (await this.mailPassword(account.id))
    if (secret === undefined) throw new MishuError(bi('没有找到这个邮箱的密码（授权码）', 'no password (app password) found for this account'))
    try {
      await verifySmtp(account, secret)
    } catch (error) {
      if (error instanceof MishuError) throw error
      throw new MishuError(describeMailError(error, account))
    }
  }

  /** Drafts of one account. */
  drafts(id: number, state?: Draft['state']): DraftView[] {
    const store = this.store
    const account = this.account(id)
    if (store === undefined || account === undefined) return []
    return store.drafts(id, state).map(draft => draftView(draft, account))
  }

  saveDraft(id: number, input: Partial<MailCompose> & { reply?: NewDraft['reply'] }): DraftView {
    const store = this.store
    const account = this.account(id)
    if (store === undefined || account === undefined) throw new MishuError(bi('记事本还没打开', 'the notebook is not open'))
    return draftView(saveDraft(store, account, input, Date.now()), account)
  }

  editDraft(id: number, draftId: string, revision: number, patch: DraftPatch): DraftView {
    const store = this.store
    const account = this.account(id)
    if (store === undefined || account === undefined) throw new MishuError(bi('记事本还没打开', 'the notebook is not open'))
    return draftView(editDraft(store, account, draftId, revision, patch, Date.now()), account)
  }

  deleteDraft(draftId: string): void {
    this.store?.deleteDraft(draftId)
  }

  /**
   * Send a draft: claim it, check it, send it, stamp it sent. A failure puts
   * it back to `draft` so it can be looked at and sent again.
   */
  async sendDraft(id: number, draftId: string, revision: number): Promise<SendResult> {
    const store = this.store
    const account = this.account(id)
    if (store === undefined || account === undefined) throw new MishuError(bi('记事本还没打开', 'the notebook is not open'))
    const claimed = claimDraft(store, account, draftId, revision, Date.now())
    try {
      return await this.deliver(account, claimed)
    } catch (error) {
      // Back to draft, at the next revision, so the editor shows it again.
      this.release(claimed.id)
      throw error
    }
  }

  /**
   * Send what a draft says. Shared by a manual send and by the clock, so a
   * scheduled message leaves through exactly the same path — addresses
   * checked, thread preserved, attachments measured.
   */
  private async deliver(account: MailAccount, draft: Draft): Promise<SendResult> {
    const store = this.store!
    const compose = draftToCompose(draft)
    // A draft saved from a reply carries where it answers: set the thread
    // headers here too, or sending it later would start a new conversation.
    const reply = draft.reply
    const thread = reply === null ? undefined : await this.threadOf(account.id, reply.folder, reply.uid)
    const mail = await prepareMail(thread === undefined ? compose : { ...compose, inReplyTo: thread, references: thread === null ? [] : [thread] }, { account, cwd: this.config.home })
    const result = await this.sendMail(account.id, mail)
    store.markDraftSent(draft.id, Date.now())
    store.log(Date.now(), 'mail-sent', { account: account.id, draft: draft.id, recipients: mail.to.length + mail.cc.length + mail.bcc.length })
    return result
  }

  /** Put a claimed draft back where it was, at the next revision. */
  private release(draftId: string): void {
    const store = this.store
    const current = store?.draftById(draftId)
    if (store !== undefined && current !== undefined) {
      store.updateDraft(draftId, current.revision, { state: 'draft', sendAt: null }, Date.now())
    }
  }

  // ── scheduled mail ──────────────────────────────────────

  /** Put a draft on the clock; the time must name its timezone. */
  scheduleDraft(id: number, draftId: string, revision: number, sendAt: unknown): DraftView {
    const store = this.store
    const account = this.account(id)
    if (store === undefined || account === undefined) throw new MishuError(bi('记事本还没打开', 'the notebook is not open'))
    const now = Date.now()
    const at = scheduledTime(sendAt, now)
    return draftView(scheduleDraftIn(store, account, draftId, revision, at, now), account)
  }

  /** Take a draft off the clock. */
  cancelSchedule(draftId: string, revision: number): DraftView {
    const store = this.store
    if (store === undefined) throw new MishuError(bi('记事本还没打开', 'the notebook is not open'))
    const next = cancelScheduleIn(store, draftId, revision, Date.now())
    const account = this.account(next.account)
    return { ...next, from: account?.address ?? '' }
  }

  /**
   * Send everything whose time has come, one at a time.
   *
   * A scheduled message is claimed before it is sent, so two ticks cannot send
   * it twice. A failure is not retried on its own: the message goes back to
   * `draft` with the reason attached, because a mail that failed once may fail
   * for a reason only a person can fix (a wrong address, a full mailbox), and
   * trying it again every ten minutes is worse than saying so once.
   */
  async sendDueMail(): Promise<{ sent: number; failed: number; errors: string[] }> {
    const store = this.store
    if (store === undefined) return { sent: 0, failed: 0, errors: [] }
    const due = dueDrafts(store, Date.now())
    let sent = 0
    const errors: string[] = []
    for (const draft of due) {
      const account = this.account(draft.account)
      if (account === undefined) {
        this.release(draft.id)
        errors.push(bi('这个邮箱已经删掉了', 'that mail account is gone')[this.lang()])
        continue
      }
      const claimed = store.updateDraft(draft.id, draft.revision, { state: 'sending' }, Date.now())
      if (claimed === undefined) continue
      try {
        const result = await this.deliver(account, claimed)
        sent += 1
        this.logger.info(`dsh-mishu: scheduled draft ${draft.id.slice(0, 8)} sent (${result.messageId})`)
      } catch (error) {
        const why = error instanceof MishuError ? error.text[this.lang()] : describeMailError(error, account)[this.lang()]
        errors.push(why)
        const current = store.draftById(draft.id)
        if (current !== undefined) {
          store.updateDraft(draft.id, current.revision, { state: 'draft', sendAt: null, error: why }, Date.now())
        }
        this.logger.warn(`dsh-mishu: scheduled draft ${draft.id.slice(0, 8)} failed (${why})`)
      }
    }
    return { sent, failed: errors.length, errors }
  }

  /**
   * The Message-ID a draft answers, or `null` when the original has none.
   * A draft whose original has since been deleted still sends — just without
   * joining a thread it can no longer see.
   */
  private async threadOf(id: number, folder: string, uid: number): Promise<string | null> {
    try {
      const original = await this.mailRead(id, folder, uid, 1)
      return original.messageId
    } catch {
      return null
    }
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
