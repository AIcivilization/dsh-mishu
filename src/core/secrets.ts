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

import { execFile } from 'node:child_process'

export const SERVICE = 'dsh-mishu'

export interface SecretStore {
  /** Where secrets go, for the settings page ("macOS 钥匙串"). */
  readonly kind: 'macos' | 'windows' | 'linux' | 'memory'
  available(): Promise<boolean>
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

interface RunResult { code: number; stdout: string; stderr: string }

function run(file: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
    child.stdin?.end(input ?? '')
  })
}

/** Accounts are plain ids we choose ("mail:3"); refuse anything else so they are safe in every helper. */
function checkAccount(account: string): void {
  if (!/^[\w:.-]{1,80}$/.test(account)) throw new Error(`invalid secret account: ${account}`)
}

function checkSecret(secret: string): void {
  if (secret === '' || /[\r\n]/.test(secret)) throw new Error('the password is empty or has a line break')
}

class MacKeychain implements SecretStore {
  readonly kind = 'macos' as const
  async available() { return (await run('security', ['help'])).code === 0 || (await run('security', ['list-keychains'])).code === 0 }
  async get(account: string) {
    checkAccount(account)
    const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined
  }
  async set(account: string, secret: string) {
    checkAccount(account)
    checkSecret(secret)
    // `-w` last: security prompts twice and reads both answers from stdin.
    const r = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-l', `${SERVICE} ${account}`, '-w'], `${secret}\n${secret}\n`)
    if (r.code !== 0) throw new Error(`Keychain refused to save the password (${r.stderr.trim() || r.code})`)
  }
  async delete(account: string) {
    checkAccount(account)
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
  }
}

const PS_PRELUDE = '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;'

class WindowsVault implements SecretStore {
  readonly kind = 'windows' as const
  private ps(script: string, input?: string) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PRELUDE + script], input)
  }
  async available() { return (await this.ps('exit 0')).code === 0 }
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
  async available() { return (await run('secret-tool', ['--version'])).code === 0 }
  async get(account: string) {
    checkAccount(account)
    const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account])
    return r.code === 0 && r.stdout !== '' ? r.stdout.replace(/\n$/, '') : undefined
  }
  async set(account: string, secret: string) {
    checkAccount(account)
    checkSecret(secret)
    const r = await run('secret-tool', ['store', '--label', `${SERVICE} ${account}`, 'service', SERVICE, 'account', account], secret)
    if (r.code !== 0) throw new Error(`Secret Service refused to save the password (${r.stderr.trim() || r.code})`)
  }
  async delete(account: string) {
    checkAccount(account)
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', account])
  }
}

/** For tests: secrets in memory only. */
export class MemorySecrets implements SecretStore {
  readonly kind = 'memory' as const
  private readonly map = new Map<string, string>()
  async available() { return true }
  async get(account: string) { return this.map.get(account) }
  async set(account: string, secret: string) { checkAccount(account); checkSecret(secret); this.map.set(account, secret) }
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
