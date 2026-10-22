/**
 * "Sign in with GitHub" without pasting a token: GitHub's device flow.
 *
 * The secretary asks GitHub for a short code, you enter it at
 * github.com/login/device (on any computer) and approve, and the secretary
 * receives a token, checks it like a pasted one and keeps it in the
 * keychain (or the secrets file). It needs the client id of a GitHub OAuth
 * App with device flow enabled; the id is public, there is no secret.
 *
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

import { bi, MishuError, type Bi } from '../i18n.ts'
import type { SecretStore } from '../secrets.ts'
import type { FetchLike } from './client.ts'
import { saveGithubToken } from './token.ts'

/** Notifications, and repo so CI runs, pull requests and issues of private repositories can be looked up. */
export const DEVICE_SCOPES = 'notifications repo'

export type DeviceState =
  | { state: 'idle' }
  | { state: 'waiting'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'done'; login: string }
  | { state: 'failed'; message: Bi }

/** `fetch` with a form body, which the device flow endpoints take. */
export type PostLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>

interface Options {
  clientId: string
  secrets: SecretStore
  post?: PostLike
  /** For checking the token once it arrives; tests replay GitHub. */
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class GithubDeviceLogin {
  private readonly options: Options
  private current: DeviceState = { state: 'idle' }
  /** Bumped by every start and cancel, so an older poll loop stops quietly. */
  private generation = 0

  constructor(options: Options) {
    this.options = options
  }

  status(): DeviceState {
    if (this.current.state === 'waiting' && this.now() > this.current.expiresAt) {
      this.current = { state: 'failed', message: EXPIRED }
    }
    return this.current
  }

  cancel(): void {
    this.generation++
    this.current = { state: 'idle' }
  }

  /** Ask GitHub for a code; polling for your approval runs in the background. */
  async start(): Promise<DeviceState> {
    if (this.options.clientId === '') {
      throw new MishuError(bi('还没有配置 GitHub 应用，没法用 GitHub 登录。可以改用下面的"粘贴 token"。', 'No GitHub app is configured, so signing in with GitHub is not available. Paste a token below instead.'))
    }
    const generation = ++this.generation
    const answer = await this.form('https://github.com/login/device/code', { client_id: this.options.clientId, scope: DEVICE_SCOPES })
    const deviceCode = String(answer.device_code ?? '')
    const userCode = String(answer.user_code ?? '')
    if (deviceCode === '' || userCode === '') throw new MishuError(failure(answer))
    const expiresAt = this.now() + Number(answer.expires_in ?? 900) * 1000
    this.current = { state: 'waiting', userCode, verificationUri: String(answer.verification_uri ?? 'https://github.com/login/device'), expiresAt }
    void this.poll(generation, deviceCode, Number(answer.interval ?? 5), expiresAt)
    return this.current
  }

  private async poll(generation: number, deviceCode: string, interval: number, expiresAt: number): Promise<void> {
    const stale = () => generation !== this.generation
    try {
      while (!stale()) {
        await this.sleep(interval * 1000)
        if (stale()) return
        if (this.now() > expiresAt) {
          this.current = { state: 'failed', message: EXPIRED }
          return
        }
        const answer = await this.form('https://github.com/login/oauth/access_token', {
          client_id: this.options.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        })
        if (stale()) return
        if (typeof answer.access_token === 'string' && answer.access_token !== '') {
          const { login } = await saveGithubToken(this.options.secrets, answer.access_token, this.options.fetch)
          if (!stale()) this.current = { state: 'done', login }
          return
        }
        switch (answer.error) {
          case 'authorization_pending':
            break
          case 'slow_down':
            interval = Number(answer.interval ?? interval + 5)
            break
          case 'expired_token':
            this.current = { state: 'failed', message: EXPIRED }
            return
          case 'access_denied':
            this.current = { state: 'failed', message: bi('你在 GitHub 上取消了授权。', 'You cancelled the authorization on GitHub.') }
            return
          default:
            this.current = { state: 'failed', message: failure(answer) }
            return
        }
      }
    } catch (error) {
      if (!stale()) this.current = { state: 'failed', message: error instanceof MishuError ? error.text : bi(`连不上 GitHub：${(error as Error).message}`, `Could not reach GitHub: ${(error as Error).message}`) }
    }
  }

  private async form(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const post = this.options.post ?? (globalThis.fetch as unknown as PostLike)
    const response = await post(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'dsh-mishu' },
      body: new URLSearchParams(fields).toString(),
    })
    const text = await response.text()
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return { error: `http_${response.status}`, error_description: text.slice(0, 200) }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? (wait => new Promise(resolve => setTimeout(resolve, wait))))(ms)
  }
}

const EXPIRED = bi('登录码过期了，再点一次"用 GitHub 登录"。', 'The sign-in code expired; click "Sign in with GitHub" again.')

function failure(answer: Record<string, unknown>): Bi {
  const what = String(answer.error_description ?? answer.error ?? 'unknown error')
  if (answer.error === 'http_404' || /^not found$/i.test(String(answer.error ?? answer.message ?? ''))) {
    return bi('GitHub 找不到这个应用：Client ID 不对。', 'GitHub does not know this app: the client id is wrong.')
  }
  if (answer.error === 'device_flow_disabled') {
    return bi('这个 GitHub 应用没有打开"设备登录"（Enable Device Flow）。', 'This GitHub app does not have device flow enabled.')
  }
  return bi(`GitHub 登录没成功：${what}`, `Signing in with GitHub failed: ${what}`)
}
