/**
 * Folder names, checked before anything is created, renamed or deleted.
 *
 * A mailbox's own folders — Inbox, Sent, Drafts, Trash, Junk — are not the
 * secretary's to organise: renaming Sent breaks every "sent mail" view the
 * provider has, and deleting Trash is never what the person meant. So a
 * mutation only ever touches a folder that is plainly someone's own label.
 */

import { bi, MishuError } from '../i18n.ts'
import type { MailFolder } from './account.ts'

/** Longer than any real folder path; refused before it reaches the server. */
const MAX_PATH = 1024

/** Names mail servers give their own folders, in the languages we ship. */
const SYSTEM_NAME = /^(inbox|sent|sent items|sent messages|drafts?|trash|deleted items|deleted messages|junk|junk e-?mail|spam|bulk mail|all mail|archive|archives?|outbox|收件箱|已发送|已发送邮件|草稿|草稿箱|已删除|已删除邮件|垃圾邮件|垃圾箱|废纸篓|回收站|归档)$/i

/** What is wrong with a folder path, if anything. */
export function folderPath(value: unknown): string {
  const path = String(value ?? '').trim()
  if (path === '') throw new MishuError(bi('要填文件夹名', 'say which folder'))
  if (path.length > MAX_PATH) throw new MishuError(bi(`文件夹名太长了（${path.length} 个字符）`, `that folder path is too long (${path.length} characters)`))
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new MishuError(bi('文件夹名里有控制字符', 'the folder path has control characters in it'))
  if (path.startsWith('/') || path.endsWith('/')) throw new MishuError(bi('文件夹名不能以 / 开头或结尾', 'a folder path cannot start or end with /'))
  if (path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new MishuError(bi('文件夹名里有空的或 . / .. 这一层', 'the folder path has an empty, . or .. segment'))
  }
  return path
}

/** Whether this is one of the mailbox's own folders, by name or by what the server says it is. */
export function isSystemFolder(path: string, rows: readonly MailFolder[] = []): boolean {
  const row = rows.find(item => item.path === path || item.path.toLowerCase() === path.toLowerCase())
  if (row !== undefined && row.specialUse !== null) return true
  const leaf = path.split('/').pop() ?? path
  return SYSTEM_NAME.test(leaf.trim())
}

/**
 * Refuse to create, rename or delete a folder the mailbox owns. `action` is
 * only used for the sentence, so the same rule reads right in all three.
 */
export function assertCustomFolder(path: string, rows: readonly MailFolder[] = [], action: 'create' | 'rename' | 'delete' = 'create'): void {
  if (!isSystemFolder(path, rows)) return
  throw new MishuError(bi(
    `「${path}」是邮箱自己的文件夹，小秘书只${action === 'delete' ? '删' : '动'}你自己建的。`,
    `"${path}" is one of the mailbox's own folders; the secretary only touches labels you made.`,
  ))
}
