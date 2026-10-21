import Schema from '@deepseek-ai/schemastery'
import { CLOSING_REASONS, DEFAULT_HOME, DEFAULT_LEAD_DAYS, type Category, type Lang, type MarkReadMode } from '../core/index.ts'

export interface MishuConfig {
  /** Where the notebook lives, outside DSH. `~` expands. */
  home: string
  /** Language of everything the secretary says: auto follows the system locale. */
  language: 'auto' | Lang
  github: {
    enabled: boolean
    intervalMinutes: number
    /** Environment variable holding a token; empty to skip. */
    tokenEnv: string
    /** Fall back to `gh auth token` (the GitHub CLI's keychain entry). */
    useGhCli: boolean
    /** off: never touch GitHub; shadow: record what would be marked read; on: mark it. */
    markRead: MarkReadMode
    /** Which closing reasons may mark read when `markRead` is on. */
    markReadReasons: string[]
  }
  /** Default days of warning per category for things you tell it. */
  leadDays: Record<Category, number>
  /** How far ahead the brief lists things not yet due for a reminder. */
  upcomingDays: number
}

export const Config: Schema<MishuConfig> = Schema.object({
  home: Schema.string().default(DEFAULT_HOME).description('Notebook directory (mishu.db)'),
  language: Schema.union(['auto', 'zh', 'en']).default('auto').description('Language: auto (system locale), zh (中文) or en (English)'),
  github: Schema.object({
    enabled: Schema.boolean().default(true).description('Watch GitHub notifications'),
    intervalMinutes: Schema.natural().min(5).default(15).description('Minutes between GitHub syncs'),
    tokenEnv: Schema.string().default('GITHUB_TOKEN').description('Environment variable with a GitHub token'),
    useGhCli: Schema.boolean().default(true).description('Fall back to `gh auth token`'),
    markRead: Schema.union(['off', 'shadow', 'on']).default('shadow').description('Mark resolved notifications read on GitHub: off / shadow (only record) / on'),
    markReadReasons: Schema.array(Schema.union([...CLOSING_REASONS])).default(['merged', 'closed', 'recovered', 'superseded', 'ref-gone'])
      .description('Closing reasons allowed to mark read'),
  }).default({}),
  leadDays: Schema.object({
    document: Schema.natural().default(DEFAULT_LEAD_DAYS.document).description('Documents (passport, ID, licence)'),
    bill: Schema.natural().default(DEFAULT_LEAD_DAYS.bill).description('Bills and payments'),
    birthday: Schema.natural().default(DEFAULT_LEAD_DAYS.birthday).description('Birthdays and anniversaries'),
    renewal: Schema.natural().default(DEFAULT_LEAD_DAYS.renewal).description('Renewals (insurance, memberships)'),
    other: Schema.natural().default(DEFAULT_LEAD_DAYS.other).description('Everything else'),
  }).default({}),
  upcomingDays: Schema.natural().min(1).default(30).description('Days ahead the brief looks for upcoming items'),
}) as Schema<MishuConfig>
