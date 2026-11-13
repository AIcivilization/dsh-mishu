/**
 * Turning what a server hands us into text a person can read.
 *
 * Two jobs: make an HTML body into plain text that keeps its paragraph
 * breaks, and make a filename safe to write to disk. Neither ever runs on
 * anything but a message's own content.
 */

/** Tags whose content is never shown (they are code or metadata, not text). */
const INVISIBLE = /<(script|style|head|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi
/** Tags that end a line. */
const BLOCK = /<\/?(p|div|section|article|header|footer|blockquote|pre|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|h[1-6]|hr|br)\b[^>]*>/gi

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', times: '×', divide: '÷',
  laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number(body.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** An HTML body as plain text: no tags, paragraph breaks kept, runs of blank lines squeezed. */
export function stripHtml(html: string): string {
  const withoutInvisible = html.replace(INVISIBLE, ' ')
  const withBreaks = withoutInvisible.replace(BLOCK, '\n').replace(/<[^>]*>/g, ' ')
  return tidy(decodeEntities(withBreaks))
}

/** Collapse spaces, keep paragraph breaks, drop leading and trailing blank lines. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Cut text to `maxChars` without splitting a character, and say how much was
 * left out. Long words with no space to break at are cut anyway: a body is
 * worth reading even when its middle is missing.
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const head = text.slice(0, maxChars)
  const cut = head.lastIndexOf('\n')
  const kept = cut > maxChars * 0.6 ? head.slice(0, cut) : head
  return { text: `${kept}\n…[正文过长，已截断，共 ${text.length} 字]…[truncated: ${text.length} characters in all]`, truncated: true }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * A filename that is safe everywhere: no directories, no control characters,
 * no Windows device names, and short enough for every filesystem.
 */
export function sanitizeFilename(raw: string, fallback = 'attachment.bin'): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (cleaned === '') return fallback
  const safe = RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
  if (safe.length <= 120) return safe
  const dot = safe.lastIndexOf('.')
  const ext = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : ''
  return `${safe.slice(0, 120 - ext.length)}${ext}`
}

/** A filename nobody else in `taken` has: "report.pdf", "report (2).pdf", … */
export function uniqueFilename(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 1000; n++) {
    const next = `${stem} (${n})${ext}`
    if (!taken.has(next.toLowerCase())) return next
  }
  return `${stem}-${Date.now()}${ext}`
}

/** The first `n` characters of a subject, for a title that has to stay short. */
export function shortSubject(subject: string, n = 80): string {
  const clean = subject.replace(/\s+/g, ' ').trim()
  if (clean === '') return '（无标题）'
  return clean.length <= n ? clean : `${clean.slice(0, n - 1)}…`
}
