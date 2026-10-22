import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FetchLike } from '../src/core/github/client.ts'
import { GithubDeviceLogin, type DeviceState, type PostLike } from '../src/core/github/device.ts'
import { GITHUB_SECRET } from '../src/core/github/token.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'

const TOKEN = `gho_${'b2'.repeat(18)}`

/** GitHub's two device-flow endpoints, answering from a script. */
function github(polls: Array<Record<string, unknown>>) {
  const sent: Array<{ url: string; fields: Record<string, string> }> = []
  const post: PostLike = async (url, init) => {
    sent.push({ url, fields: Object.fromEntries(new URLSearchParams(init.body)) })
    const body = url.endsWith('/login/device/code')
      ? { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
      : polls.shift() ?? { error: 'authorization_pending' }
    return { status: 200, text: async () => JSON.stringify(body) }
  }
  return { post, sent }
}

/** The REST API the token is checked against once it arrives. */
const api: FetchLike = async (url) => {
  const path = new URL(url).pathname
  const body = path === '/user' ? { login: 'example-user' } : []
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

async function settle(login: GithubDeviceLogin): Promise<DeviceState> {
  for (let i = 0; i < 50 && login.status().state === 'waiting'; i++) await new Promise(resolve => setImmediate(resolve))
  return login.status()
}

test('signing in with GitHub: a code to enter, then the token lands in the keychain', async () => {
  const secrets = new MemorySecrets()
  const waits: number[] = []
  const { post, sent } = github([{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: TOKEN, token_type: 'bearer', scope: 'notifications,repo' }])
  const login = new GithubDeviceLogin({ clientId: 'Iv1.example', secrets, post, fetch: api, sleep: async (ms) => { waits.push(ms) }, now: () => 0 })

  const started = await login.start()
  assert.deepEqual(started, { state: 'waiting', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 900_000 })
  assert.deepEqual(sent[0], { url: 'https://github.com/login/device/code', fields: { client_id: 'Iv1.example', scope: 'notifications repo' } })
  assert.deepEqual(await settle(login), { state: 'done', login: 'example-user' })
  assert.equal(await secrets.get(GITHUB_SECRET), TOKEN)
  assert.deepEqual(waits, [5000, 5000, 10000], 'waits as long as GitHub asks, longer after slow_down')
  assert.equal(sent[1]!.fields.grant_type, 'urn:ietf:params:oauth:grant-type:device_code')
})

test('a cancelled, expired or unconfigured sign-in says what happened', async () => {
  const denied = new GithubDeviceLogin({ clientId: 'Iv1.example', secrets: new MemorySecrets(), post: github([{ error: 'access_denied' }]).post, sleep: async () => {}, now: () => 0 })
  await denied.start()
  const state = await settle(denied)
  assert.equal(state.state === 'failed' && state.message.zh, '你在 GitHub 上取消了授权。')

  let clock = 0
  const expired = new GithubDeviceLogin({ clientId: 'Iv1.example', secrets: new MemorySecrets(), post: github([]).post, sleep: async () => { clock += 600_000 }, now: () => clock })
  await expired.start()
  const late = await settle(expired)
  assert.match(late.state === 'failed' ? late.message.zh : '', /登录码过期了/)

  await assert.rejects(new GithubDeviceLogin({ clientId: '', secrets: new MemorySecrets() }).start(), /No GitHub app is configured/)

  const unknownApp: PostLike = async () => ({ status: 404, text: async () => JSON.stringify({ error: 'Not Found' }) })
  await assert.rejects(new GithubDeviceLogin({ clientId: 'Iv1.wrong', secrets: new MemorySecrets(), post: unknownApp }).start(), /GitHub does not know this app: the client id is wrong/)

  const secrets = new MemorySecrets()
  const never = new GithubDeviceLogin({ clientId: 'Iv1.example', secrets, post: github([{ access_token: TOKEN }]).post, fetch: api, sleep: () => new Promise(() => {}), now: () => 0 })
  await never.start()
  never.cancel()
  assert.deepEqual(never.status(), { state: 'idle' })
})

test('the settings API drives the sign-in and refreshes the page when it is done', async () => {
  const runtime = new Runtime(Config({ github: { enabled: false, useGhCli: false, tokenEnv: 'DSH_MISHU_TEST_NO_TOKEN', clientId: 'Iv1.example' } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  const { MishuStore } = await import('../src/core/store.ts')
  runtime.store = MishuStore.open(':memory:')
  runtime.githubLogin = new GithubDeviceLogin({ clientId: 'Iv1.example', secrets: runtime.secrets, post: github([{ access_token: TOKEN }]).post, fetch: api, sleep: async () => {}, now: () => 0 })
  const handlers = apiHandlers(runtime, () => 0)

  const before = await handlers['/settings']!({ lang: 'zh' }) as { view: { github: { deviceLogin: boolean; token: { found: boolean } } } }
  assert.equal(before.view.github.deviceLogin, true)
  assert.equal(before.view.github.token.found, false)
  const started = await handlers['/github/device/start']!({ lang: 'zh' }) as { login: { state: string; userCode: string } }
  assert.equal(started.login.userCode, 'ABCD-1234')
  await settle(runtime.githubLogin)
  const done = await handlers['/github/device/status']!({ lang: 'zh' }) as { login: { state: string; login: string }; view: { github: { token: { found: boolean; from: string } } } }
  assert.deepEqual(done.login, { state: 'done', login: 'example-user' })
  assert.deepEqual(done.view.github.token, { found: true, from: 'keychain' })

  const off = new Runtime(Config({ github: { enabled: false, clientId: '' } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  off.store = runtime.store
  const view = await apiHandlers(off, () => 0)['/settings']!({ lang: 'zh' }) as { view: { github: { deviceLogin: boolean } } }
  assert.equal(view.view.github.deviceLogin, false, 'no app configured, no button')
  assert.equal(Config({}).github.clientId, 'Ov23liejlNOyARQKgy5x', 'the product ships with its own app')
})
