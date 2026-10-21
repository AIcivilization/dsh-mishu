/**
 * The secretary's notebook: one SQLite file under the mishu home.
 *
 * Matters are what you see ("things to handle"); messages are the evidence
 * that opened, updated or closed them; series are the things you told it to
 * remember. Only metadata and short notes are kept — never message bodies or
 * tokens. Core code must not import anything from DSH.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Category, Repeat } from './recur.ts'

const SCHEMA_VERSION = 3

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matters (
  id          INTEGER PRIMARY KEY,
  key         TEXT    NOT NULL UNIQUE,
  source      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  note        TEXT,
  url         TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('open', 'done', 'dismissed')),
  reason      TEXT,
  closed_by   TEXT    CHECK (closed_by IN ('rule', 'source', 'user')),
  due_day     TEXT,
  remind_day  TEXT,
  series_id   INTEGER REFERENCES series(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  activity_at INTEGER,
  override_at INTEGER,
  snooze_until TEXT,
  explain     TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT    PRIMARY KEY,
  source          TEXT    NOT NULL,
  matter_key      TEXT    NOT NULL,
  subject_type    TEXT,
  why             TEXT,
  repo            TEXT,
  title           TEXT    NOT NULL,
  updated_at      INTEGER NOT NULL,
  unread          INTEGER NOT NULL,
  verdict_status  TEXT    NOT NULL,
  verdict_reason  TEXT    NOT NULL,
  seen_at         INTEGER NOT NULL,
  would_mark_read INTEGER NOT NULL DEFAULT 0,
  marked_read_at  INTEGER
);
CREATE TABLE IF NOT EXISTS series (
  id         INTEGER PRIMARY KEY,
  title      TEXT    NOT NULL,
  category   TEXT    NOT NULL,
  first_due  TEXT    NOT NULL,
  repeat     TEXT    NOT NULL,
  every      INTEGER NOT NULL,
  lead_days  INTEGER NOT NULL,
  note       TEXT,
  next_k     INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  stopped_at INTEGER
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  id   INTEGER PRIMARY KEY,
  at   INTEGER NOT NULL,
  type TEXT    NOT NULL,
  data TEXT
);
CREATE TABLE IF NOT EXISTS rule_stats (
  reason    TEXT    PRIMARY KEY,
  fired     INTEGER NOT NULL DEFAULT 0,
  corrected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS matters_by_status ON matters(status, closed_at);
CREATE INDEX IF NOT EXISTS messages_by_matter ON messages(matter_key);
CREATE INDEX IF NOT EXISTS messages_unread ON messages(source, unread);
`

export type MatterStatus = 'open' | 'done' | 'dismissed'
export type ClosedBy = 'rule' | 'source' | 'user'

export interface Matter {
  id: number
  key: string
  source: string
  kind: string
  title: string
  note: string | null
  url: string | null
  status: MatterStatus
  /** Reason code for the current status (`merged`, `ci-failing`, `manual`, …). */
  reason: string | null
  closedBy: ClosedBy | null
  dueDay: string | null
  remindDay: string | null
  seriesId: number | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
  /** Latest activity seen at the source. */
  activityAt: number | null
  /** When you last set the status by hand; the source cannot override it until newer activity arrives. */
  overrideAt: number | null
  /** Day you asked to be reminded again; off the to-do list until then. */
  snoozeUntil: string | null
  /** JSON of the rule's explanation (what / why / fix / link), bilingual. */
  explain: string | null
}

export interface NewMatter {
  key: string
  source: string
  kind: string
  title: string
  note?: string | null
  url?: string | null
  status: MatterStatus
  reason?: string | null
  closedBy?: ClosedBy | null
  dueDay?: string | null
  remindDay?: string | null
  seriesId?: number | null
  activityAt?: number | null
  explain?: string | null
}

export interface Message {
  id: string
  source: string
  matterKey: string
  subjectType: string | null
  /** Why the source sent it (GitHub's `reason`: author, mention, ci_activity…). */
  why: string | null
  repo: string | null
  title: string
  updatedAt: number
  unread: boolean
  verdictStatus: 'open' | 'done'
  verdictReason: string
  seenAt: number
  wouldMarkRead: boolean
  markedReadAt: number | null
}

export interface Series {
  id: number
  title: string
  category: Category
  firstDue: string
  repeat: Repeat
  every: number
  leadDays: number
  note: string | null
  /** Index of the next occurrence not yet turned into a matter. */
  nextK: number
  active: boolean
  createdAt: number
  stoppedAt: number | null
}

export interface NewSeries {
  title: string
  category: Category
  firstDue: string
  repeat: Repeat
  every: number
  leadDays: number
  note?: string | null
}

export interface RuleStats {
  reason: string
  fired: number
  corrected: number
}

type Row = Record<string, unknown>

const str = (v: unknown) => (v === null || v === undefined ? null : String(v))
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

function toMatter(row: Row): Matter {
  return {
    id: Number(row.id),
    key: String(row.key),
    source: String(row.source),
    kind: String(row.kind),
    title: String(row.title),
    note: str(row.note),
    url: str(row.url),
    status: row.status as MatterStatus,
    reason: str(row.reason),
    closedBy: str(row.closed_by) as ClosedBy | null,
    dueDay: str(row.due_day),
    remindDay: str(row.remind_day),
    seriesId: num(row.series_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    closedAt: num(row.closed_at),
    activityAt: num(row.activity_at),
    overrideAt: num(row.override_at),
    snoozeUntil: str(row.snooze_until),
    explain: str(row.explain),
  }
}

function toMessage(row: Row): Message {
  return {
    id: String(row.id),
    source: String(row.source),
    matterKey: String(row.matter_key),
    subjectType: str(row.subject_type),
    why: str(row.why),
    repo: str(row.repo),
    title: String(row.title),
    updatedAt: Number(row.updated_at),
    unread: Number(row.unread) === 1,
    verdictStatus: row.verdict_status as 'open' | 'done',
    verdictReason: String(row.verdict_reason),
    seenAt: Number(row.seen_at),
    wouldMarkRead: Number(row.would_mark_read) === 1,
    markedReadAt: num(row.marked_read_at),
  }
}

function toSeries(row: Row): Series {
  return {
    id: Number(row.id),
    title: String(row.title),
    category: row.category as Category,
    firstDue: String(row.first_due),
    repeat: row.repeat as Repeat,
    every: Number(row.every),
    leadDays: Number(row.lead_days),
    note: str(row.note),
    nextK: Number(row.next_k),
    active: Number(row.active) === 1,
    createdAt: Number(row.created_at),
    stoppedAt: num(row.stopped_at),
  }
}

/** Columns a matter update may touch. */
export type MatterPatch = Partial<Pick<Matter,
  'title' | 'note' | 'url' | 'status' | 'reason' | 'closedBy' | 'closedAt' | 'activityAt' | 'overrideAt' | 'kind' | 'snoozeUntil' | 'explain'>>

const PATCH_COLUMNS: Record<keyof MatterPatch, string> = {
  title: 'title',
  note: 'note',
  url: 'url',
  status: 'status',
  reason: 'reason',
  closedBy: 'closed_by',
  closedAt: 'closed_at',
  activityAt: 'activity_at',
  overrideAt: 'override_at',
  kind: 'kind',
  snoozeUntil: 'snooze_until',
  explain: 'explain',
}

export class MishuStore {
  readonly path: string
  private readonly db: DatabaseSync

  private constructor(path: string, db: DatabaseSync) {
    this.path = path
    this.db = db
  }

  /** Open (creating if needed) the notebook at `path`; `:memory:` for tests. */
  static open(path: string): MishuStore {
    // Owner-only on POSIX (ignored on Windows): the notebook says what you are dealing with.
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version)
    if (version > SCHEMA_VERSION) {
      db.close()
      throw new Error(`dsh-mishu: ${path} has schema ${version}, this build only knows ${SCHEMA_VERSION}`)
    }
    db.exec(SCHEMA)
    // v1 → v2: matters gained snooze_until; v2 → v3: explain.
    const columns = (db.prepare('PRAGMA table_info(matters)').all() as Row[]).map(c => String(c.name))
    if (!columns.includes('snooze_until')) db.exec('ALTER TABLE matters ADD COLUMN snooze_until TEXT')
    if (!columns.includes('explain')) db.exec('ALTER TABLE matters ADD COLUMN explain TEXT')
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    return new MishuStore(path, db)
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  /** Run `fn` in one transaction. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── matters ─────────────────────────────────────────────

  matterByKey(key: string): Matter | undefined {
    const row = this.db.prepare('SELECT * FROM matters WHERE key = ?').get(key) as Row | undefined
    return row === undefined ? undefined : toMatter(row)
  }

  matterById(id: number): Matter | undefined {
    const row = this.db.prepare('SELECT * FROM matters WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : toMatter(row)
  }

  insertMatter(m: NewMatter, now: number): Matter {
    const closed = m.status !== 'open'
    const result = this.db.prepare(`
      INSERT INTO matters (key, source, kind, title, note, url, status, reason, closed_by, due_day, remind_day,
        series_id, created_at, updated_at, closed_at, activity_at, explain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.key, m.source, m.kind, m.title, m.note ?? null, m.url ?? null, m.status, m.reason ?? null,
      closed ? (m.closedBy ?? 'rule') : null, m.dueDay ?? null, m.remindDay ?? null, m.seriesId ?? null,
      now, now, closed ? now : null, m.activityAt ?? null, m.explain ?? null,
    )
    return this.matterById(Number(result.lastInsertRowid))!
  }

  updateMatter(id: number, patch: MatterPatch, now: number): Matter {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as Array<[keyof MatterPatch, unknown]>
    if (entries.length > 0) {
      const sets = entries.map(([k]) => `${PATCH_COLUMNS[k]} = ?`).join(', ')
      this.db.prepare(`UPDATE matters SET ${sets}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, v]) => v as string | number | null), now, id)
    }
    return this.matterById(id)!
  }

  openMatters(): Matter[] {
    return (this.db.prepare("SELECT * FROM matters WHERE status = 'open' ORDER BY id").all() as Row[]).map(toMatter)
  }

  /** Matters closed (by any party) at or after `since`, newest first. */
  closedSince(since: number): Matter[] {
    return (this.db.prepare("SELECT * FROM matters WHERE status != 'open' AND closed_at >= ? ORDER BY closed_at DESC, id DESC")
      .all(since) as Row[]).map(toMatter)
  }

  mattersOfSource(source: string): Matter[] {
    return (this.db.prepare('SELECT * FROM matters WHERE source = ? ORDER BY id').all(source) as Row[]).map(toMatter)
  }

  // ── messages ────────────────────────────────────────────

  messageById(id: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : toMessage(row)
  }

  upsertMessage(m: Omit<Message, 'wouldMarkRead' | 'markedReadAt'>): void {
    this.db.prepare(`
      INSERT INTO messages (id, source, matter_key, subject_type, why, repo, title, updated_at, unread,
        verdict_status, verdict_reason, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET matter_key = excluded.matter_key, subject_type = excluded.subject_type,
        why = excluded.why, repo = excluded.repo, title = excluded.title, updated_at = excluded.updated_at,
        unread = excluded.unread, verdict_status = excluded.verdict_status, verdict_reason = excluded.verdict_reason,
        seen_at = excluded.seen_at`,
    ).run(
      m.id, m.source, m.matterKey, m.subjectType, m.why, m.repo, m.title, m.updatedAt, m.unread ? 1 : 0,
      m.verdictStatus, m.verdictReason, m.seenAt,
    )
  }

  unreadMessages(source: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE source = ? AND unread = 1 ORDER BY updated_at DESC').all(source) as Row[])
      .map(toMessage)
  }

  messagesOfMatter(key: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE matter_key = ? ORDER BY updated_at DESC').all(key) as Row[]).map(toMessage)
  }

  setMessageUnread(id: string, unread: boolean): void {
    this.db.prepare('UPDATE messages SET unread = ? WHERE id = ?').run(unread ? 1 : 0, id)
  }

  setWouldMarkRead(id: string, would: boolean): void {
    this.db.prepare('UPDATE messages SET would_mark_read = ? WHERE id = ?').run(would ? 1 : 0, id)
  }

  setMarkedRead(id: string, at: number): void {
    this.db.prepare('UPDATE messages SET marked_read_at = ?, unread = 0, would_mark_read = 0 WHERE id = ?').run(at, id)
  }

  /** Unread messages the shadow run says it would mark read. */
  wouldMarkReadCount(source: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE source = ? AND unread = 1 AND would_mark_read = 1')
      .get(source) as Row).n)
  }

  // ── series ──────────────────────────────────────────────

  insertSeries(s: NewSeries, now: number): Series {
    const result = this.db.prepare(`
      INSERT INTO series (title, category, first_due, repeat, every, lead_days, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.title, s.category, s.firstDue, s.repeat, s.every, s.leadDays, s.note ?? null, now)
    return this.seriesById(Number(result.lastInsertRowid))!
  }

  seriesById(id: number): Series | undefined {
    const row = this.db.prepare('SELECT * FROM series WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : toSeries(row)
  }

  activeSeries(): Series[] {
    return (this.db.prepare('SELECT * FROM series WHERE active = 1 ORDER BY id').all() as Row[]).map(toSeries)
  }

  advanceSeries(id: number, nextK: number, active: boolean, now: number): void {
    this.db.prepare('UPDATE series SET next_k = ?, active = ?, stopped_at = CASE WHEN ? = 0 THEN ? ELSE stopped_at END WHERE id = ?')
      .run(nextK, active ? 1 : 0, active ? 1 : 0, now, id)
  }

  // ── kv, log, rule stats ─────────────────────────────────

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined
    return row === undefined ? undefined : JSON.parse(String(row.value)) as T
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  log(at: number, type: string, data?: unknown): void {
    this.db.prepare('INSERT INTO log (at, type, data) VALUES (?, ?, ?)').run(at, type, data === undefined ? null : JSON.stringify(data))
  }

  logSince(since: number, type?: string): Array<{ at: number; type: string; data: unknown }> {
    const rows = (type === undefined
      ? this.db.prepare('SELECT * FROM log WHERE at >= ? ORDER BY id').all(since)
      : this.db.prepare('SELECT * FROM log WHERE at >= ? AND type = ? ORDER BY id').all(since, type)) as Row[]
    return rows.map(row => ({ at: Number(row.at), type: String(row.type), data: row.data === null ? undefined : JSON.parse(String(row.data)) }))
  }

  bumpRule(reason: string, field: 'fired' | 'corrected'): void {
    this.db.prepare(`INSERT INTO rule_stats (reason, ${field}) VALUES (?, 1)
      ON CONFLICT(reason) DO UPDATE SET ${field} = ${field} + 1`).run(reason)
  }

  ruleStats(): RuleStats[] {
    return (this.db.prepare('SELECT * FROM rule_stats ORDER BY reason').all() as Row[])
      .map(row => ({ reason: String(row.reason), fired: Number(row.fired), corrected: Number(row.corrected) }))
  }
}
