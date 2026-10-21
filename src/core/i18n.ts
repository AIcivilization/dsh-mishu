/**
 * Two languages, chosen at display time.
 *
 * Text the secretary writes (GitHub matter titles and notes) is stored in
 * both languages, so switching the language later re-renders old matters
 * too. Text you wrote (what you told it) is stored as you wrote it.
 */

export type Lang = 'zh' | 'en'

export const LANGS: readonly Lang[] = ['zh', 'en']

/** A sentence in both languages. */
export interface Bi {
  zh: string
  en: string
}

export function bi(zh: string, en: string): Bi {
  return { zh, en }
}

export function pick(text: Bi, lang: Lang): string {
  return text[lang]
}

/** Join pieces of the same sentence in both languages. */
export function join(parts: readonly Bi[], separator: Bi = bi('', '')): Bi {
  return { zh: parts.map(p => p.zh).join(separator.zh), en: parts.map(p => p.en).join(separator.en) }
}

const MARK = '{"zh":'

/** Store a sentence: bilingual text as JSON, your own text as is. */
export function encode(text: Bi | string): string {
  if (typeof text === 'string') return text
  return text.zh === text.en ? text.zh : JSON.stringify({ zh: text.zh, en: text.en })
}

/** Read a stored sentence in `lang`. */
export function decode(stored: string, lang: Lang): string
export function decode(stored: string | null, lang: Lang): string | null
export function decode(stored: string | null, lang: Lang): string | null {
  if (stored === null || !stored.startsWith(MARK)) return stored
  try {
    const text = JSON.parse(stored) as Partial<Bi>
    return typeof text.zh === 'string' && typeof text.en === 'string' ? (text as Bi)[lang] : stored
  } catch {
    return stored
  }
}

/** `zh` for Chinese locales, otherwise `en`. With no locale, the system's. */
export function detectLang(locale?: string): Lang {
  const value = (locale ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase()
  return value.startsWith('zh') ? 'zh' : 'en'
}

/** An error that can explain itself in either language; `message` is English. */
export class MishuError extends Error {
  readonly text: Bi

  constructor(text: Bi) {
    super(text.en)
    this.text = text
  }
}

export function errorText(error: unknown, lang: Lang): string {
  if (error instanceof MishuError) return pick(error.text, lang)
  return error instanceof Error ? error.message : String(error)
}
