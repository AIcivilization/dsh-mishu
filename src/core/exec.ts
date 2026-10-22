/**
 * Running the few helper programs the secretary uses (`security`,
 * `secret-tool`, PowerShell, `gh`).
 *
 * An app started from the Dock, the Start menu or a service manager often
 * gets a short PATH that misses where package managers put programs, so a
 * program installed with Homebrew, winget or `~/.local/bin` looks missing.
 * `findProgram` looks on PATH first, then in those usual places.
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** Node's own message when the program could not start or was killed. */
  failure?: string
}

interface Where { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string }

/** The usual install places of command-line programs, after PATH. */
export function usualDirs({ platform = process.platform, env = process.env, home = homedir() }: Where = {}): string[] {
  if (platform === 'win32') {
    const join = win32.join
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
      join(env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI'),
      join(local, 'Programs', 'GitHub CLI'),
      join(local, 'Microsoft', 'WinGet', 'Links'),
      join(home, 'scoop', 'shims'),
      join(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin'),
    ]
  }
  const join = posix.join
  const common = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', join(home, '.local', 'bin'), join(home, 'bin')]
  return platform === 'darwin'
    ? ['/opt/homebrew/bin', ...common, '/opt/local/bin']
    : [...common, '/snap/bin', '/home/linuxbrew/.linuxbrew/bin', join(home, '.linuxbrew', 'bin')]
}

/** The full path of a program, or `undefined` when it is not installed anywhere we know of. */
export function findProgram(name: string, where: Where = {}): string | undefined {
  const platform = where.platform ?? process.platform
  const env = where.env ?? process.env
  const path = platform === 'win32' ? win32 : posix
  const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const names = platform === 'win32' && !/\.\w+$/.test(name) ? [`${name}.exe`, `${name}.cmd`] : [name]
  for (const dir of [...pathDirs, ...usualDirs(where)]) {
    for (const file of names) {
      const full = path.join(dir, file)
      try {
        accessSync(full, platform === 'win32' ? constants.F_OK : constants.X_OK)
        return full
      } catch {
        // not here
      }
    }
  }
  return undefined
}

/** Run a program; `input` goes to its stdin (secrets never go on the command line). Never rejects. */
export function runProgram(file: string, args: string[], input?: string, timeout = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      const result: RunResult = { code, stdout: String(stdout), stderr: String(stderr) }
      if (error !== null && typeof (error as { code?: unknown }).code !== 'number') result.failure = error.message
      resolve(result)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}
