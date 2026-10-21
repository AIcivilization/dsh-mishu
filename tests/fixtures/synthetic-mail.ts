/**
 * A made-up mailbox for the committed tests. Every address, name and subject
 * is invented (example.com / example.org / *.example). It covers each mail
 * rule: mail written to you (and a reply in the same thread), a newsletter,
 * automated mail, a verification code, GitHub notification mail, an
 * invitation, bills in English and Chinese, and mail you are only copied on.
 */

import type { MailAccount, MailMessage } from '../../src/core/mail/account.ts'

/** 2026-10-21 09:00 in Asia/Shanghai. */
export const MAIL_NOW = Date.UTC(2026, 9, 21, 1, 0)

export const ACCOUNT: MailAccount = {
  id: 1, label: '工作邮箱', address: 'me@example.com', preset: 'gmail', host: 'imap.gmail.com', port: 993, secure: true,
  user: 'me@example.com', enabled: true, sinceDays: 14,
}

const hoursAgo = (h: number) => MAIL_NOW - h * 3_600_000
const me = { name: 'Me', address: 'me@example.com' }
let uid = 100

function mail(partial: Partial<MailMessage> & { subject: string; from: MailMessage['from'] }): MailMessage {
  uid++
  const messageId = partial.messageId ?? `<m${uid}@mail.example>`
  return {
    id: `mail:1:${uid}`, uid, messageId, threadRoot: partial.threadRoot ?? messageId, date: hoursAgo(2),
    to: [me], cc: [], listId: null, listUnsubscribe: null, autoSubmitted: null, precedence: null, hasCalendar: false,
    ...partial,
  }
}

const alice = { name: 'Alice Example', address: 'alice@example.org' }

export const CONTRACT = mail({ subject: 'Contract draft', from: alice, messageId: '<contract@example.org>', date: hoursAgo(30) })
export const CONTRACT_REPLY = mail({ subject: 'Re: Contract draft', from: alice, threadRoot: '<contract@example.org>', date: hoursAgo(5) })
export const NEWSLETTER = mail({ subject: 'Weekly digest', from: { name: 'News', address: 'news@letters.example' }, listUnsubscribe: '<https://letters.example/unsub>', listId: '<weekly.letters.example>' })
export const SHIPPED = mail({ subject: 'Your order has shipped', from: { name: 'Shop', address: 'no-reply@shop.example' } })
export const CODE = mail({ subject: 'Your verification code is 482913', from: { name: 'Login', address: 'security@accounts.example' } })
export const GITHUB = mail({ subject: '[example-org/demo-lib] CI failed', from: { name: 'GitHub', address: 'notifications@github.com' }, listId: '<demo-lib.example-org.github.com>' })
export const INVITE = mail({ subject: 'Invitation: Weekly sync @ Thu 10:00', from: { name: 'Bob Example', address: 'bob@example.org' }, hasCalendar: true })
export const BILL = mail({ subject: 'Your October bill is ready', from: { name: 'Telecom', address: 'billing@telecom.example' }, listUnsubscribe: '<https://telecom.example/unsub>' })
export const BILL_ZH = mail({ subject: '您的信用卡账单已出', from: { name: '示例银行', address: 'service@bank.example' }, autoSubmitted: 'auto-generated' })
export const CC_ONLY = mail({ subject: 'Team lunch plan', from: { name: 'Bob Example', address: 'bob@example.org' }, to: [{ name: 'Carol', address: 'carol@example.org' }], cc: [me] })

export const INBOX: MailMessage[] = [CONTRACT, CONTRACT_REPLY, NEWSLETTER, SHIPPED, CODE, GITHUB, INVITE, BILL, BILL_ZH, CC_ONLY]
