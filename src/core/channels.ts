/**
 * Where reminders go.
 *
 *   desktop  this computer's own notifications: macOS through osascript,
 *            Windows through a PowerShell toast, Linux through notify-send.
 *            A server without a desktop has none and says so.
 *   feishu   a custom bot in a Feishu / Lark group (just you is fine). Its
 *            webhook address and optional signing secret are secrets: they
 *            live in the keychain (or the secrets file), never the notebook.
 *
 * Text reaches the helper programs as arguments to a fixed script or on
 * stdin, never inside the script itself, so nothing in a title can run.
 */

import { createHmac } from 'node:crypto'
import { findProgram, runProgram } from './exec.ts'
import { bi, MishuError, type Bi } from './i18n.ts'
import type { Channel, Message } from './notify.ts'
import type { SecretStore } from './secrets.ts'

const one = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export class DesktopChannel implements Channel {
  readonly id = 'desktop' as const
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  constructor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
    this.platform = platform
    this.env = env
  }

  async status(): Promise<{ available: true } | { available: false; why: Bi }> {
    if (this.platform === 'darwin') return findProgram('osascript') === undefined ? { available: false, why: bi('没找到 osascript', 'osascript was not found') } : { available: true }
    if (this.platform === 'win32') return findProgram('powershell') === undefined ? { available: false, why: bi('没找到 Windows PowerShell', 'Windows PowerShell was not found') } : { available: true }
    if (this.env.DISPLAY === undefined && this.env.WAYLAND_DISPLAY === undefined) {
      return { available: false, why: bi('这台电脑没有桌面（比如服务器），弹不出电脑通知。用飞书就行。', 'This computer has no desktop (a server, say), so it cannot show notifications. Use Feishu instead.') }
    }
    return findProgram('notify-send') === undefined
      ? { available: false, why: bi('没找到 notify-send（Debian/Ubuntu：sudo apt install libnotify-bin）', 'notify-send was not found (Debian/Ubuntu: sudo apt install libnotify-bin)') }
      : { available: true }
  }

  async send(message: Message): Promise<void> {
    const title = one(message.title, 80)
    const body = one(message.body, 200)
    let result
    if (this.platform === 'darwin') {
      result = await runProgram(findProgram('osascript')!, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "default"', '-e', 'end run', title, body])
    } else if (this.platform === 'win32') {
      result = await runProgram(findProgram('powershell')!, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST], `${title}\n${body}`)
    } else {
      result = await runProgram(findProgram('notify-send')!, ['-a', 'DSH', title, body])
    }
    if (result.code !== 0) throw new Error(`notification failed (${(result.stderr.trim() || result.failure || `exit ${result.code}`).slice(0, 200)})`)
  }
}

// Title on the first line of stdin, body after it; shown as Windows PowerShell's toast.
const WINDOWS_TOAST = [
  '$t=[Console]::In.ReadLine();$b=[Console]::In.ReadToEnd();',
  '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];',
  '$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
  "$n=$x.GetElementsByTagName('text');[void]$n.Item(0).AppendChild($x.CreateTextNode($t));[void]$n.Item(1).AppendChild($x.CreateTextNode($b));",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join('')

export const FEISHU_WEBHOOK = 'feishu:webhook'
export const FEISHU_SECRET = 'feishu:secret'
const WEBHOOK = /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[\w-]{8,}$/

export type JsonPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>

/** Feishu's errors for a custom bot, said so you know what to change in the group's bot settings. */
function feishuError(code: number, msg: string): Bi {
  if (code === 19024) return bi('飞书拒收：消息里没有机器人设置的关键词。把关键词设成"小秘书"，或者改用签名校验。', 'Feishu refused it: the message lacks the bot\'s keyword. Set the keyword to "小秘书" or use signature verification instead.')
  if (code === 19021) return bi('飞书拒收：签名不对。把机器人"签名校验"里的密钥重新复制过来。', 'Feishu refused it: wrong signature. Copy the bot\'s signing secret again.')
  if (code === 19022) return bi('飞书拒收：这台电脑的 IP 不在机器人的 IP 白名单里。', 'Feishu refused it: this computer\'s IP is not on the bot\'s allowlist.')
  if (code === 19001 || /not found|invalid/i.test(msg)) return bi('飞书找不到这个机器人：地址抄错了，或者机器人已经被删掉。', 'Feishu does not know this bot: the address is mistyped or the bot was removed.')
  return bi(`飞书拒收（${code}：${msg}）`, `Feishu refused it (${code}: ${msg})`)
}

export class FeishuChannel implements Channel {
  readonly id = 'feishu' as const
  private readonly secrets: SecretStore
  private readonly post: JsonPost
  constructor(secrets: SecretStore, post?: JsonPost) {
    this.secrets = secrets
    this.post = post ?? (globalThis.fetch as unknown as JsonPost)
  }

  async status(): Promise<{ available: true } | { available: false; why: Bi }> {
    return await this.secrets.get(FEISHU_WEBHOOK).catch(() => undefined) === undefined
      ? { available: false, why: bi('还没填飞书机器人的地址。', 'No Feishu bot address yet.') }
      : { available: true }
  }

  async send(message: Message): Promise<void> {
    const webhook = await this.secrets.get(FEISHU_WEBHOOK)
    if (webhook === undefined) throw new MishuError(bi('还没填飞书机器人的地址。', 'No Feishu bot address yet.'))
    await sendFeishu(this.post, webhook, await this.secrets.get(FEISHU_SECRET), message.text)
  }
}

async function sendFeishu(post: JsonPost, webhook: string, secret: string | undefined, text: string, now = Date.now()): Promise<void> {
  const timestamp = String(Math.floor(now / 1000))
  // Feishu signs with HMAC-SHA256 keyed by "timestamp\nsecret" over an empty message.
  const signed = secret === undefined ? {} : { timestamp, sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') }
  const response = await post(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ...signed, msg_type: 'text', content: { text } }),
  })
  const raw = await response.text()
  let answer: { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string }
  try {
    answer = JSON.parse(raw)
  } catch {
    throw new MishuError(bi(`飞书没有正常回应（HTTP ${response.status}）`, `Feishu did not answer properly (HTTP ${response.status})`))
  }
  const code = answer.code ?? answer.StatusCode ?? 0
  if (code !== 0) throw new MishuError(feishuError(code, answer.msg ?? answer.StatusMessage ?? ''))
}

/**
 * Keep a bot address (and its signing secret, if the bot uses one) after
 * sending a first message through it, so a wrong address never gets saved.
 */
export async function saveFeishu(secrets: SecretStore, input: { webhook: string; secret?: string }, lang: 'zh' | 'en', post?: JsonPost): Promise<void> {
  const webhook = input.webhook.trim()
  const secret = input.secret?.trim() || undefined
  if (!WEBHOOK.test(webhook)) {
    throw new MishuError(bi('这不像飞书机器人的地址：应该以 https://open.feishu.cn/open-apis/bot/v2/hook/ 开头。', 'That is not a Feishu bot address: it starts with https://open.feishu.cn/open-apis/bot/v2/hook/.'))
  }
  const status = await secrets.status()
  if (!status.available) throw new MishuError(bi(`没法保存：${status.why.zh}`, `Cannot save it: ${status.why.en}`))
  await sendFeishu(post ?? (globalThis.fetch as unknown as JsonPost), webhook, secret,
    lang === 'zh' ? '小秘书已经连上这个群，以后的提醒会发到这里。' : 'The secretary is connected to this group; reminders will come here.')
  await secrets.set(FEISHU_WEBHOOK, webhook)
  if (secret === undefined) await secrets.delete(FEISHU_SECRET)
  else await secrets.set(FEISHU_SECRET, secret)
}

export async function deleteFeishu(secrets: SecretStore): Promise<void> {
  await secrets.delete(FEISHU_WEBHOOK)
  await secrets.delete(FEISHU_SECRET)
}
