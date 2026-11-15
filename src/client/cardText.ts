/**
 * One unfolded card as plain text, for the "copy" button.
 *
 * What the card shows on screen is what gets copied: the title, when it is
 * due, what it is, where the problem is, what to do, what the secretary did,
 * and the notifications behind it. No markup, no hidden state — the text is
 * what you would have typed out yourself, so it can go into a chat, an email
 * or a note as it stands.
 */

import type { BoardCard, MatterDetail } from '../core/board.ts'
import { TEXT, type UiLang } from './text.ts'

/** Which column a card sits in; "done for you" cards tell the shorter story. */
export type CardColumn = 'handle' | 'remember' | 'done'

export function cardText(item: BoardCard, detail: MatterDetail | undefined, column: CardColumn, lang: UiLang): string {
  const t = TEXT[lang]
  const sep = lang === 'zh' ? '：' : ': '
  // Section headers are labels on their own line, so they take a bare colon.
  const colon = lang === 'zh' ? '：' : ':'
  const out: string[] = [item.title]
  if (item.meta !== '') out.push(item.meta)

  const line = (label: string, value: string | null | undefined): void => {
    if (value === null || value === undefined || value === '') return
    out.push(`${label}${sep}${value}`)
  }
  const blank = (): void => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
  }

  const compact = column === 'done'
  // "Done for you" cards take their explanation from the detail (the board's
  // copy is trimmed to the closure), everything else from the card itself. If
  // the detail has not arrived yet, the card's own copy still tells the story.
  const explain = compact ? (detail?.explain ?? item.explain) : item.explain
  if (explain !== null) {
    blank()
    line(t.what, explain.what)
    line(compact ? t.whyDone : column === 'remember' ? t.whyKeep : t.why, explain.why)
    // A closed card has nothing left to do, so "what to do" is left out even
    // when the stored explanation still carries one.
    if (!compact) line(t.fix, explain.fix)
    line(t.linkLabel, explain.link?.url ?? item.url)
  } else {
    if (item.note !== null) {
      blank()
      line(t.addNote, item.note)
    } else if (item.url !== null) {
      blank()
      line(t.linkLabel, item.url)
    }
  }

  if (detail !== undefined) {
    if (detail.did.length > 0) {
      blank()
      out.push(`${t.did}${colon}`)
      for (const text of detail.did) out.push(`- ${text}`)
    }
    if (detail.messages.length > 0) {
      blank()
      out.push(`${t.messages(detail.messages.length)}${colon}`)
      for (const message of detail.messages) out.push(`- ${message.at} ${message.title}`)
    }
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
