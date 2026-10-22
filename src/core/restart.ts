/**
 * Restarting DSH after plugins were reinstalled or upgraded.
 *
 * In the desktop app, DSH runs as a child of the app's main process
 * (Electron as Node, `ELECTRON_RUN_AS_NODE=1`). The `dsh` command runs on
 * the same binary the same way, so the test is the parent: only when the
 * parent process IS this app binary is there an app to restart (from a
 * terminal the parent is a shell, and `__CFBundleIdentifier` names the
 * terminal app — never trusted). A restart asks the app to
 * quit the normal way — so it still asks first when a task is running — and
 * opens it again once it is gone. That is done by a small detached helper,
 * because this process ends with the app.
 *
 *   macOS    AppleScript `quit`, then `open -b <bundle id>`   (tested)
 *   Windows  `taskkill /PID` without /F (a close request), then the app again
 *   Linux    SIGTERM to the app, then the app again
 *
 * DSH started with the `dsh` command is not restarted from here: its web
 * address (with a new sign-in token) is printed in that terminal, which a
 * detached replacement could not reach. The page says what to do instead.
 */

import { execFileSync, spawn } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProgram } from './exec.ts'
import { bi, type Bi } from './i18n.ts'

export type RestartPlan =
  | { kind: 'macos-app'; bundleId: string; appPid: number }
  | { kind: 'desktop-app'; platform: 'win32' | 'linux'; exe: string; appPid: number }
  | { kind: 'none'; why: Bi }

export interface ProcessFacts {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  execPath: string
  ppid: number
  electron: string | undefined
  /** The parent process's executable, when it can be read. */
  parentExe: string | undefined
  /** macOS: CFBundleIdentifier from the Info.plist of the .app holding `execPath`. */
  bundleId: string | undefined
}

/** `<x>.app` holding a macOS executable, if any. */
function appBundle(execPath: string): string | undefined {
  const at = execPath.indexOf('.app/')
  return at < 0 ? undefined : execPath.slice(0, at + 4)
}

function parentExecutable(ppid: number, platform: NodeJS.Platform): string | undefined {
  try {
    if (platform === 'linux') return readlinkSync(`/proc/${ppid}/exe`)
    if (platform === 'win32') {
      const ps = findProgram('powershell')
      return ps === undefined ? undefined : execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${ppid}).Path`], { timeout: 10_000, windowsHide: true }).toString().trim()
    }
    return execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(ppid)], { timeout: 5000 }).toString().trim()
  } catch {
    return undefined
  }
}

function bundleIdOf(app: string): string | undefined {
  try {
    return execFileSync('/usr/bin/defaults', ['read', `${app}/Contents/Info`, 'CFBundleIdentifier'], { timeout: 5000 }).toString().trim()
  } catch {
    return undefined
  }
}

function here(): ProcessFacts {
  const facts: ProcessFacts = { env: process.env, platform: process.platform, execPath: process.execPath, ppid: process.ppid, electron: process.versions.electron, parentExe: undefined, bundleId: undefined }
  if (facts.electron === undefined || facts.env.ELECTRON_RUN_AS_NODE !== '1' || facts.ppid <= 1) return facts
  facts.parentExe = parentExecutable(facts.ppid, facts.platform)
  const app = facts.platform === 'darwin' ? appBundle(facts.execPath) : undefined
  if (app !== undefined) facts.bundleId = bundleIdOf(app)
  return facts
}

function samePath(a: string | undefined, b: string, platform: NodeJS.Platform): boolean {
  return a !== undefined && (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
}

const FROM_TERMINAL = bi(
  '这个 DSH 是用 dsh 命令启动的，小秘书没法替它重启：回到运行 dsh 的那个终端按 Ctrl+C，再运行同一条命令。',
  'This DSH was started with the dsh command, so the secretary cannot restart it: press Ctrl+C in the terminal running dsh, then run the same command again.',
)

/** How DSH can be restarted from here, or why it cannot. */
export function restartPlan(facts: ProcessFacts = here()): RestartPlan {
  const desktop = facts.electron !== undefined && facts.env.ELECTRON_RUN_AS_NODE === '1' && facts.ppid > 1 && samePath(facts.parentExe, facts.execPath, facts.platform)
  if (!desktop) return { kind: 'none', why: FROM_TERMINAL }
  if (facts.platform === 'darwin') {
    const bundleId = facts.bundleId ?? ''
    if (/^[\w.-]+$/.test(bundleId)) return { kind: 'macos-app', bundleId, appPid: facts.ppid }
    return { kind: 'none', why: bi('没找到桌面版的应用标识，没法替它重启。请退出 DSH 再打开。', 'Could not tell which app this is, so it cannot be restarted from here. Quit DSH and open it again.') }
  }
  if (facts.platform === 'win32' || facts.platform === 'linux') return { kind: 'desktop-app', platform: facts.platform, exe: facts.execPath, appPid: facts.ppid }
  return { kind: 'none', why: bi('这个系统上没法替桌面版重启。请退出 DSH 再打开。', 'The desktop app cannot be restarted from here on this system. Quit DSH and open it again.') }
}

/**
 * Source of the detached helper: ask the app to quit, wait until it is gone
 * (giving up quietly when you cancel the quit), open it again. Every step is
 * noted in `log`, the only account of a restart once this process is gone.
 */
export function restartHelperSource(plan: Exclude<RestartPlan, { kind: 'none' }>, log: string): string {
  const quit = plan.kind === 'macos-app'
    ? `spawnSync('/usr/bin/osascript', ['-e', ${JSON.stringify(`tell application id "${plan.bundleId}" to quit`)}], { timeout: 180000 })`
    : plan.platform === 'win32'
      ? `spawnSync('taskkill', ['/PID', String(pid)], { windowsHide: true })`
      : `process.kill(pid, 'SIGTERM')`
  const open = plan.kind === 'macos-app'
    ? `spawnSync('/usr/bin/open', ['-b', ${JSON.stringify(plan.bundleId)}])`
    : `spawn(${JSON.stringify(plan.exe)}, [], { detached: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) }).unref()`
  return [
    "const { spawn, spawnSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const pid = ${plan.appPid}`,
    `const log = ${JSON.stringify(log)}`,
    "const note = (line) => { try { fs.appendFileSync(log, new Date().toISOString() + ' ' + line + '\\n') } catch {} }",
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    "const alive = () => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }",
    'const main = async () => {',
    // Let the page receive its answer before the app starts closing.
    '  await sleep(400)',
    "  note('asking the app (pid ' + pid + ') to quit')",
    `  try { ${quit} } catch (e) { note('quit request failed: ' + (e && e.message)) }`,
    '  const until = Date.now() + 180000',
    '  while (alive() && Date.now() < until) await sleep(300)',
    "  if (alive()) { note('the app is still running (the quit was cancelled?); not reopening'); return }",
    '  await sleep(800)',
    "  note('the app has quit; opening it again')",
    `  try { ${open} } catch (e) { note('could not open the app: ' + (e && e.message)) }`,
    '  await sleep(1000)',
    '}',
    "main().catch(e => note('helper failed: ' + (e && e.stack || e)))",
  ].join('\n')
}

/** Start the helper and return where it logs. Runs with this process's Node (Electron as Node in the app). */
export function scheduleRestart(plan: Exclude<RestartPlan, { kind: 'none' }>): { log: string } {
  const log = join(tmpdir(), `dsh-mishu-restart-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`)
  const helper = spawn(process.execPath, ['-e', restartHelperSource(plan, log)], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true })
  helper.unref()
  return { log }
}
