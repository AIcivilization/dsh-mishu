/**
 * mishu core — everything that does not depend on DSH.
 * Nothing under `src/core` may import DSH; `tests/boundary.test.ts` enforces it.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export { buildAsk, detailText, type AskRequest } from './ask.ts'
export { buildBoard, buildDetail, type BoardCard, type BoardData, type CardAction, type DoneGroup, type MatterDetail } from './board.ts'
export type { CardExplain } from './explain.ts'
export { renderBrief, renderClosed, renderMatter, reasonLabel, sortOpen, type BriefOptions } from './brief.ts'
export { GitHubClient, GitHubError, type FetchLike, type Notification } from './github/client.ts'
export { gatherFacts, Lookups, parseCheckSuiteTitle, type Facts } from './github/facts.ts'
export { CLOSING_REASONS, judge, type Explain, type Verdict } from './github/rules.ts'
export { syncGithub, type GithubSyncReport, type MarkReadMode } from './github/sync.ts'
export { DEVICE_SCOPES, GithubDeviceLogin, type DeviceState } from './github/device.ts'
export { deleteGithubToken, GITHUB_CLIENT_ID, GITHUB_SECRET, NEW_TOKEN_URL, resolveGithubToken, saveGithubToken, type TokenResult, type TokenSource } from './github/token.ts'
export { bi, decode, detectLang, errorText, LANGS, MishuError, pick, type Bi, type Lang } from './i18n.ts'
export {
  addSeries, describeActiveSeries, describeSeries, resolveSeries, stopSeries, tickManual, upcoming,
  type ResolvedSeries, type SeriesInput,
} from './manual.ts'
export { DEFAULT_DEMOTION, isActive, isDemoted, setStatusByUser, snoozeByUser, type DemotionPolicy } from './matters.ts'
export { CATEGORIES, CATEGORY_LABELS, DEFAULT_LEAD_DAYS, REPEATS, type Category, type Repeat } from './recur.ts'
export { MishuStore, type Matter, type MatterStatus, type Series } from './store.ts'
export { addDays, dayOf, formatMoment } from './time.ts'
export {
  MAIL_PRESETS, normalizePassword, presetById, presetForAddress, providerMismatch, resolveAccount, secretAccount, senderOf, smtpOf,
  type MailAccount, type MailAttachment, type MailAttachmentInfo, type MailBody, type MailFetcher, type MailFolder,
  MAX_ATTACHMENT_DOWNLOAD,
  MAX_BATCH, type MailListOptions, type MailListPage, type MailMarkAction, type MailMarkResult, type MailMessage, type MailPreset,
  type MailSearchField, type MailSearchOptions, type MailSearchResult, type MailStep, type MailSummary, type MailSmtp,
} from './mail/account.ts'
export { collectParts, ImapFetcher, type MailPartInfo } from './mail/imap.ts'
export { decodeEntities, sanitizeFilename, shortSubject, stripHtml, tidy, truncateText, uniqueFilename } from './mail/parse.ts'
export {
  bareAddress, canonicalAddress, describeRecipients, forwardBody, forwardSubject, htmlToText, parseAddressList, prepareMail,
  replySubject, replyTargets, resolveAttachments, sanitizeOutgoingHtml, sendMail, textToHtml, verifySmtp,
  type MailCompose, type OutgoingAttachment, type PreparedMail, type SendResult,
} from './mail/send.ts'
export { claimDraft, DRAFT_FIELDS, draftToCompose, draftView, editDraft, MAX_DRAFTS, newDraft, saveDraft, type DraftView } from './mail/draft.ts'
export { assertCustomFolder, folderPath, isSystemFolder } from './mail/folder.ts'
export { cancelSchedule, dueDrafts, isScheduled, scheduledTime, scheduleDraft } from './mail/schedule.ts'
export type { Draft, DraftPatch, DraftState, NewDraft } from './store.ts'
export { judgeMail } from './mail/rules.ts'
export { describeMailError, MAIL_SOURCE, mailReportKey, syncMail, type MailSyncReport } from './mail/sync.ts'
export { findProgram } from './exec.ts'
export { deleteFeishu, DesktopChannel, FeishuChannel, saveFeishu, FEISHU_WEBHOOK } from './channels.ts'
export {
  DEFAULT_NOTIFY, deliver, inQuiet, localClock, notifySettings, notifyTick, NOTIFY_REPORT_KEY, saveNotifySettings, testMessage, URGENT_REASONS,
  type Channel, type ChannelId, type Message, type NotifyReport, type NotifySettings,
} from './notify.ts'
export { restartPlan, scheduleRestart, type RestartPlan, type RestartStarted } from './restart.ts'
export { FileSecrets, KeychainOrFile, MemorySecrets, secretEnvName, secretFromEnv, systemSecrets, type SecretStatus, type SecretStore } from './secrets.ts'
export { deleteMailAccount, effectiveSettings, mailAccounts, saveMailAccount, saveSettings, type Defaults, type UserSettings } from './settings.ts'
export {
  deleteWatch, dueWatches, entryKey, parseKeywords, resolveWatch, saveWatch, watchById, watchReportKey, watchSources,
  WATCH_SOURCE, type WatchInput, type WatchReport, type WatchSource,
} from './watch/source.ts'
export { describeWatchError, httpFetch, parseFeed, parseJson, parsePage, plainText, readWatchBody, type WatchFetch, type WatchItem } from './watch/fetch.ts'
export { describeKeywords, describeWatch, diffItems, judgeWatch, syncWatch } from './watch/sync.ts'
export {
  BRIEF_MARK, BRIEF_TASK_KEY, briefPrompt, briefTiming, briefTitle, clockText, describeTiming, instantText, isBriefTask, sortTasks, taskView,
  type BriefTiming, type ScheduleEntry, type ScheduleKind, type ScheduleTaskView,
} from './schedule/tasks.ts'

export const DEFAULT_HOME = '~/.mishu'

/** `~` and `~/…` expand to the home directory on every platform. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export function mishuPaths(home: string) {
  const root = expandHome(home)
  return { root, db: join(root, 'mishu.db'), secrets: join(root, 'secrets.json'), attachments: join(root, 'attachments') }
}
