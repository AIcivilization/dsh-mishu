/**
 * Passwords in the system keychain, never in a file.
 *
 *   macOS    Keychain              (`security`)
 *   Windows  Credential Locker     (PowerShell, Windows.Security.Credentials.PasswordVault)
 *   Linux    Secret Service        (`secret-tool`, from libsecret)
 *
 * Secrets travel to the helper on stdin only, never as command-line
 * arguments, which other processes on the machine could read. Everything is
 * stored under the service name "dsh-mishu".
 *
 * A computer without a usable keychain (a Linux server with no desktop,
 * say) keeps them in `secrets.json` in the notebook directory instead:
 * mode 600, so only your own system account can read it. That is how gh,
 * git and Thunderbird manage on such machines, and it is said plainly on
 * the settings page: protected by file permissions, not encrypted.
 * `secretFromEnv` remains a last resort.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findProgram, runProgram, type RunResult } from './exec.ts'
import { bi, type Bi } from './i18n.ts'

export const SERVICE = 'dsh-mishu'

/**
 * Whether secrets can be kept here, and if not, why and what to do. `file`
 * says they go to a file because the keychain could not be used.
 */
export type SecretStatus = { available: true; file?: { path: string; why: Bi } } | { available: false; why: Bi }

export interface SecretStore {
  /** Where secrets go, for the settings page ("macOS 钥匙串"). */
  readonly kind: 'macos' | 'windows' | 'linux' | 'file' | 'memory'
  status(): Promise<SecretStatus>
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

/** A helper program, found by full path so a short PATH does not hide it. */
class Helper {
  private readonly name: string
  private path: string | undefined
  constructor(name: string) { this.name = name }
  find(): string | undefined {
    this.path ??= findProgram(this.name)
    return this.path
  }
  async run(args: string[], input?: string): Promise<RunResult> {
    const path = this.find()
    if (path === undefined) return { code: 127, stdout: '', stderr: '', failure: `${this.name} not found` }
    return runProgram(path, args, input)
  }
}

const detail = (r: RunResult) => (r.stderr.trim() || r.failure || `exit ${r.code}`).slice(0, 300)

/** Accounts are plain ids we choose ("mail:3"); refuse anything else so they are safe in every helper. */
function checkAccount(account: string): void {
  if (!/^[\w:.-]{1,80}$/.test(account)) throw new Error(`invalid secret account: ${account}`)
}

function checkSecret(secret: string): void {
  if (secret === '' || /[\r\n]/.test(secret)) throw new Error('the password is empty or has a line break')
}

class MacKeychain implements SecretStore {
  readonly kind = 'macos' as const
  private readonly security = new Helper('security')
  async status(): Promise<SecretStatus> {
    const r = await this.security.run(['list-keychains'])
    if (r.code === 0) return { available: true }
    return { available: false, why: bi(`macOS 钥匙串用不了（${detail(r)}）`, `the macOS Keychain is not usable (${detail(r)})`) }
  }
  async get(account: string) {
    checkAccount(account)
    const r = await this.security.run(['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined
  }
  async set(account: string, secret: string) {
    checkAccount(account)
    checkSecret(secret)
    // `-w` last: security prompts twice and reads both answers from stdin.
    const r = await this.security.run(['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-l', `${SERVICE} ${account}`, '-w'], `${secret}\n${secret}\n`)
    if (r.code !== 0) throw new Error(`Keychain refused to save the password (${r.stderr.trim() || r.code})`)
  }
  async delete(account: string) {
    checkAccount(account)
    await this.security.run(['delete-generic-password', '-s', SERVICE, '-a', account])
  }
}

const PS_PRELUDE = '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;'

class WindowsVault implements SecretStore {
  readonly kind = 'windows' as const
  private readonly powershell = new Helper('powershell')
  private ps(script: string, input?: string) {
    return this.powershell.run(['-NoProfile', '-NonInteractive', '-Command', PS_PRELUDE + script], input)
  }
  async status(): Promise<SecretStatus> {
    if (this.powershell.find() === undefined) {
      return { available: false, why: bi('没找到 Windows PowerShell（powershell.exe），小秘书靠它使用 Windows 凭据管理器', 'Windows PowerShell (powershell.exe) was not found; the secretary uses it to reach Windows Credential Manager') }
    }
    const r = await this.ps('exit 0')
    if (r.code === 0) return { available: true }
    return { available: false, why: bi(`Windows 凭据管理器用不了（${detail(r)}）`, `Windows Credential Manager is not usable (${detail(r)})`) }
  }
  async get(account: string) {
    checkAccount(account)
    const r = await this.ps(`try{$c=$v.Retrieve('${SERVICE}','${account}');$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 3}`)
    return r.code === 0 ? r.stdout : undefined
  }
  async set(account: string, secret: string) {
    checkAccount(account)
    checkSecret(secret)
    const r = await this.ps(`$s=[Console]::In.ReadToEnd().TrimEnd([char]10,[char]13);try{$v.Remove($v.Retrieve('${SERVICE}','${account}'))}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}','${account}',$s)))`, `${secret}\n`)
    if (r.code !== 0) throw new Error(`Windows Credential Locker refused to save the password (${r.stderr.trim() || r.code})`)
  }
  async delete(account: string) {
    checkAccount(account)
    await this.ps(`try{$v.Remove($v.Retrieve('${SERVICE}','${account}'))}catch{}`)
  }
}

class SecretTool implements SecretStore {
  readonly kind = 'linux' as const
  private readonly tool = new Helper('secret-tool')
  async status(): Promise<SecretStatus> {
    if (this.tool.find() === undefined) {
      return {
        available: false,
        why: bi(
          '没找到 secret-tool。Debian/Ubuntu 装 libsecret-tools（sudo apt install libsecret-tools），Fedora 装 libsecret（sudo dnf install libsecret），Arch 装 libsecret',
          'secret-tool was not found. Install libsecret-tools on Debian/Ubuntu (sudo apt install libsecret-tools), libsecret on Fedora (sudo dnf install libsecret) or Arch',
        ),
      }
    }
    // A lookup that finds nothing exits 1 quietly; a missing keyring service complains on stderr.
    const r = await this.tool.run(['lookup', 'service', SERVICE, 'account', 'probe'])
    if (r.code === 0 || (r.code === 1 && r.stderr.trim() === '' && r.failure === undefined)) return { available: true }
    return {
      available: false,
      why: bi(
        `secret-tool 连不上钥匙串服务（${detail(r)}）。要在桌面会话里运行着 GNOME Keyring 或 KWallet；没有桌面的服务器上一般没有`,
        `secret-tool cannot reach a keyring service (${detail(r)}). It needs GNOME Keyring or KWallet running in a desktop session; servers without a desktop usually have none`,
      ),
    }
  }
  async get(account: string) {
    checkAccount(account)
    const r = await this.tool.run(['lookup', 'service', SERVICE, 'account', account])
    return r.code === 0 && r.stdout !== '' ? r.stdout.replace(/\n$/, '') : undefined
  }
  async set(account: string, secret: string) {
    checkAccount(account)
    checkSecret(secret)
    const r = await this.tool.run(['store', '--label', `${SERVICE} ${account}`, 'service', SERVICE, 'account', account], secret)
    if (r.code !== 0) throw new Error(`Secret Service refused to save the password (${r.stderr.trim() || r.code})`)
  }
  async delete(account: string) {
    checkAccount(account)
    await this.tool.run(['clear', 'service', SERVICE, 'account', account])
  }
}

/** For tests: secrets in memory only; `unavailable` plays a machine without a keychain. */
export class MemorySecrets implements SecretStore {
  readonly kind = 'memory' as const
  private readonly map = new Map<string, string>()
  private readonly unavailable: Bi | undefined
  constructor(unavailable?: Bi) { this.unavailable = unavailable }
  async status(): Promise<SecretStatus> { return this.unavailable === undefined ? { available: true } : { available: false, why: this.unavailable } }
  async get(account: string) { return this.unavailable === undefined ? this.map.get(account) : undefined }
  async set(account: string, secret: string) {
    checkAccount(account)
    checkSecret(secret)
    if (this.unavailable !== undefined) throw new Error(this.unavailable.en)
    this.map.set(account, secret)
  }
  async delete(account: string) { this.map.delete(account) }
}

/** The keychain of the platform this runs on. */
export function systemSecrets(platform: NodeJS.Platform = process.platform): SecretStore {
  if (platform === 'darwin') return new MacKeychain()
  if (platform === 'win32') return new WindowsVault()
  return new SecretTool()
}

/** Fallback when no keychain is available: `DSH_MISHU_SECRET_MAIL_3` for account "mail:3". */
export function secretEnvName(account: string): string {
  return `DSH_MISHU_SECRET_${account.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
}

export function secretFromEnv(account: string): string | undefined {
  const value = process.env[secretEnvName(account)]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Secrets in one JSON file, readable by your system account only (600).
 * Written to a temporary file first and renamed, so a crash never leaves
 * half a file; a file that cannot be read is never overwritten.
 */
export class FileSecrets implements SecretStore {
  readonly kind = 'file' as const
  readonly path: string
  constructor(path: string) { this.path = path }
  async status(): Promise<SecretStatus> { return { available: true } }
  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {}
    // Put the permissions back if something loosened them.
    if (process.platform !== 'win32' && (statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) {
      throw new Error(`${this.path} cannot be read (${(error as Error).message}); fix or remove it`)
    }
    const secrets = (parsed as { secrets?: unknown }).secrets
    return typeof secrets === 'object' && secrets !== null ? { ...secrets as Record<string, string> } : {}
  }
  private write(secrets: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.path)
  }
  async get(account: string) { return this.read()[account] }
  async set(account: string, secret: string) {
    checkAccount(account)
    checkSecret(secret)
    this.write({ ...this.read(), [account]: secret })
  }
  async delete(account: string) {
    const secrets = this.read()
    if (!(account in secrets)) return
    delete secrets[account]
    this.write(secrets)
  }
}

/**
 * The keychain when it works, else the file. Reads look in both, so a
 * secret saved to the file before a keychain was set up is still found;
 * saving to the keychain removes the file's copy.
 */
export class KeychainOrFile implements SecretStore {
  private readonly keychain: SecretStore
  private readonly file: FileSecrets
  private usable: Promise<SecretStatus> | undefined
  constructor(keychain: SecretStore, file: FileSecrets) {
    this.keychain = keychain
    this.file = file
  }
  get kind() { return this.keychain.kind }
  private keychainStatus(): Promise<SecretStatus> {
    // Asked once per run: a missing helper does not appear while DSH runs.
    this.usable ??= this.keychain.status().catch((error: Error) => ({ available: false as const, why: bi(error.message, error.message) }))
    return this.usable
  }
  async status(): Promise<SecretStatus> {
    const keychain = await this.keychainStatus()
    return keychain.available ? keychain : { available: true, file: { path: this.file.path, why: keychain.why } }
  }
  async get(account: string) {
    if ((await this.keychainStatus()).available) {
      const stored = await this.keychain.get(account)
      if (stored !== undefined) return stored
    }
    return this.file.get(account)
  }
  async set(account: string, secret: string) {
    if ((await this.keychainStatus()).available) {
      await this.keychain.set(account, secret)
      await this.file.delete(account)
    } else {
      await this.file.set(account, secret)
    }
  }
  async delete(account: string) {
    if ((await this.keychainStatus()).available) await this.keychain.delete(account)
    await this.file.delete(account)
  }
}
