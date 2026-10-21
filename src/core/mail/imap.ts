/**
 * Unread mail over IMAP, read-only.
 *
 * INBOX is opened with EXAMINE (`readOnly: true`), so looking never marks
 * anything read. Only the envelope, flags, structure and five headers are
 * fetched — never a message body.
 */

import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import type { MailAccount, MailAddress, MailFetcher, MailMessage } from './account.ts'

const HEADERS = ['list-id', 'list-unsubscribe', 'auto-submitted', 'precedence', 'references']
/** Newest unread messages looked at per sync. */
const MAX_MESSAGES = 200

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

interface Structure { type?: string; childNodes?: Structure[] }

function hasCalendarPart(node: Structure | undefined): boolean {
  if (node === undefined) return false
  if (node.type?.toLowerCase() === 'text/calendar') return true
  return (node.childNodes ?? []).some(hasCalendarPart)
}

const toAddress = (a: { name?: string; address?: string }): MailAddress => ({ name: a.name ?? '', address: (a.address ?? '').toLowerCase() })

/** Build the rules' view of one fetched message. */
export function toMailMessage(fetched: {
  uid: number
  envelope?: { date?: Date | string; subject?: string; messageId?: string; inReplyTo?: string; from?: Array<{ name?: string; address?: string }>; to?: Array<{ name?: string; address?: string }>; cc?: Array<{ name?: string; address?: string }> }
  internalDate?: Date | string
  headers?: Buffer
  bodyStructure?: Structure
}, accountId: number): MailMessage {
  const env = fetched.envelope ?? {}
  const headers = parseHeaders(fetched.headers?.toString('utf8') ?? '')
  const references = (headers.get('references') ?? '').split(/\s+/).filter(Boolean)
  const messageId = env.messageId ?? null
  const threadRoot = references[0] ?? env.inReplyTo ?? messageId ?? `uid:${fetched.uid}`
  const when = env.date ?? fetched.internalDate
  return {
    id: `mail:${accountId}:${hashId(messageId ?? `uid:${fetched.uid}`)}`,
    uid: fetched.uid,
    messageId,
    threadRoot,
    subject: env.subject ?? '',
    date: when === undefined ? 0 : new Date(when).getTime(),
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

export class ImapFetcher implements MailFetcher {
  async unread(account: MailAccount, password: string, sinceDays: number, now: number): Promise<MailMessage[]> {
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
    try {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true, description: 'dsh-mishu read-only' })
      try {
        const since = new Date(now - sinceDays * 86_400_000)
        const found = await client.search({ seen: false, since }, { uid: true })
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, MAX_MESSAGES)
        if (uids.length === 0) return []
        const messages: MailMessage[] = []
        for await (const fetched of client.fetch(uids, { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: HEADERS }, { uid: true })) {
          messages.push(toMailMessage(fetched as Parameters<typeof toMailMessage>[0], account.id))
        }
        return messages
      } finally {
        lock.release()
      }
    } finally {
      await client.logout().catch(() => client.close())
    }
  }
}
