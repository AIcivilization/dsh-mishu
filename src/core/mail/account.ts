/**
 * Mail accounts and the providers we know how to reach.
 *
 * An account here is only where and who: host, port, address, user name.
 * The password (an app password or 授权码 for most providers) lives in the
 * system keychain under `mail:<id>`, never in the notebook.
 */

import { bi, MishuError, type Bi } from '../i18n.ts'

/** One step of getting a provider's app password, with the page it happens on. */
export interface MailStep {
  text: Bi
  link?: { url: string; label: Bi }
}

export interface MailPreset {
  id: string
  label: Bi
  host: string
  port: number
  secure: boolean
  /** False when the provider no longer allows password logins over IMAP. */
  supported: boolean
  /** Numbered steps to the password this provider expects, each with its page to open. */
  steps: MailStep[]
  /** The same as one paragraph, for error messages and "+AI"; a short note where there are no steps. */
  howTo: Bi
  /** Address domains that belong to this provider, for picking it from the address. */
  domains: string[]
  /** Length of the app password or code, when the provider fixes it (spaces aside). */
  passwordLength?: number
  /** A web link that finds one message by Message-ID, when the provider has one. */
  findMessage?: (messageId: string) => string
}

/** Steps, and the same steps as one numbered paragraph. */
function guide(steps: MailStep[]): Pick<MailPreset, 'steps' | 'howTo'> {
  return {
    steps,
    howTo: bi(steps.map((step, i) => `${i + 1}. ${step.text.zh}`).join(' '), steps.map((step, i) => `${i + 1}. ${step.text.en}`).join(' ')),
  }
}

const NETEASE = (name: string, url: string) => guide([
  { text: bi(`打开 ${name} 邮箱网页版并登录。`, `Open ${name} Mail on the web and sign in.`), link: { url, label: bi(`打开 ${name} 邮箱`, `Open ${name} Mail`) } },
  { text: bi('点上方的「设置」→「POP3/SMTP/IMAP」，开启「IMAP/SMTP 服务」。', 'Click Settings → POP3/SMTP/IMAP at the top and turn on "IMAP/SMTP".') },
  { text: bi('按提示用手机验证，页面会给你一个「客户端授权码」，复制后粘贴到下面的密码框（不是邮箱登录密码）。', 'Verify with your phone as asked; the page shows a client authorization code. Copy it into the password box below (not your mail password).') },
])

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'qq', label: bi('QQ 邮箱', 'QQ Mail'), host: 'imap.qq.com', port: 993, secure: true, supported: true,
    domains: ['qq.com', 'vip.qq.com', 'foxmail.com'], passwordLength: 16,
    ...guide([
      { text: bi('打开 QQ 邮箱网页版并登录。', 'Open QQ Mail on the web and sign in.'), link: { url: 'https://mail.qq.com/', label: bi('打开 QQ 邮箱', 'Open QQ Mail') } },
      { text: bi('点「设置」→「账号与安全」→「安全设置」（旧版界面是「设置」→「账户」），找到「IMAP/SMTP 服务」，点「开启」。', 'Click Settings → Account and Security → Security (Settings → Account in the older layout), find "IMAP/SMTP" and turn it on.') },
      { text: bi('按提示用手机验证，页面会显示一个 16 位授权码，复制后粘贴到下面的密码框（不是 QQ 密码）。改过 QQ 密码后，旧授权码会失效。', 'Verify with your phone as asked; the page shows a 16-character authorization code. Copy it into the password box below (not your QQ password). Changing your QQ password expires old codes.') },
    ]),
  },
  {
    id: '163', label: bi('网易 163 邮箱', 'NetEase 163'), host: 'imap.163.com', port: 993, secure: true, supported: true,
    domains: ['163.com'], ...NETEASE('163', 'https://mail.163.com/'),
  },
  {
    id: '126', label: bi('网易 126 邮箱', 'NetEase 126'), host: 'imap.126.com', port: 993, secure: true, supported: true,
    domains: ['126.com'], ...NETEASE('126', 'https://mail.126.com/'),
  },
  {
    id: 'gmail', label: bi('Gmail', 'Gmail'), host: 'imap.gmail.com', port: 993, secure: true, supported: true,
    domains: ['gmail.com', 'googlemail.com'], passwordLength: 16,
    ...guide([
      {
        text: bi('开启 Google 账号的两步验证（已经开了就跳过这步）。', 'Turn on 2-Step Verification for your Google account (skip this if it is on).'),
        link: { url: 'https://myaccount.google.com/signinoptions/twosv', label: bi('打开两步验证', 'Open 2-Step Verification') },
      },
      {
        text: bi('打开「应用专用密码」页面，名字随便填（比如"小秘书"），点「创建」。如果页面说"设置不可用"，说明第 1 步还没做。', 'Open the App passwords page, type any name ("secretary") and click Create. If the page says the setting is not available, step 1 is not done yet.'),
        link: { url: 'https://myaccount.google.com/apppasswords', label: bi('打开应用专用密码', 'Open App passwords') },
      },
      { text: bi('把弹出来的 16 位密码复制，粘贴到下面的密码框（带不带空格都行）。它只显示这一次。', 'Copy the 16-character password it shows into the password box below (spaces or not). It is shown only once.') },
    ]),
    findMessage: id => `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(id)}`,
  },
  {
    id: 'icloud', label: bi('iCloud 邮件', 'iCloud Mail'), host: 'imap.mail.me.com', port: 993, secure: true, supported: true,
    domains: ['icloud.com', 'me.com', 'mac.com'],
    ...guide([
      { text: bi('打开 Apple 账户页面并登录。', 'Open your Apple Account page and sign in.'), link: { url: 'https://account.apple.com/account/manage', label: bi('打开 Apple 账户', 'Open Apple Account') } },
      { text: bi('点「登录与安全」→「App 专用密码」，点「+」，名字随便填。', 'Click Sign-In and Security → App-Specific Passwords, click +, and type any name.') },
      { text: bi('把显示的密码（xxxx-xxxx-xxxx-xxxx）复制，粘贴到下面的密码框。', 'Copy the password it shows (xxxx-xxxx-xxxx-xxxx) into the password box below.') },
    ]),
  },
  {
    id: 'outlook', label: bi('Outlook / Hotmail', 'Outlook / Hotmail'), host: 'outlook.office365.com', port: 993, secure: true, supported: false,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], steps: [],
    howTo: bi('微软已经不允许用密码登录 IMAP，需要 OAuth 授权，小秘书暂时还不支持。', 'Microsoft no longer allows password logins over IMAP; it needs OAuth, which the secretary does not support yet.'),
  },
  {
    id: 'custom', label: bi('其他（自己填服务器）', 'Other (enter the server)'), host: '', port: 993, secure: true, supported: true,
    domains: [], steps: [],
    howTo: bi('填你的邮件服务商给的 IMAP 服务器、端口和密码（很多服务商要求用专门的客户端授权码）。', 'Enter the IMAP server, port and password your provider gives you (many require a separate app password).'),
  },
]

/** The provider an address belongs to, from its domain; `undefined` when we do not know it. */
export function presetForAddress(address: string): MailPreset | undefined {
  const domain = address.trim().toLowerCase().split('@')[1] ?? ''
  return MAIL_PRESETS.find(p => p.domains.includes(domain))
}

/**
 * The password as the server wants it. App passwords and codes are shown in
 * groups ("abcd efgh ijkl mnop") and copied with the spaces; they never
 * contain one, so spaces go when the provider fixes the length.
 */
export function normalizePassword(presetId: string, password: string): string {
  return presetById(presetId).passwordLength === undefined ? password : password.replace(/\s+/g, '')
}

/** An account whose address belongs to another provider than its server ("…@gmail.com" on imap.qq.com). */
export function providerMismatch(account: Pick<MailAccount, 'address' | 'preset' | 'host'>): Bi | undefined {
  const expected = presetForAddress(account.address)
  if (expected === undefined || expected.id === account.preset || account.preset === 'custom') return undefined
  const domain = account.address.split('@')[1]
  return bi(
    `地址是 ${domain}，服务器却是 ${presetById(account.preset).label.zh}的 ${account.host}。点「编辑」把服务商改成「${expected.label.zh}」。`,
    `The address is ${domain} but the server is ${account.host} (${presetById(account.preset).label.en}). Click Edit and choose "${expected.label.en}".`,
  )
}

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
  // A name with a dot (imap.example.com), a full IPv4 address, or localhost; a bare number is a port typed in the wrong box.
  if (!/^[\w-]+(\.[\w-]+)+$/.test(host) && host !== 'localhost' || /^\d+$/.test(host)) {
    throw new MishuError(bi(`IMAP 服务器地址不对：${host || '（空）'}，应该像 imap.example.com`, `invalid IMAP server: ${host || '(empty)'}; it should look like imap.example.com`))
  }
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
