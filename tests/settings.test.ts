import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findProgram, usualDirs } from '../src/core/exec.ts'
import type { FetchLike } from '../src/core/github/client.ts'
import { GITHUB_SECRET, resolveGithubToken, saveGithubToken } from '../src/core/github/token.ts'
import { bi } from '../src/core/i18n.ts'
import { FileSecrets, KeychainOrFile, MemorySecrets } from '../src/core/secrets.ts'
import { mailAccounts, saveMailAccount } from '../src/core/settings.ts'
import { MishuStore } from '../src/core/store.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'
import { MAIL_NOW } from './fixtures/synthetic-mail.ts'

const posixOnly = { skip: process.platform === 'win32' ? 'shell scripts stand in for programs' : false }
const NO_KEYCHAIN = bi('没找到 secret-tool', 'secret-tool was not found')
const FAKE_TOKEN = `ghp_${'a1'.repeat(18)}`

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test('a program missing from a short PATH is still found where installers put it', posixOnly, () => {
  const home = mkdtempSync(join(tmpdir(), 'mishu-home-'))
  const gh = script(join(home, '.local', 'bin'), 'gh-mishu-test', 'exit 0')
  assert.equal(findProgram('gh-mishu-test', { platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home }), gh)
  assert.equal(findProgram('gh-mishu-test', { platform: 'linux', env: { PATH: '' }, home }), gh)
  assert.equal(findProgram('no-such-program-mishu', { platform: 'linux', env: { PATH: '' }, home }), undefined)
  assert.ok(usualDirs({ platform: 'darwin', home }).includes('/opt/homebrew/bin'))
  const win = usualDirs({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' }, home: 'C:\\Users\\me' })
  assert.ok(win.includes('C:\\Program Files\\GitHub CLI'))
  assert.ok(win.includes('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links'))
  assert.ok(win.includes('C:\\Windows\\System32\\WindowsPowerShell\\v1.0'))
})

test('the GitHub token comes from the environment, then the keychain, then gh — and says what to do when there is none', posixOnly, async () => {
  const env = 'DSH_MISHU_TEST_TOKEN_ORDER'
  const secrets = new MemorySecrets()
  const dir = mkdtempSync(join(tmpdir(), 'mishu-gh-'))
  const loggedIn = script(dir, 'gh-ok', 'echo gho_from_cli')
  const loggedOut = script(dir, 'gh-out', 'echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1')

  assert.deepEqual(await resolveGithubToken({ envName: env, useGhCli: true, secrets, ghPath: loggedIn }), { token: 'gho_from_cli', from: 'gh' })
  await secrets.set(GITHUB_SECRET, FAKE_TOKEN)
  assert.deepEqual(await resolveGithubToken({ envName: env, useGhCli: true, secrets, ghPath: loggedIn }), { token: FAKE_TOKEN, from: 'keychain' })
  process.env[env] = 'from-env'
  try {
    assert.deepEqual(await resolveGithubToken({ envName: env, useGhCli: true, secrets, ghPath: loggedIn }), { token: 'from-env', from: 'env' })
  } finally {
    delete process.env[env]
  }

  const empty = new MemorySecrets()
  const missing = await resolveGithubToken({ envName: env, useGhCli: true, secrets: empty, ghPath: null })
  assert.ok('error' in missing)
  assert.equal(missing.error.zh, `没有 GitHub token（环境变量 ${env} 是空的，钥匙串里也没有存），这台电脑上也没找到 GitHub CLI（gh）。在小秘书的设置页填一个 token，或者装上 gh 后运行 gh auth login。`)
  assert.doesNotMatch(missing.error.en, /ENOENT|spawn/)
  const out = await resolveGithubToken({ envName: env, useGhCli: true, secrets: empty, ghPath: loggedOut })
  assert.ok('error' in out)
  assert.match(out.error.en, /gh gave no token \(You are not logged into any GitHub hosts\. To log in, run: gh auth login\)\. Run gh auth login, or paste a token on the secretary's settings page\.$/)
  const off = await resolveGithubToken({ envName: env, useGhCli: false, secrets: empty })
  assert.ok('error' in off)
  assert.match(off.error.zh, /在小秘书的设置页填一个 token。$/)
})

function github(routes: Record<string, number>): FetchLike & { seen: string[] } {
  const seen: string[] = []
  const fetch = (async (url: string) => {
    const path = new URL(url).pathname
    seen.push(path)
    const status = routes[path] ?? 404
    const body = path === '/user' && status === 200 ? JSON.stringify({ login: 'example-user' }) : JSON.stringify({ message: status === 200 ? 'ok' : 'nope' })
    return { status, headers: { get: () => null }, text: async () => body }
  }) as FetchLike & { seen: string[] }
  fetch.seen = seen
  return fetch
}

test('a pasted token is checked with GitHub before it goes to the keychain', async () => {
  const secrets = new MemorySecrets()
  await assert.rejects(saveGithubToken(secrets, 'my password', github({})), /does not look like a GitHub token/)
  await assert.rejects(saveGithubToken(secrets, FAKE_TOKEN, github({ '/user': 401 })), /does not accept this token/)
  await assert.rejects(saveGithubToken(secrets, FAKE_TOKEN, github({ '/user': 200, '/notifications': 403 })), /belongs to example-user but cannot read notifications\. .*classic tokens/)
  assert.equal(await secrets.get(GITHUB_SECRET), undefined, 'nothing kept from a failed check')
  assert.deepEqual(await saveGithubToken(secrets, `  ${FAKE_TOKEN}\n`, github({ '/user': 200, '/notifications': 200 })), { login: 'example-user' })
  assert.equal(await secrets.get(GITHUB_SECRET), FAKE_TOKEN)
  const fetch = github({ '/user': 200, '/notifications': 200 })
  await assert.rejects(saveGithubToken(new MemorySecrets(NO_KEYCHAIN), FAKE_TOKEN, fetch), /Cannot save it: secret-tool was not found/)
  assert.deepEqual(fetch.seen, [], 'no keychain, no request')
})

test('without a keychain, mail accounts still save and say where the password comes from', async () => {
  const store = MishuStore.open(':memory:')
  const secrets = new MemorySecrets(NO_KEYCHAIN)
  const account = await saveMailAccount(store, secrets, { preset: 'qq', address: 'me@example.com' }, 'typed-only-for-the-test', MAIL_NOW)
  assert.equal(account.host, 'imap.qq.com')
  assert.equal(mailAccounts(store).length, 1)
  assert.ok(!JSON.stringify(store.get('mail.accounts')).includes('typed-only-for-the-test'))

  const runtime = new Runtime(Config({ github: { enabled: false, useGhCli: false, tokenEnv: 'DSH_MISHU_TEST_NO_TOKEN' } }), { info() {}, warn() {} }, secrets, { unread: async () => [] })
  runtime.store = store
  const api = apiHandlers(runtime, () => MAIL_NOW)
  const { view } = await api['/settings']!({ lang: 'zh' }) as { view: { secrets: unknown; accounts: Array<{ hasPassword: boolean; envName: string }>; github: { token: { found: boolean; text: string } } } }
  assert.deepEqual(view.secrets, { kind: 'memory', available: false, why: '没找到 secret-tool' })
  assert.deepEqual(view.accounts.map(a => [a.hasPassword, a.envName]), [[false, 'DSH_MISHU_SECRET_MAIL_1']])
  assert.match(view.github.token.text, /在小秘书的设置页填一个 token/)
  await assert.rejects(api['/github/token/save']!({ lang: 'en', token: FAKE_TOKEN }), /Cannot save it/)
})

test('without a keychain, secrets go to a file only your account can read', posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mishu-secrets-'))
  const path = join(dir, 'notebook', 'secrets.json')
  const file = new FileSecrets(path)
  const store = new KeychainOrFile(new MemorySecrets(NO_KEYCHAIN), file)
  assert.deepEqual(await store.status(), { available: true, file: { path, why: NO_KEYCHAIN } })

  await store.set('mail:1', 'app-password-1')
  await store.set(GITHUB_SECRET, FAKE_TOKEN)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, 'notebook')).mode & 0o777, 0o700)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, secrets: { 'mail:1': 'app-password-1', github: FAKE_TOKEN } })
  assert.equal(await store.get('mail:1'), 'app-password-1')
  await store.delete('mail:1')
  assert.equal(await store.get('mail:1'), undefined)

  chmodSync(path, 0o644)
  assert.equal(await file.get(GITHUB_SECRET), FAKE_TOKEN)
  assert.equal(statSync(path).mode & 0o777, 0o600, 'loosened permissions are put back')

  writeFileSync(path, '{ not json')
  await assert.rejects(store.set('mail:2', 'x'), /cannot be read .*fix or remove it/)
  assert.equal(readFileSync(path, 'utf8'), '{ not json', 'a file that cannot be read is never overwritten')
})

test('with a keychain, secrets go there and the file copy is dropped', posixOnly, async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mishu-secrets-')), 'secrets.json')
  const file = new FileSecrets(path)
  await file.set('mail:1', 'from-before-the-keychain')
  const keychain = new MemorySecrets()
  const store = new KeychainOrFile(keychain, file)
  assert.deepEqual(await store.status(), { available: true })
  assert.equal(await store.get('mail:1'), 'from-before-the-keychain', 'still found in the file')
  await store.set('mail:1', 'now-in-the-keychain')
  assert.equal(await keychain.get('mail:1'), 'now-in-the-keychain')
  assert.equal(await file.get('mail:1'), undefined)
})

test('a mail account on a computer without a keychain keeps its password in the file', posixOnly, async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mishu-secrets-')), 'secrets.json')
  const secrets = new KeychainOrFile(new MemorySecrets(NO_KEYCHAIN), new FileSecrets(path))
  const runtime = new Runtime(Config({ github: { enabled: false, useGhCli: false, tokenEnv: 'DSH_MISHU_TEST_NO_TOKEN' } }), { info() {}, warn() {} }, secrets, { unread: async () => [] })
  runtime.store = MishuStore.open(':memory:')
  const api = apiHandlers(runtime, () => MAIL_NOW)
  await api['/mail/save']!({ lang: 'zh', account: { preset: 'gmail', address: 'me@example.com' }, password: 'app-password-x' })
  const { view } = await api['/settings']!({ lang: 'zh' }) as { view: { secrets: { file?: { path: string } }; accounts: Array<{ hasPassword: boolean }> } }
  assert.equal(view.secrets.file?.path, path)
  assert.deepEqual(view.accounts.map(a => a.hasPassword), [true])
  assert.equal(await runtime.mailPassword(1), 'app-password-x')
})
