/**
 * Mail over IMAP.
 *
 * Reading a folder opens it with EXAMINE (`readOnly: true`), so looking never
 * marks anything read; only the envelope, flags, structure and a few headers
 * are fetched, and a body is pulled part by part only when someone asks for
 * it. `unread()` is the one operation the sync needs, and it is the one that
 * stays closest to the old behaviour: envelope and headers, never a body.
 */

import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import type { Readable } from 'node:stream'
import { stripHtml, truncateText, tidy } from './parse.ts'
import type {
  MailAccount,
  MailAddress,
  MailAttachment,
  MailAttachmentInfo,
  MailBody,
  MailFetcher,
  MailFolder,
  MailListOptions,
  MailListPage,
  MailMarkAction,
  MailMarkResult,
  MailMessage,
  MailSearchField,
  MailSearchOptions,
  MailSearchResult,
  MailSummary,
} from './account.ts'

const HEADERS = ['list-id', 'list-unsubscribe', 'auto-submitted', 'precedence', 'references']
/** Newest unread messages looked at per sync. */
const MAX_MESSAGES = 200
/** Newest messages a local header search will look through. */
const MAX_SCAN = 2000
/** Bytes of one body part read for a message body. */
const BODY_BYTES = 512 * 1024
/** A folder listing will not return more than this in one page. */
const MAX_LIMIT = 100

export function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** Unfolded `name: value` pairs, names lower-cased. */
export function parseHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>()
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim())
  }
  return headers
}

interface Structure {
  part?: string
  type?: string
  parameters?: Record<string, string>
  id?: string
  encoding?: string
  size?: number
  disposition?: string
  dispositionParameters?: Record<string, string>
  childNodes?: Structure[]
}

function hasCalendarPart(node: Structure | undefined): boolean {
  if (node === undefined) return false
  if (node.type?.toLowerCase() === 'text/calendar') return true
  return (node.childNodes ?? []).some(hasCalendarPart)
}

/** One leaf of a body structure, with the part id IMAP would use to fetch it. */
export interface MailPartInfo {
  /** The id `download()` takes: "1", "2", "1.2". */
  part: string
  type: string
  filename: string | null
  disposition: string | null
  contentId: string | null
  size: number
  isAttachment: boolean
}

/**
 * The leaves of a body structure in reading order, with IMAP part ids.
 *
 * A multipart node is numbered from one and its children extend the path
 * ("1", "1.2"); a single-part message is "1", which `download()` maps to the
 * message text.
 */
export function collectParts(root: Structure | undefined): MailPartInfo[] {
  const out: MailPartInfo[] = []
  const walk = (node: Structure, path: string[]): void => {
    const children = node.childNodes ?? []
    if (children.length > 0) {
      children.forEach((child, i) => walk(child, [...path, String(i + 1)]))
      return
    }
    const type = (node.type ?? 'application/octet-stream').toLowerCase()
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null
    const disposition = node.disposition?.toLowerCase() ?? null
    const inline = disposition === 'inline'
    out.push({
      part: path.length === 0 ? '1' : path.join('.'),
      type,
      filename,
      disposition,
      contentId: node.id ?? null,
      size: node.size ?? 0,
      isAttachment: disposition === 'attachment' || (!inline && filename !== null) || (!inline && !type.startsWith('text/') && !type.startsWith('multipart/') && type !== 'message/rfc822'),
    })
  }
  if (root !== undefined) walk(root, [])
  return out
}

const toAddress = (a: { name?: string; address?: string }): MailAddress => ({ name: a.name ?? '', address: (a.address ?? '').toLowerCase() })

interface Envelope {
  date?: Date | string
  subject?: string
  messageId?: string
  inReplyTo?: string
  from?: Array<{ name?: string; address?: string }>
  to?: Array<{ name?: string; address?: string }>
  cc?: Array<{ name?: string; address?: string }>
}

interface Fetched {
  uid: number
  envelope?: Envelope
  internalDate?: Date | string
  headers?: Buffer
  bodyStructure?: Structure
  flags?: Set<string>
  size?: number
}

const messageTime = (fetched: Fetched): number => {
  const when = fetched.envelope?.date ?? fetched.internalDate
  return when === undefined ? 0 : new Date(when).getTime()
}

/** Build the rules' view of one fetched message. */
export function toMailMessage(fetched: Fetched, accountId: number): MailMessage {
  const env = fetched.envelope ?? {}
  const headers = parseHeaders(fetched.headers?.toString('utf8') ?? '')
  const references = (headers.get('references') ?? '').split(/\s+/).filter(Boolean)
  const messageId = env.messageId ?? null
  const threadRoot = references[0] ?? env.inReplyTo ?? messageId ?? `uid:${fetched.uid}`
  return {
    id: `mail:${accountId}:${hashId(messageId ?? `uid:${fetched.uid}`)}`,
    uid: fetched.uid,
    messageId,
    threadRoot,
    subject: env.subject ?? '',
    date: messageTime(fetched),
    from: env.from?.[0] === undefined ? null : toAddress(env.from[0]),
    to: (env.to ?? []).map(toAddress),
    cc: (env.cc ?? []).map(toAddress),
    listId: headers.get('list-id') ?? null,
    listUnsubscribe: headers.get('list-unsubscribe') ?? null,
    autoSubmitted: headers.get('auto-submitted') ?? null,
    precedence: headers.get('precedence') ?? null,
    hasCalendar: hasCalendarPart(fetched.bodyStructure),
  }
}

/** A listing row, from the same fetch the rules use plus flags and size. */
export function toSummary(fetched: Fetched, accountId: number, folder: string): MailSummary {
  const env = fetched.envelope ?? {}
  const flags = fetched.flags ?? new Set<string>()
  const parts = collectParts(fetched.bodyStructure)
  const messageId = env.messageId ?? null
  return {
    id: `mail:${accountId}:${hashId(messageId ?? `uid:${fetched.uid}`)}`,
    uid: fetched.uid,
    messageId,
    subject: env.subject ?? '',
    date: messageTime(fetched),
    from: env.from?.[0] === undefined ? null : toAddress(env.from[0]),
    to: (env.to ?? []).map(toAddress),
    cc: (env.cc ?? []).map(toAddress),
    size: fetched.size ?? 0,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: parts.some(p => p.isAttachment),
    hasCalendar: parts.some(p => p.type === 'text/calendar'),
    folder,
  }
}

/** Does this row match a local search? `body` is never matched here. */
export function matchesQuery(summary: MailSummary, query: string, fields: readonly MailSearchField[]): boolean {
  const q = query.toLowerCase()
  const has = (text: string): boolean => text.toLowerCase().includes(q)
  return fields.some(field => {
    switch (field) {
      case 'subject':
        return has(summary.subject)
      case 'from':
        return summary.from !== null && (has(summary.from.address) || has(summary.from.name))
      case 'to':
        return summary.to.some(a => has(a.address) || has(a.name))
      case 'cc':
        return summary.cc.some(a => has(a.address) || has(a.name))
      case 'body':
        return false
    }
  })
}

/** Read a stream into a buffer, stopping at `maxBytes`. */
async function readStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let remaining = maxBytes
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    if (buf.length >= remaining) {
      chunks.push(buf.subarray(0, remaining))
      remaining = 0
      break
    }
    chunks.push(buf)
    remaining -= buf.length
  }
  return Buffer.concat(chunks)
}

/** The UID a copied or moved message got in its new folder, when the server says. */
function newUidOf(response: unknown, uid: number): number | null {
  if (response === false || response === null || typeof response !== 'object') return null
  const map = (response as { uidMap?: Map<number, number> }).uidMap
  return map?.get(uid) ?? null
}

/** The folder a delete goes to: whatever the server marks as Trash. */
async function trashPath(client: ImapFlow): Promise<string> {
  const rows = await client.list().catch(() => [])
  const trash = rows.find(row => row.specialUse === '\\Trash' || /^(trash|deleted items|deleted messages|已删除|已删除邮件|废纸篓|回收站)$/i.test(row.name))
  if (trash === undefined) throw new Error('this mailbox has no Trash folder to delete into')
  return trash.path
}

/** Move one message, with the copy-then-delete fallback servers without MOVE need. */
async function relocate(client: ImapFlow, uid: number, target: string): Promise<number | null> {
  const moved = await client.messageMove(uid, target, { uid: true }).catch(() => false)
  if (moved !== false) return newUidOf(moved, uid)
  const copied = await client.messageCopy(uid, target, { uid: true }).catch(() => false)
  if (copied === false) throw new Error(`could not move message ${uid} to ${target}`)
  await client.messageDelete(uid, { uid: true })
  return newUidOf(copied, uid)
}

function clamp(value: number | undefined, low: number, high: number, fallback: number): number {
  const n = Math.trunc(Number(value ?? fallback))
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback
}

/** A connection that is ready to run commands; `logout()` it in a `finally`. */
async function connect(account: MailAccount, password: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: password },
    logger: false,
    clientInfo: { name: 'dsh-mishu' },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  })
  // A dropped connection must not crash the host; the awaited calls report it.
  client.on('error', () => {})
  await client.connect()
  return client
}

/** Run `work` with a mailbox open, and close the connection whatever happens. */
async function withMailbox<T>(
  account: MailAccount,
  password: string,
  folder: string,
  mode: 'read' | 'write',
  work: (client: ImapFlow, exists: number) => Promise<T>,
): Promise<T> {
  const client = await connect(account, password)
  try {
    const lock = await client.getMailboxLock(folder, mode === 'read' ? { readOnly: true, description: 'dsh-mishu read-only' } : {})
    try {
      const opened = client.mailbox
      return await work(client, opened === false ? 0 : opened.exists)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

/** Run `work` on a connection with no mailbox open (folders, sending). */
async function withClient<T>(account: MailAccount, password: string, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connect(account, password)
  try {
    return await work(client)
  } finally {
    await client.logout().catch(() => client.close())
  }
}

export class ImapFetcher implements MailFetcher {
  async unread(account: MailAccount, password: string, sinceDays: number, now: number): Promise<MailMessage[]> {
    return await withMailbox(account, password, 'INBOX', 'read', async client => {
      const since = new Date(now - sinceDays * 86_400_000)
      const found = await client.search({ seen: false, since }, { uid: true })
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, MAX_MESSAGES)
      if (uids.length === 0) return []
      const messages: MailMessage[] = []
      for await (const fetched of client.fetch(uids, { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: HEADERS }, { uid: true })) {
        messages.push(toMailMessage(fetched as Fetched, account.id))
      }
      return messages
    })
  }

  async list(account: MailAccount, password: string, options: MailListOptions): Promise<MailListPage> {
    const folder = options.folder ?? 'INBOX'
    const limit = clamp(options.limit, 1, MAX_LIMIT, 20)
    const offset = clamp(options.offset, 0, 100_000, 0)
    return await withMailbox(account, password, folder, 'read', async (client, exists) => {
      if (exists === 0) return { folder, total: 0, messages: [] }
      const from = Math.max(1, exists - offset - limit + 1)
      const to = exists - offset
      if (to < 1) return { folder, total: exists, messages: [] }
      const rows = await client.fetchAll(`${from}:${to}`, { uid: true, envelope: true, internalDate: true, flags: true, size: true, bodyStructure: true })
      const messages = rows
        .map(fetched => toSummary(fetched as Fetched, account.id, folder))
        .filter(m => options.unreadOnly !== true || !m.seen)
        .filter(m => options.since === undefined || m.date >= options.since)
        .filter(m => options.until === undefined || m.date <= options.until)
        .sort((a, b) => b.date - a.date)
      return { folder, total: exists, messages }
    })
  }

  async read(account: MailAccount, password: string, folder: string, uid: number, maxChars: number): Promise<MailBody> {
    return await withMailbox(account, password, folder, 'read', async client => {
      const fetched = await client.fetchOne(uid, { uid: true, envelope: true, internalDate: true, flags: true, size: true, bodyStructure: true }, { uid: true })
      if (fetched === false || fetched === undefined) throw new Error(`message ${uid} is not in ${folder}`)
      const summary = toSummary(fetched as Fetched, account.id, folder)
      const parts = collectParts(fetched.bodyStructure as Structure | undefined)
      const textPart = parts.find(p => p.type === 'text/plain' && !p.isAttachment)
      const htmlPart = parts.find(p => p.type === 'text/html' && !p.isAttachment)
      const body = async (part: MailPartInfo): Promise<string> => {
        const got = await client.download(uid, part.part, { uid: true, maxBytes: BODY_BYTES })
        if (got.content === undefined) return ''
        return (await readStream(got.content, BODY_BYTES)).toString('utf8')
      }
      const html = htmlPart === undefined ? null : tidy(await body(htmlPart))
      const plain = textPart === undefined ? '' : tidy(await body(textPart))
      const text = plain !== '' ? plain : html === null ? '' : stripHtml(html)
      const cut = truncateText(text, maxChars)
      const attachments: MailAttachmentInfo[] = parts
        .filter(p => p.isAttachment)
        .map((p, index) => ({ index, filename: p.filename ?? `part-${p.part}`, contentType: p.type, size: p.size, contentId: p.contentId }))
      return { ...summary, text: cut.text, html, attachments, truncated: cut.truncated }
    })
  }

  async search(account: MailAccount, password: string, options: MailSearchOptions): Promise<MailSearchResult> {
    const folder = options.folder ?? 'INBOX'
    const fields = options.fields !== undefined && options.fields.length > 0 ? options.fields : (['subject', 'from', 'to'] as MailSearchField[])
    const limit = clamp(options.limit, 1, MAX_LIMIT, 20)
    const headers = fields.filter(f => f !== 'body')
    const wantsBody = fields.includes('body')
    const query = options.query.trim()
    if (query === '') return { folder, source: 'server', scanned: 0, messages: [] }
    const since = options.since === undefined ? undefined : new Date(options.since)

    return await withMailbox(account, password, folder, 'read', async (client, exists) => {
      // 1) Ask the server. Its matching is coarse, so every hit is checked
      //    against the envelope we get back before it is believed.
      const canAsk = headers.length > 0 && !wantsBody
      if (canAsk) {
        const query_: Record<string, string | Date> = {}
        for (const field of headers) query_[field] = query
        if (since !== undefined) query_.since = since
        const found = await client.search(query_, { uid: true }).catch(() => false)
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, MAX_LIMIT * 4)
        if (uids.length > 0) {
          const rows = await client.fetchAll(uids, { uid: true, envelope: true, internalDate: true, flags: true, size: true, bodyStructure: true })
          const confirmed = rows
            .map(fetched => toSummary(fetched as Fetched, account.id, folder))
            .filter(m => matchesQuery(m, query, headers))
            .sort((a, b) => b.date - a.date)
          if (confirmed.length > 0) return { folder, source: 'server', scanned: uids.length, messages: confirmed.slice(0, limit) }
        }
      }

      // 2) Scan the newest headers ourselves.
      const scanned = Math.min(exists, MAX_SCAN)
      const from = Math.max(1, exists - scanned + 1)
      const rows = scanned === 0 ? [] : await client.fetchAll(`${from}:${exists}`, { uid: true, envelope: true, internalDate: true, flags: true, size: true, bodyStructure: true })
      const all = rows.map(fetched => toSummary(fetched as Fetched, account.id, folder))
      const byHeader = headers.length === 0 ? [] : all.filter(m => matchesQuery(m, query, headers))
      if (byHeader.length > 0 || !wantsBody) {
        return { folder, source: 'local-headers', scanned, messages: byHeader.sort((a, b) => b.date - a.date).slice(0, limit) }
      }

      // 3) Nothing in the headers: open a few bodies.
      const bodyLimit = clamp(options.bodyLimit, 1, 50, 10)
      const candidates = all.sort((a, b) => b.date - a.date).slice(0, bodyLimit)
      const needle = query.toLowerCase()
      const hits: MailSummary[] = []
      for (const candidate of candidates) {
        const parts = collectParts((await client.fetchOne(candidate.uid, { uid: true, bodyStructure: true }, { uid: true }) || {}).bodyStructure as Structure | undefined)
        const text = parts.find(p => p.type === 'text/plain' && !p.isAttachment) ?? parts.find(p => p.type === 'text/html' && !p.isAttachment)
        if (text === undefined) continue
        const got = await client.download(candidate.uid, text.part, { uid: true, maxBytes: BODY_BYTES })
        if (got.content === undefined) continue
        const raw = (await readStream(got.content, BODY_BYTES)).toString('utf8')
        const body = text.type === 'text/html' ? stripHtml(raw) : raw
        if (body.toLowerCase().includes(needle)) hits.push(candidate)
      }
      return { folder, source: 'local-body', scanned: candidates.length, messages: hits.slice(0, limit) }
    })
  }

  async mark(account: MailAccount, password: string, folder: string, uid: number, action: MailMarkAction, destination?: string): Promise<MailMarkResult> {
    return await withMailbox(account, password, folder, 'write', async client => {
      switch (action) {
        case 'read':
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
          return { uid, newUid: null, folder }
        case 'unread':
          await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true })
          return { uid, newUid: null, folder }
        case 'star':
          await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true })
          return { uid, newUid: null, folder }
        case 'unstar':
          await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true })
          return { uid, newUid: null, folder }
        case 'move': {
          if (destination === undefined || destination === '') throw new Error('move needs a destination folder')
          return { uid, newUid: await relocate(client, uid, destination), folder: destination }
        }
        case 'delete': {
          const trash = await trashPath(client)
          if (trash === folder) return { uid, newUid: null, folder }
          return { uid, newUid: await relocate(client, uid, trash), folder: trash }
        }
        case 'purge': {
          // Only inside Trash: this is the one action with no way back.
          const trash = await trashPath(client)
          if (trash !== folder) throw new Error('a message is only removed for good inside Trash')
          await client.messageDelete(uid, { uid: true })
          return { uid, newUid: null, folder }
        }
      }
    })
  }

  /**
   * The same actions over a batch. One folder lock for the whole batch, and a
   * message that vanished mid-way does not stop the rest — the caller gets a
   * row per uid and can say which ones were changed.
   */
  async markMany(account: MailAccount, password: string, folder: string, uids: number[], action: MailMarkAction, destination?: string): Promise<MailMarkResult[]> {
    return await withMailbox(account, password, folder, 'write', async client => {
      const results: MailMarkResult[] = []
      const flag = action === 'read' || action === 'unread' ? '\\Seen' : action === 'star' || action === 'unstar' ? '\\Flagged' : undefined
      if (flag !== undefined) {
        const add = action === 'read' || action === 'star'
        for (const uid of uids) {
          try {
            if (add) await client.messageFlagsAdd(uid, [flag], { uid: true })
            else await client.messageFlagsRemove(uid, [flag], { uid: true })
            results.push({ uid, newUid: null, folder })
          } catch {
            results.push({ uid, newUid: null, folder })
          }
        }
        return results
      }
      const target = action === 'delete' ? await trashPath(client) : destination
      if (target === undefined || target === '') throw new Error(`${action} needs a destination folder`)
      for (const uid of uids) {
        if (action === 'purge') {
          await client.messageDelete(uid, { uid: true })
          results.push({ uid, newUid: null, folder })
          continue
        }
        if (target === folder) {
          results.push({ uid, newUid: null, folder })
          continue
        }
        results.push({ uid, newUid: await relocate(client, uid, target), folder: target })
      }
      return results
    })
  }

  async folders(account: MailAccount, password: string): Promise<MailFolder[]> {
    return await withClient(account, password, async client => {
      const rows = await client.list({ statusQuery: { messages: true, unseen: true } }).catch(async () => await client.list())
      return rows.map(row => {
        const status = 'status' in row ? row.status : undefined
        const folder: MailFolder = {
          path: row.path,
          name: row.name,
          delimiter: row.delimiter,
          specialUse: row.specialUse ?? null,
          flags: [...row.flags],
        }
        if (status?.messages !== undefined) folder.messages = status.messages
        if (status?.unseen !== undefined) folder.unread = status.unseen
        return folder
      })
    })
  }

  async createFolder(account: MailAccount, password: string, path: string): Promise<void> {
    await withClient(account, password, async client => {
      await client.mailboxCreate(path)
    })
  }

  async renameFolder(account: MailAccount, password: string, from: string, to: string): Promise<void> {
    await withClient(account, password, async client => {
      await client.mailboxRename(from, to)
    })
  }

  async deleteFolder(account: MailAccount, password: string, path: string): Promise<void> {
    await withClient(account, password, async client => {
      await client.mailboxDelete(path)
    })
  }

  async attachment(account: MailAccount, password: string, folder: string, uid: number, index: number, maxBytes: number): Promise<MailAttachment> {
    return await withMailbox(account, password, folder, 'read', async client => {
      const fetched = await client.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true })
      if (fetched === false || fetched === undefined) throw new Error(`message ${uid} is not in ${folder}`)
      const parts = collectParts(fetched.bodyStructure as Structure | undefined).filter(p => p.isAttachment)
      const part = parts[index]
      if (part === undefined) throw new Error(`message ${uid} has ${parts.length} attachments, not #${index + 1}`)
      if (part.size > maxBytes) throw new Error(`attachment is ${part.size} bytes, over the ${maxBytes} limit`)
      const got = await client.download(uid, part.part, { uid: true, maxBytes })
      if (got.content === undefined) throw new Error(`attachment #${index + 1} could not be downloaded`)
      const content = await readStream(got.content, maxBytes)
      return {
        filename: part.filename ?? `part-${part.part}`,
        contentType: got.meta?.contentType ?? part.type,
        content,
      }
    })
  }
}
