/**
 * Mail rules: from an unread message's envelope and headers to a verdict.
 *
 * No body is read. Mailing lists, automated mail, verification codes and
 * GitHub's own notification mail are folded away; invitations, bills and
 * mail written directly to you stay on the list. Nothing here ever changes
 * the mailbox: the verdict only decides what the secretary shows you.
 */

import { bi, type Bi } from '../i18n.ts'
import { shortDay } from '../time.ts'
import type { Verdict } from '../github/rules.ts'
import { hashId } from './imap.ts'
import { presetById, type MailAccount, type MailAddress, type MailMessage } from './account.ts'

export const MAIL_CLOSING_REASONS = ['mail-github', 'mail-code', 'mail-newsletter', 'mail-automated', 'mail-cc'] as const

const NO_REPLY = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce)([._+-]|@)/i
const CODE = /(验证码|校验码|动态码|动态密码|verification code|security code|one[- ]time (pass)?code|\bOTP\b|login code|sign-?in code)/i
const INVITE = /^(邀请|会议邀请|日程邀请|更新的邀请|Invitation:|Updated invitation|Invitation from)/i
const BILL = /(账单|还款|缴费|欠费|待支付|扣款|续费|发票|invoice|\bbill\b|payment (due|reminder)|statement|receipt|renewal)/i

function cleanSubject(subject: string): string {
  return subject.replace(/^\s*((re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i, '').trim() || '（无标题）'
}

function who(a: MailAddress | null): string {
  if (a === null) return '?'
  return a.name !== '' ? `${a.name} <${a.address}>` : a.address
}

export function judgeMail(m: MailMessage, account: MailAccount): Verdict {
  const subject = cleanSubject(m.subject)
  const from = who(m.from)
  const sender = m.from?.address ?? ''
  const me = account.address
  const day = m.date > 0 ? shortDay(m.date) : '?'
  const base = {
    matterKey: `mail:${account.id}:${hashId(m.threadRoot)}`,
    kind: 'mail',
    title: `${subject}`,
    url: m.messageId === null ? null : presetById(account.preset).findMessage?.(m.messageId) ?? null,
  }
  const what = bi(`${account.label} 收到 ${from} 在 ${day} 发来的邮件：「${subject}」`, `Mail to ${account.label} from ${from} on ${day}: "${subject}"`)
  const link = base.url === null ? undefined : { label: bi('打开邮件', 'Open the mail'), url: base.url }
  const done = (reason: string, why: Bi): Verdict => ({ ...base, status: 'done', reason, note: why, explain: { what, why, fix: null, ...link === undefined ? {} : { link } } })
  const open = (reason: string, why: Bi, fix: Bi): Verdict => ({ ...base, status: 'open', reason, note: why, explain: { what, why, fix, ...link === undefined ? {} : { link } } })

  if (/@(github\.com|noreply\.github\.com)$/.test(sender) && /^(notifications|noreply)@/.test(sender) || sender.endsWith('@noreply.github.com')) {
    return done('mail-github', bi('这是 GitHub 发的通知邮件；同样的事 GitHub 来源已经在管，不用在邮件里再处理一遍。', 'This is GitHub notification mail; the GitHub source already tracks the same thing.'))
  }
  if (CODE.test(m.subject)) {
    return done('mail-code', bi('这是验证码一类的邮件，几分钟后就没用了。', 'This is a verification code; it is useless after a few minutes.'))
  }
  if (m.hasCalendar || INVITE.test(m.subject)) {
    return open('mail-invite',
      bi('这是一封会议或日程邀请，对方在等你回应。', 'This is a meeting or calendar invitation; someone is waiting for your answer.'),
      bi('打开邮件选「接受」或「拒绝」；回应后点"办完了"。', 'Open it and accept or decline; then mark this done.'))
  }
  const billWord = BILL.exec(m.subject)?.[0]
  if (billWord !== undefined) {
    return open('mail-bill',
      bi(`标题里有「${billWord}」，看起来是账单、缴费或续费提醒。`, `The subject says "${billWord}"; it looks like a bill, payment or renewal notice.`),
      bi('打开看金额和截止日期；想到期前被提醒，就在"我记着"里交代一件事。办完后点"办完了"。', 'Open it for the amount and the due date; to be reminded before it is due, add it under "Keeping for you". Mark this done afterwards.'))
  }
  const bulk = m.listId !== null || m.listUnsubscribe !== null || /^(bulk|list|junk)$/i.test(m.precedence ?? '')
  if (bulk) {
    return done('mail-newsletter', bi('这是群发邮件（带退订链接或邮件列表标记），不是专门写给你的。', 'This is bulk mail (it carries an unsubscribe link or a mailing-list header), not written to you.'))
  }
  const automated = (m.autoSubmitted !== null && m.autoSubmitted.toLowerCase() !== 'no') || NO_REPLY.test(sender)
  if (automated) {
    return done('mail-automated', bi('这是系统自动发的邮件（自动发送标记或 noreply 发件人），没有人在等你回复。', 'This is automated mail (an auto-submitted header or a no-reply sender); nobody is waiting for your reply.'))
  }
  const inTo = m.to.some(a => a.address === me)
  const inCc = m.cc.some(a => a.address === me)
  if (!inTo && inCc) {
    return done('mail-cc', bi('你只在抄送里，主要是让你知道一下。', 'You are only in Cc; it is mostly for your information.'))
  }
  return open('mail-to-you',
    bi(`${from} 直接写给你的邮件，没有群发或自动发送的标记，可能在等你回复。`, `${from} wrote to you directly (no bulk or automated markers); they may be waiting for a reply.`),
    bi('需要回复就回复；只是让你知道一下的话，点"办完了"。', 'Reply if it needs one; if it is just for your information, mark it done.'))
}
