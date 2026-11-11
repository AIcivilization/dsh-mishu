/**
 * Reading a watched address: a feed, a JSON list, or just a page.
 *
 * Whatever comes back is turned into a handful of items — a title, a bit of
 * text and a stable key — so the rest of the code never has to care whether
 * it was RSS, Atom, JSON or plain HTML. No parser library: the shapes that
 * matter here are small, and a wrong guess costs nothing (the page is read
 * as text and still works).
 */

import { createHash } from 'node:crypto'
import { bi, type Bi } from '../i18n.ts'
import { entryKey, type WatchSource } from './source.ts'

export interface WatchItem {
  /** Stable across checks: the same entry twice is the same item. */
  key: string
  title: string
  /** The text to look for keywords in, and to quote back. */
  text: string
  url: string | null
  /** When the source says it happened; the fetch time when it does not. */
  at: number
}

export interface WatchFetch {
  (url: string): Promise<{ status: number; body: string; contentType: string }>
}

/** The real fetch: a plain GET with a short timeout and no cookies. */
export const httpFetch: WatchFetch = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'dsh-mishu/1 (+https://github.com/AIcivilization/dsh-mishu)',
        accept: 'application/rss+xml, application/atom+xml, application/json, text/html;q=0.9, */*;q=0.8',
      },
    })
    const body = await response.text()
    return { status: response.status, body, contentType: response.headers.get('content-type') ?? '' }
  } finally {
    clearTimeout(timer)
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function unescape(text: string): string {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#')) {
        const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
      }
      return ENTITIES[name.toLowerCase()] ?? whole
    })
}

/** Markup out, whitespace collapsed. */
export function plainText(markup: string): string {
  return unescape(markup
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  if (match === null) return undefined
  const inner = match[1]!
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner)
  return plainText(cdata === null ? inner : cdata[1]!)
}

function attr(block: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(block)
  return match === null ? undefined : unescape(match[1]!)
}

/** RSS `<item>` and Atom `<entry>` blocks, whichever the document has. */
export function parseFeed(body: string, now: number, base: string): WatchItem[] | undefined {
  const blocks = [...body.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0])
  if (blocks.length === 0) return undefined
  return blocks.map((block) => {
    const title = tag(block, 'title') ?? ''
    const link = tag(block, 'link') ?? ((): string | undefined => {
      const href = attr(block, 'href')
      return href === undefined ? undefined : href
    })()
    const bodyText = tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content') ?? ''
    const guid = tag(block, 'guid') ?? tag(block, 'id')
    const when = tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published') ?? tag(block, 'dc:date')
    const at = when === undefined ? now : Date.parse(when)
    const href = link === undefined ? null : absolute(link, base)
    return {
      key: entryKey({ id: guid ?? href ?? undefined, link: href ?? undefined, title }),
      title: title === '' ? (href ?? '?') : title,
      text: bodyText,
      url: href,
      at: Number.isFinite(at) ? at : now,
    }
  })
}

function absolute(link: string, base: string): string {
  try {
    return new URL(link, base).toString()
  } catch {
    return link
  }
}

/**
 * A JSON body: an array of objects, or an object with one array inside. Each
 * element's title-like and text-like fields become an item.
 */
export function parseJson(body: string, now: number, base: string): WatchItem[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  const list = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined
  if (list === undefined || list.length === 0) return undefined
  const str = (item: Record<string, unknown>, names: string[]): string | undefined => {
    for (const name of names) {
      const found = item[name]
      if (typeof found === 'string' && found.trim() !== '') return found
      if (typeof found === 'number') return String(found)
    }
    return undefined
  }
  return list.slice(0, 60).map((raw) => {
    if (typeof raw !== 'object' || raw === null) return { key: entryKey({ title: String(raw) }), title: String(raw), text: '', url: null, at: now }
    const item = raw as Record<string, unknown>
    const title = str(item, ['title', 'name', 'subject', 'headline', 'version', 'label']) ?? JSON.stringify(item).slice(0, 120)
    const text = str(item, ['description', 'body', 'content', 'summary', 'text', 'excerpt', 'details']) ?? ''
    const link = str(item, ['url', 'link', 'html_url', 'permalink', 'href'])
    const when = str(item, ['date', 'published', 'updated', 'pubDate', 'created_at', 'time', 'timestamp'])
    const at = when === undefined ? now : Date.parse(when)
    const href = link === undefined ? null : absolute(link, base)
    return {
      key: entryKey({ id: str(item, ['id', 'guid', 'uuid', 'key']) ?? href ?? undefined, link: href ?? undefined, title }),
      title, text, url: href, at: Number.isFinite(at) ? at : now,
    }
  })
}

/** A page with no feed: its title and text, as one item keyed by a hash of the text. */
export function parsePage(body: string, now: number, base: string): WatchItem[] {
  const title = plainText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '') || new URL(base).hostname
  const text = plainText(/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body).slice(0, 20_000)
  const key = createHash('sha256').update(text).digest('hex').slice(0, 16)
  return [{ key, title, text, url: base, at: now }]
}

/** Whatever the address returned, as items. */
export function readWatchBody(options: { body: string; contentType: string; url: string; now: number }): WatchItem[] {
  const { body, contentType, url, now } = options
  const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(body)
  const looksFeed = /xml|rss|atom/i.test(contentType) || /<(rss|feed)\b/i.test(body)
  if (looksFeed || (!looksJson && /<(item|entry)\b/i.test(body))) return parseFeed(body, now, url) ?? parsePage(body, now, url)
  if (looksJson) return parseJson(body, now, url) ?? parsePage(body, now, url)
  return parsePage(body, now, url)
}

/** The sentence shown when a watch cannot be read. */
export function describeWatchError(error: unknown, source: WatchSource): Bi {
  const raw = (error as Error).message ?? String(error)
  if (/abort/i.test(raw)) return bi(`${source.label} 20 秒没有回应，可能是网站太慢或打不开。`, `${source.label} did not answer within 20 seconds; the site may be slow or down.`)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return bi(`${source.label} 的网址找不到服务器：检查一下网址有没有写错。`, `The server for ${source.label} was not found: check the address.`)
  if (/certificate|self.signed|SSL|TLS/i.test(raw)) return bi(`${source.label} 的证书有问题，读不了。`, `${source.label} has a certificate problem and could not be read.`)
  return bi(`读 ${source.label} 失败：${raw}`, `Could not read ${source.label}: ${raw}`)
}
