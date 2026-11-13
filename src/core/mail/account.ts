/**
 * Mail accounts and the providers we know how to reach.
 *
 * An account here is only where and who: host, port, address, user name.
 * The password (an app password or 授权码 for most providers) lives in the
 * system keychain under `mail:<id>`, never in the notebook.
 *
 * One password serves both directions: the same app password opens IMAP for
 * reading and SMTP for sending on every provider we list here, so an account
 * is one entry, not two.
 */

import { bi, MishuError, type Bi } from '../i18n.ts'

/** One step of getting a provider's app password, with the page it happens on. */
export interface MailStep {
  text: Bi
  link?: { url: string; label: Bi }
}

/** Where mail leaves: the same provider's submission server. */
export interface MailSmtp {
  host: string
  port: number
  /** True for implicit TLS (465), false for STARTTLS (587). */
  secure: boolean
}

export interface MailPreset {
  id: string
  label: Bi
  host: string
  port: number
  secure: boolean
  /** Where mail is sent from. Empty host means "ask the account". */
  smtp: MailSmtp
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

const smtp = (host: string, port = 465, secure = port === 465): MailSmtp => ({ host, port, secure })

const NETEASE = (name: string, url: string) => guide([
  { text: bi(`打开 ${name} 邮箱网页版并登录。`, `Open ${name} Mail on the web and sign in.`), link: { url, label: bi(`打开 ${name} 邮箱`, `Open ${name} Mail`) } },
  { text: bi('点上方的「设置」→「POP3/SMTP/IMAP」，开启「IMAP/SMTP 服务」。', 'Click Settings → POP3/SMTP/IMAP at the top and turn on "IMAP/SMTP".') },
  { text: bi('按提示用手机验证，页面会给你一个「客户端授权码」，复制后粘贴到下面的密码框（不是邮箱登录密码）。', 'Verify with your phone as asked; the page shows a client authorization code. Copy it into the password box below (not your mail password).') },
])

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'qq', label: bi('QQ 邮箱', 'QQ Mail'), host: 'imap.qq.com', port: 993, secure: true, smtp: smtp('smtp.qq.com'), supported: true,
    domains: ['qq.com', 'vip.qq.com', 'foxmail.com'], passwordLength: 16,
    ...guide([
      { text: bi('打开 QQ 邮箱网页版并登录。', 'Open QQ Mail on the web and sign in.'), link: { url: 'https://mail.qq.com/', label: bi('打开 QQ 邮箱', 'Open QQ Mail') } },
      { text: bi('点「设置」→「账号与安全」→「安全设置」（旧版界面是「设置」→「账户」），找到「IMAP/SMTP 服务」，点「开启」。', 'Click Settings → Account and Security → Security (Settings → Account in the older layout), find "IMAP/SMTP" and turn it on.') },
      { text: bi('按提示用手机验证，页面会显示一个 16 位授权码，复制后粘贴到下面的密码框（不是 QQ 密码）。改过 QQ 密码后，旧授权码会失效。', 'Verify with your phone as asked; the page shows a 16-character authorization code. Copy it into the password box below (not your QQ password). Changing your QQ password expires old codes.') },
    ]),
  },
  {
    id: 'exmail', label: bi('腾讯企业邮箱', 'Tencent Exmail'), host: 'imap.exmail.qq.com', port: 993, secure: true, smtp: smtp('smtp.exmail.qq.com'), supported: true,
    domains: [],
    ...guide([
      { text: bi('打开腾讯企业邮箱网页版并登录（企业管理员也可以在管理后台替你开启）。', 'Open Tencent Exmail on the web and sign in (an admin can also turn this on for you).'), link: { url: 'https://exmail.qq.com/', label: bi('打开腾讯企业邮箱', 'Open Tencent Exmail') } },
      { text: bi('点「设置」→「客户端设置」，确认「IMAP/SMTP 服务」是开启的。', 'Click Settings → Client settings and check that "IMAP/SMTP" is on.') },
      { text: bi('在「客户端专用密码」里生成一个密码，复制后粘贴到下面的密码框（不是登录密码）。', 'Generate a client-specific password and copy it into the password box below (not your login password).') },
    ]),
  },
  {
    id: '163', label: bi('网易 163 邮箱', 'NetEase 163'), host: 'imap.163.com', port: 993, secure: true, smtp: smtp('smtp.163.com'), supported: true,
    domains: ['163.com'], ...NETEASE('163', 'https://mail.163.com/'),
  },
  {
    id: '126', label: bi('网易 126 邮箱', 'NetEase 126'), host: 'imap.126.com', port: 993, secure: true, smtp: smtp('smtp.126.com'), supported: true,
    domains: ['126.com'], ...NETEASE('126', 'https://mail.126.com/'),
  },
  {
    id: 'aliyun', label: bi('阿里邮箱', 'Alibaba Mail'), host: 'imap.aliyun.com', port: 993, secure: true, smtp: smtp('smtp.aliyun.com'), supported: true,
    domains: ['aliyun.com'],
    ...guide([
      { text: bi('打开阿里邮箱网页版并登录。', 'Open Alibaba Mail on the web and sign in.'), link: { url: 'https://mail.aliyun.com/', label: bi('打开阿里邮箱', 'Open Alibaba Mail') } },
      { text: bi('点右上角「设置」→「账户与安全」→「POP3/IMAP/SMTP」，开启「IMAP/SMTP 服务」。', 'Click Settings → Account and security → POP3/IMAP/SMTP and turn on "IMAP/SMTP".') },
      { text: bi('按提示验证后生成「客户端授权码」，复制后粘贴到下面的密码框（不是登录密码）。', 'Verify as asked, generate a client password and paste it into the password box below (not your login password).') },
    ]),
  },
  {
    id: 'sina', label: bi('新浪邮箱', 'Sina Mail'), host: 'imap.sina.com', port: 993, secure: true, smtp: smtp('smtp.sina.com'), supported: true,
    domains: ['sina.com', 'sina.cn', 'vip.sina.com'],
    ...guide([
      { text: bi('打开新浪邮箱网页版并登录。', 'Open Sina Mail on the web and sign in.'), link: { url: 'https://mail.sina.com.cn/', label: bi('打开新浪邮箱', 'Open Sina Mail') } },
      { text: bi('点「设置」→「账户」，找到「POP3/SMTP/IMAP」并开启「IMAP4 服务」。', 'Click Settings → Account, find "POP3/SMTP/IMAP" and turn on "IMAP4".') },
      { text: bi('把页面上给的客户端授权码粘贴到下面的密码框（不是登录密码）。', 'Paste the client password the page shows into the password box below (not your login password).') },
    ]),
  },
  {
    id: '139', label: bi('中国移动 139 邮箱', 'China Mobile 139'), host: 'imap.139.com', port: 993, secure: true, smtp: smtp('smtp.139.com'), supported: true,
    domains: ['139.com', '189.cn'],
    ...guide([
      { text: bi('打开 139 邮箱网页版并登录。', 'Open 139 Mail on the web and sign in.'), link: { url: 'https://mail.10086.cn/', label: bi('打开 139 邮箱', 'Open 139 Mail') } },
      { text: bi('点「设置」→「账户与安全」，找到「IMAP/SMTP」，开启服务。', 'Click Settings → Account and security, find "IMAP/SMTP" and turn it on.') },
      { text: bi('按提示拿到客户端授权码，粘贴到下面的密码框（不是登录密码）。', 'Get the client password it shows and paste it into the password box below (not your login password).') },
    ]),
  },
  {
    id: 'gmail', label: bi('Gmail', 'Gmail'), host: 'imap.gmail.com', port: 993, secure: true, smtp: smtp('smtp.gmail.com'), supported: true,
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
    id: 'icloud', label: bi('iCloud 邮件', 'iCloud Mail'), host: 'imap.mail.me.com', port: 993, secure: true, smtp: smtp('smtp.mail.me.com', 587, false), supported: true,
    domains: ['icloud.com', 'me.com', 'mac.com'],
    ...guide([
      { text: bi('打开 Apple 账户页面并登录。', 'Open your Apple Account page and sign in.'), link: { url: 'https://account.apple.com/account/manage', label: bi('打开 Apple 账户', 'Open Apple Account') } },
      { text: bi('点「登录与安全」→「App 专用密码」，点「+」，名字随便填。', 'Click Sign-In and Security → App-Specific Passwords, click +, and type any name.') },
      { text: bi('把显示的密码（xxxx-xxxx-xxxx-xxxx）复制，粘贴到下面的密码框。', 'Copy the password it shows (xxxx-xxxx-xxxx-xxxx) into the password box below.') },
    ]),
  },
  {
    id: 'outlook', label: bi('Outlook / Hotmail', 'Outlook / Hotmail'), host: 'outlook.office365.com', port: 993, secure: true, smtp: smtp('smtp.office365.com', 587, false), supported: false,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], steps: [],
    howTo: bi('微软已经不允许用密码登录 IMAP，需要 OAuth 授权，小秘书暂时还不支持。', 'Microsoft no longer allows password logins over IMAP; it needs OAuth, which the secretary does not support yet.'),
  },
  {
    id: 'yahoo', label: bi('Yahoo 邮箱', 'Yahoo Mail'), host: 'imap.mail.yahoo.com', port: 993, secure: true, smtp: smtp('smtp.mail.yahoo.com'), supported: true,
    domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    ...guide([
      { text: bi('打开 Yahoo 账号安全页面并登录。', 'Open your Yahoo account security page and sign in.'), link: { url: 'https://login.yahoo.com/account/security', label: bi('打开 Yahoo 安全设置', 'Open Yahoo security') } },
      { text: bi('点「Generate app password」，选「Other App」，名字随便填。', 'Click Generate app password, choose Other App and type any name.') },
      { text: bi('把生成的密码复制，粘贴到下面的密码框（不是 Yahoo 登录密码）。', 'Copy the password it generates into the password box below (not your Yahoo password).') },
    ]),
  },
  {
    id: 'fastmail', label: bi('Fastmail', 'Fastmail'), host: 'imap.fastmail.com', port: 993, secure: true, smtp: smtp('smtp.fastmail.com'), supported: true,
    domains: ['fastmail.com', 'fastmail.fm'],
    ...guide([
      { text: bi('打开 Fastmail 设置页并登录。', 'Open Fastmail settings and sign in.'), link: { url: 'https://app.fastmail.com/settings/security', label: bi('打开 Fastmail 设置', 'Open Fastmail settings') } },
      { text: bi('点「App passwords」→「New app password」，勾上 IMAP 和 SMTP。', 'Click App passwords → New app password and tick IMAP and SMTP.') },
      { text: bi('把生成的密码复制，粘贴到下面的密码框。', 'Copy the password it generates into the password box below.') },
    ]),
  },
  {
    id: 'zoho', label: bi('Zoho 邮箱', 'Zoho Mail'), host: 'imap.zoho.com', port: 993, secure: true, smtp: smtp('smtp.zoho.com'), supported: true,
    domains: ['zoho.com', 'zohomail.com'],
    ...guide([
      { text: bi('打开 Zoho 账号安全页并登录。', 'Open your Zoho account security page and sign in.'), link: { url: 'https://accounts.zoho.com/home#security/app_password', label: bi('打开 Zoho 安全设置', 'Open Zoho security') } },
      { text: bi('在「App Passwords」里点「Generate New Password」。', 'Under App Passwords click Generate New Password.') },
      { text: bi('把生成的密码复制，粘贴到下面的密码框。', 'Copy the generated password into the password box below.') },
    ]),
  },
  {
    id: 'custom', label: bi('其他（自己填服务器）', 'Other (enter the server)'), host: '', port: 993, secure: true, smtp: { host: '', port: 465, secure: true }, supported: true,
    domains: [], steps: [],
    howTo: bi('填你的邮件服务商给的 IMAP 和 SMTP 服务器、端口和密码（很多服务商要求用专门的客户端授权码）。', 'Enter the IMAP and SMTP servers, ports and password your provider gives you (many require a separate app password).'),
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
  /** Where mail leaves; only a custom account sets these, otherwise the preset's. */
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
}

/** Where this account sends from, with the preset's server as the default. */
export function smtpOf(account: Pick<MailAccount, 'preset' | 'host' | 'smtpHost' | 'smtpPort' | 'smtpSecure'>): MailSmtp {
  const preset = presetById(account.preset)
  const host = account.smtpHost ?? (preset.id === 'custom' ? '' : preset.smtp.host)
  const port = account.smtpPort ?? preset.smtp.port
  return { host, port, secure: account.smtpSecure ?? preset.smtp.secure }
}

/** "Name <address>", the way a recipient sees the sender. */
export function senderOf(account: Pick<MailAccount, 'label' | 'address'>): string {
  const name = account.label.trim()
  return name === '' || name === account.address ? account.address : `${name.replace(/["\\\r\n]/g, '')} <${account.address}>`
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

  const account: MailAccount = {
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
  if (preset.id === 'custom') {
    const smtpHost = String(input.smtpHost ?? '').trim()
    if (smtpHost !== '' && !/^[\w-]+(\.[\w-]+)+$/.test(smtpHost) && smtpHost !== 'localhost') {
      throw new MishuError(bi(`SMTP 服务器地址不对：${smtpHost}，应该像 smtp.example.com`, `invalid SMTP server: ${smtpHost}; it should look like smtp.example.com`))
    }
    const smtpPort = Number(input.smtpPort ?? 465)
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new MishuError(bi('SMTP 端口要是 1 到 65535 的整数', 'the SMTP port must be a whole number from 1 to 65535'))
    account.smtpHost = smtpHost
    account.smtpPort = smtpPort
    account.smtpSecure = input.smtpSecure !== false
  }
  return account
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

// ── reading, searching, moving ─────────────────────────────

/** One row of a mailbox listing: no body. */
export interface MailSummary {
  id: string
  uid: number
  messageId: string | null
  subject: string
  date: number
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  size: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  hasCalendar: boolean
  folder: string
}

export interface MailAttachmentInfo {
  /** 0-based position in the message, what `attachment()` takes. */
  index: number
  filename: string
  contentType: string
  size: number
  contentId: string | null
}

/** A message with its body: plain text always, HTML when the sender wrote one. */
export interface MailBody extends MailSummary {
  text: string
  html: string | null
  attachments: MailAttachmentInfo[]
  /** The body was longer than the limit and was cut. */
  truncated: boolean
}

export interface MailListOptions {
  /** Mailbox path; INBOX by default. */
  folder?: string
  /** 1–100. */
  limit?: number
  offset?: number
  unreadOnly?: boolean
  /** Newest message time to include (epoch ms). */
  since?: number
  until?: number
}

export interface MailListPage {
  folder: string
  total: number
  messages: MailSummary[]
}

export type MailSearchField = 'subject' | 'from' | 'to' | 'cc' | 'body'

export interface MailSearchOptions extends MailListOptions {
  query: string
  /** Which parts to look in; headers by default. */
  fields?: MailSearchField[]
  /** How many bodies to open when `body` is among the fields. */
  bodyLimit?: number
}

export interface MailSearchResult {
  folder: string
  /** Where the hits came from: the server, or a local scan of headers or bodies. */
  source: 'server' | 'local-headers' | 'local-body'
  scanned: number
  messages: MailSummary[]
}

/**
 * What can be done to one message. `delete` moves it to the mailbox's Trash
 * folder (the same thing most clients mean by delete); `purge` removes it for
 * good and is only allowed inside Trash, because there is no undo after it.
 */
export type MailMarkAction = 'read' | 'unread' | 'star' | 'unstar' | 'move' | 'delete' | 'purge'

export interface MailMarkResult {
  uid: number
  /** The UID after a move; the same UID otherwise. */
  newUid: number | null
  folder: string
}

/** A batch is small on purpose: one mistaken click should not empty a folder. */
export const MAX_BATCH = 20

export interface MailFolder {
  path: string
  name: string
  delimiter: string
  /** `\Inbox`, `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`, or null. */
  specialUse: string | null
  flags: string[]
  /** How many messages are in it, when the server says without opening it. */
  messages?: number
  unread?: number
}

/** What a downloaded attachment looks like before it is written anywhere. */
export interface MailAttachment {
  filename: string
  contentType: string
  content: Buffer
}

/** Largest attachment one download may pull, unless the caller asks for less. */
export const MAX_ATTACHMENT_DOWNLOAD = 25 * 1024 * 1024

/**
 * Something that can list unread mail; the real one speaks IMAP, tests use a
 * fake. `unread()` is all a sync needs; the rest is optional so a fake stays
 * two lines long, and the operations that need it say plainly when a fetcher
 * cannot do them.
 */
export interface MailFetcher {
  /** Unread messages in INBOX from the last `sinceDays` days, opened read-only. */
  unread(account: MailAccount, password: string, sinceDays: number, now: number): Promise<MailMessage[]>
  list?(account: MailAccount, password: string, options: MailListOptions): Promise<MailListPage>
  read?(account: MailAccount, password: string, folder: string, uid: number, maxChars: number): Promise<MailBody>
  search?(account: MailAccount, password: string, options: MailSearchOptions): Promise<MailSearchResult>
  mark?(account: MailAccount, password: string, folder: string, uid: number, action: MailMarkAction, destination?: string): Promise<MailMarkResult>
  /**
   * The same action on up to `MAX_BATCH` uids. Optional like the rest, and
   * separate from `mark` because a server may be able to do several at once
   * where one-at-a-time would open the folder repeatedly.
   */
  markMany?(account: MailAccount, password: string, folder: string, uids: number[], action: MailMarkAction, destination?: string): Promise<MailMarkResult[]>
  folders?(account: MailAccount, password: string): Promise<MailFolder[]>
  createFolder?(account: MailAccount, password: string, path: string): Promise<void>
  renameFolder?(account: MailAccount, password: string, from: string, to: string): Promise<void>
  deleteFolder?(account: MailAccount, password: string, path: string): Promise<void>
  attachment?(account: MailAccount, password: string, folder: string, uid: number, index: number, maxBytes: number): Promise<MailAttachment>
}
