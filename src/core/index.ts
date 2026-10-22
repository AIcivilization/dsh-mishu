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
export { deleteGithubToken, GITHUB_SECRET, NEW_TOKEN_URL, resolveGithubToken, saveGithubToken, type TokenResult, type TokenSource } from './github/token.ts'
export { bi, decode, detectLang, errorText, LANGS, MishuError, pick, type Bi, type Lang } from './i18n.ts'
export {
  addSeries, describeActiveSeries, describeSeries, resolveSeries, stopSeries, tickManual, upcoming,
  type ResolvedSeries, type SeriesInput,
} from './manual.ts'
export { DEFAULT_DEMOTION, isActive, isDemoted, setStatusByUser, snoozeByUser, type DemotionPolicy } from './matters.ts'
export { CATEGORIES, CATEGORY_LABELS, DEFAULT_LEAD_DAYS, REPEATS, type Category, type Repeat } from './recur.ts'
export { MishuStore, type Matter, type MatterStatus, type Series } from './store.ts'
export { addDays, dayOf, formatMoment } from './time.ts'
export { MAIL_PRESETS, presetById, secretAccount, type MailAccount, type MailFetcher, type MailMessage, type MailPreset } from './mail/account.ts'
export { ImapFetcher } from './mail/imap.ts'
export { judgeMail } from './mail/rules.ts'
export { describeMailError, MAIL_SOURCE, mailReportKey, syncMail, type MailSyncReport } from './mail/sync.ts'
export { findProgram } from './exec.ts'
export { restartPlan, scheduleRestart, type RestartPlan } from './restart.ts'
export { MemorySecrets, secretEnvName, secretFromEnv, systemSecrets, type SecretStatus, type SecretStore } from './secrets.ts'
export { deleteMailAccount, effectiveSettings, mailAccounts, saveMailAccount, saveSettings, type Defaults, type UserSettings } from './settings.ts'

export const DEFAULT_HOME = '~/.mishu'

/** `~` and `~/…` expand to the home directory on every platform. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export function mishuPaths(home: string) {
  const root = expandHome(home)
  return { root, db: join(root, 'mishu.db') }
}
