/**
 * Mail accounts and the providers we know how to reach.
 *
 * An account here is only where and who: host, port, address, user name.
 * The password (an app password or 授权码 for most providers) lives in the
 * system keychain under `mail:<id>`, never in the notebook.
 */

import { bi, MishuError, type Bi } from '../i18n.ts'

export interface MailPreset {
  id: string
  label: Bi
  host: string
  port: number
  secure: boolean
  /** False when the provider no longer allows password logins over IMAP. */
  supported: boolean
  /** Where to get the password this provider expects. */
  howTo: Bi
  /** A web link that finds one message by Message-ID, when the provider has one. */
  findMessage?: (messageId: string) => string
}

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'qq', label: bi('QQ 邮箱', 'QQ Mail'), host: 'imap.qq.com', port: 993, secure: true, supported: true,
    howTo: bi('在 QQ 邮箱网页版：设置 → 账号 → 开启「IMAP/SMTP 服务」，按提示生成授权码。这里填授权码，不是 QQ 密码。', 'In QQ Mail on the web: Settings → Account → turn on "IMAP/SMTP" and generate an authorization code. Enter that code here, not your QQ password.'),
  },
  {
    id: '163', label: bi('网易 163 邮箱', 'NetEase 163'), host: 'imap.163.com', port: 993, secure: true, supported: true,
    howTo: bi('在 163 邮箱网页版：设置 → POP3/SMTP/IMAP → 开启 IMAP 服务，设置客户端授权码。这里填授权码。', 'In 163 Mail on the web: Settings → POP3/SMTP/IMAP → turn on IMAP and set a client authorization code. Enter that code here.'),
  },
  {
    id: '126', label: bi('网易 126 邮箱', 'NetEase 126'), host: 'imap.126.com', port: 993, secure: true, supported: true,
    howTo: bi('在 126 邮箱网页版：设置 → POP3/SMTP/IMAP → 开启 IMAP 服务，设置客户端授权码。这里填授权码。', 'In 126 Mail on the web: Settings → POP3/SMTP/IMAP → turn on IMAP and set a client authorization code. Enter that code here.'),
  },
  {
    id: 'gmail', label: bi('Gmail', 'Gmail'), host: 'imap.gmail.com', port: 993, secure: true, supported: true,
    howTo: bi('Google 账号先开启两步验证，再到「安全性 → 应用专用密码」生成一个 16 位密码，填在这里。', 'Turn on 2-Step Verification for your Google account, then create an app password under Security → App passwords and enter it here.'),
    findMessage: id => `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(id)}`,
  },
  {
    id: 'icloud', label: bi('iCloud 邮件', 'iCloud Mail'), host: 'imap.mail.me.com', port: 993, secure: true, supported: true,
    howTo: bi('在 appleid.apple.com：登录与安全 → App 专用密码，生成一个填在这里。用户名一般是 @icloud.com 前面的部分。', 'At appleid.apple.com: Sign-In and Security → App-Specific Passwords; create one and enter it here. The user name is usually the part before @icloud.com.'),
  },
  {
    id: 'outlook', label: bi('Outlook / Hotmail', 'Outlook / Hotmail'), host: 'outlook.office365.com', port: 993, secure: true, supported: false,
    howTo: bi('微软已经不允许用密码登录 IMAP，需要 OAuth 授权，小秘书暂时还不支持。', 'Microsoft no longer allows password logins over IMAP; it needs OAuth, which the secretary does not support yet.'),
  },
  {
    id: 'custom', label: bi('其他（自己填服务器）', 'Other (enter the server)'), host: '', port: 993, secure: true, supported: true,
    howTo: bi('填你的邮件服务商给的 IMAP 服务器、端口和密码（很多服务商要求用专门的客户端授权码）。', 'Enter the IMAP server, port and password your provider gives you (many require a separate app password).'),
  },
]

export function presetById(id: string): MailPreset {
  return MAIL_PRESETS.find(p => p.id === id) ?? MAIL_PRESETS[MAIL_PRESETS.length - 1]!
}

export interface MailAccount {
  id: number
  /** Shown on cards and in settings ("工作邮箱"). */
  label: string
  /** Your address: mail addressed to it counts as written to you. */
  address: string
  preset: string
  host: string
  port: number
  secure: boolean
  /** IMAP user name; usually the address. */
  user: string
  enabled: boolean
  /** Only unread mail from the last this-many days is looked at. */
  sinceDays: number
}

/** The keychain entry holding this account's password. */
export function secretAccount(id: number): string {
  return `mail:${id}`
}

/** Check and complete what the settings page sent; throws a sentence a person can act on. */
export function resolveAccount(input: Partial<MailAccount>, id: number): MailAccount {
  const address = String(input.address ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new MishuError(bi(`邮箱地址不对：${address || '（空）'}`, `not an email address: ${address || '(empty)'}`))
  const preset = presetById(String(input.preset ?? 'custom'))
  if (!preset.supported) throw new MishuError(bi(`${preset.label.zh}暂时不支持：${preset.howTo.zh}`, `${preset.label.en} is not supported yet: ${preset.howTo.en}`))
  const host = preset.id === 'custom' ? String(input.host ?? '').trim() : preset.host
  if (!/^[\w.-]+$/.test(host)) throw new MishuError(bi('IMAP 服务器地址不对', 'invalid IMAP server'))
  const port = preset.id === 'custom' ? Number(input.port ?? 993) : preset.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MishuError(bi('端口要是 1 到 65535 的整数', 'the port must be a whole number from 1 to 65535'))
  const sinceDays = Number(input.sinceDays ?? 14)
  if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 90) throw new MishuError(bi('「只看最近几天」要是 1 到 90 的整数', 'days to look back must be a whole number from 1 to 90'))
  return {
    id,
    label: String(input.label ?? '').trim() || address,
    address,
    preset: preset.id,
    host,
    port,
    secure: preset.id === 'custom' ? input.secure !== false : preset.secure,
    user: String(input.user ?? '').trim() || address,
    enabled: input.enabled !== false,
    sinceDays,
  }
}

export interface MailAddress {
  name: string
  address: string
}

/** One unread message, as much as the rules need: envelope and a few headers, never the body. */
export interface MailMessage {
  /** Stable id: a hash of the Message-ID (or the UID when there is none). */
  id: string
  uid: number
  messageId: string | null
  /** Message-ID of the first message in the thread, for grouping replies. */
  threadRoot: string
  subject: string
  date: number
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  listId: string | null
  listUnsubscribe: string | null
  autoSubmitted: string | null
  precedence: string | null
  /** Carries a calendar invitation (text/calendar part). */
  hasCalendar: boolean
}

/** Something that can list unread mail; the real one speaks IMAP, tests use a fake. */
export interface MailFetcher {
  /** Unread messages in INBOX from the last `sinceDays` days, opened read-only. */
  unread(account: MailAccount, password: string, sinceDays: number, now: number): Promise<MailMessage[]>
}
