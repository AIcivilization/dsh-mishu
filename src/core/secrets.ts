/**
 * Passwords in the system keychain, never in a file.
 *
 *   macOS    Keychain              (`security`)
 *   Windows  Credential Locker     (PowerShell, Windows.Security.Credentials.PasswordVault)
 *   Linux    Secret Service        (`secret-tool`, from libsecret)
 *
 * Secrets travel to the helper on stdin only, never as command-line
 * arguments, which other processes on the machine could read. Everything is
 * stored under the service name "dsh-mishu". When no keychain is available,
 * `secretFromEnv` is the documented fallback.
 */

import { findProgram, runProgram, type RunResult } from './exec.ts'
import { bi, type Bi } from './i18n.ts'

export const SERVICE = 'dsh-mishu'

/** Whether secrets can be kept here, and if not, why and what to do. */
export type SecretStatus = { available: true } | { available: false; why: Bi }

export interface SecretStore {
  /** Where secrets go, for the settings page ("macOS 钥匙串"). */
  readonly kind: 'macos' | 'windows' | 'linux' | 'memory'
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
