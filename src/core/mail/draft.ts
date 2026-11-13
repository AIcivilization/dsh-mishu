/**
 * Drafts: the mail you are still writing.
 *
 * A draft lives in the notebook (SQLite), not in the mailbox, so it survives
 * a restart and never shows up in your Sent folder until it is actually sent.
 * Every save names the revision it started from, so two windows cannot
 * silently overwrite each other.
 */

import { randomUUID } from 'node:crypto'
import { bi, MishuError } from '../i18n.ts'
import type { Draft, DraftPatch, MishuStore, NewDraft } from '../store.ts'
import type { MailAccount } from './account.ts'
import type { MailCompose } from './send.ts'

/** How many unsent drafts one account may keep. */
export const MAX_DRAFTS = 50

/** The compose fields a draft carries, in the order the editor shows them. */
export const DRAFT_FIELDS = ['to', 'cc', 'bcc', 'subject', 'text', 'html', 'attachments'] as const

/** A draft as the editor and the tools see it. */
export interface DraftView extends Draft {
  /** The account's address, so the editor can say who it is from. */
  from: string
}

export function draftView(draft: Draft, account: MailAccount): DraftView {
  return { ...draft, from: account.address }
}

/** A new draft; the caller supplies the id so tests are deterministic. */
export function newDraft(account: MailAccount, input: Partial<MailCompose> & { reply?: NewDraft['reply'] }, id: string = randomUUID()): NewDraft {
  return {
    id,
    account: account.id,
    to: input.to ?? '',
    cc: input.cc ?? '',
    bcc: input.bcc ?? '',
    subject: input.subject ?? '',
    text: input.text ?? '',
    html: input.html ?? null,
    attachments: input.attachments ?? [],
    reply: input.reply ?? null,
  }
}

/** Save a new draft, refusing once the account has too many unsent ones. */
export function saveDraft(store: MishuStore, account: MailAccount, input: Partial<MailCompose> & { reply?: NewDraft['reply'] }, now: number, id?: string): Draft {
  const open = store.drafts(account.id, 'draft')
  if (open.length >= MAX_DRAFTS) {
    throw new MishuError(bi(
      `草稿箱里有 ${open.length} 封还没发的信了，先发掉或删掉几封再存。`,
      `there are already ${open.length} unsent drafts; send or delete a few before saving another.`,
    ))
  }
  return store.insertDraft(newDraft(account, input, id), now)
}

/**
 * Edit a draft at `revision`. A save from a window that is behind is refused
 * with the current draft attached, so the editor can show what changed
 * instead of losing it.
 */
export function editDraft(store: MishuStore, account: MailAccount, id: string, revision: number, patch: DraftPatch, now: number): Draft {
  const current = store.draftById(id)
  if (current === undefined || current.account !== account.id) throw new MishuError(bi('这封草稿已经不在了', 'this draft is gone'))
  if (current.state === 'sent') throw new MishuError(bi('这封草稿已经发出去了', 'this draft has already been sent'))
  if (current.revision !== revision) {
    throw new MishuError(bi(
      `这封草稿在别处改过了（现在是第 ${current.revision} 版，你改的是第 ${revision} 版），先刷新再改。`,
      `this draft changed elsewhere (it is at revision ${current.revision}, you edited revision ${revision}); refresh before editing.`,
    ))
  }
  const next = store.updateDraft(id, revision, patch, now)
  if (next === undefined) throw new MishuError(bi('这封草稿在别处改过了，先刷新再改。', 'this draft changed elsewhere; refresh before editing.'))
  return next
}

/** Take a draft for sending: it must be the revision the sender saw, and unsent. */
export function claimDraft(store: MishuStore, account: MailAccount, id: string, revision: number, now: number): Draft {
  const current = store.draftById(id)
  if (current === undefined || current.account !== account.id) throw new MishuError(bi('这封草稿已经不在了', 'this draft is gone'))
  // A scheduled draft has its own way out (it goes when its time comes, or
  // after the schedule is cancelled), so the plain send must not take it.
  if (current.state === 'scheduled') {
    throw new MishuError(bi('这封草稿定过时，要先取消定时才能现在发。', 'this draft is scheduled; cancel the schedule to send it now.'))
  }
  if (current.state !== 'draft') throw new MishuError(bi('这封草稿已经发过了', 'this draft has already been sent'))
  if (current.revision !== revision) throw new MishuError(bi('这封草稿刚被改过，先看看再发。', 'this draft was just edited; look at it before sending.'))
  const claimed = store.updateDraft(id, revision, { state: 'sending' }, now)
  if (claimed === undefined) throw new MishuError(bi('这封草稿刚被改过，先看看再发。', 'this draft was just edited; look at it before sending.'))
  return claimed
}

/** The draft as something `prepareMail` can check. */
export function draftToCompose(draft: Draft): MailCompose {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
    html: draft.html ?? undefined,
    attachments: draft.attachments,
  }
}
