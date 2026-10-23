import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { restartHelperSource, restartPlan, scheduleRestart, type ProcessFacts, type RestartPlan } from '../src/core/restart.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'

const APP = '/Applications/Harness.app/Contents/MacOS/Harness'
const facts = (patch: Partial<ProcessFacts>): ProcessFacts => ({ env: {}, platform: 'darwin', execPath: APP, ppid: 4242, electron: undefined, parentExe: undefined, bundleId: undefined, parentArgs: undefined, ...patch })
const inApp = { electron: '37.0.0', env: { ELECTRON_RUN_AS_NODE: '1' }, parentExe: APP, bundleId: 'com.example.harness' }

test('the desktop app restarts by quitting and reopening; DSH from a terminal says what to do instead', () => {
  const terminal = restartPlan(facts({}))
  assert.equal(terminal.kind, 'none')
  assert.match(terminal.kind === 'none' ? terminal.why.zh : '', /用 dsh 命令启动的.*Ctrl\+C/)

  assert.deepEqual(restartPlan(facts(inApp)), { kind: 'macos-app', bundleId: 'com.example.harness', appPid: 4242 })
  // The dsh command runs on the same binary with the same flag, under a shell that hands down the terminal's bundle id.
  const fromShell = restartPlan(facts({ ...inApp, parentExe: '/bin/zsh', env: { ELECTRON_RUN_AS_NODE: '1', __CFBundleIdentifier: 'com.apple.Terminal' } }))
  assert.equal(fromShell.kind, 'none', 'a shell parent is never restarted, whatever the environment says')
  assert.equal(restartPlan(facts({ ...inApp, parentExe: undefined })).kind, 'none', 'an unreadable parent is not guessed')
  assert.equal(restartPlan(facts({ ...inApp, bundleId: undefined })).kind, 'none', 'no bundle id, no guess')
  assert.equal(restartPlan(facts({ ...inApp, bundleId: 'x"; do shell script "y' })).kind, 'none', 'nothing odd reaches AppleScript')
  assert.deepEqual(restartPlan(facts({ ...inApp, platform: 'win32', execPath: 'C:\\App\\Harness.exe', parentExe: 'c:\\app\\harness.exe' })), { kind: 'desktop-app', platform: 'win32', exe: 'C:\\App\\Harness.exe', appPid: 4242 })
  assert.equal(restartPlan(facts({ ...inApp, platform: 'linux', execPath: '/opt/Harness/harness', parentExe: '/opt/Harness/harness' })).kind, 'desktop-app')

  const mac = restartHelperSource({ kind: 'macos-app', bundleId: 'com.example.harness', appPid: 4242 }, '/tmp/x.log')
  new Script(mac)
  assert.ok(mac.includes(`spawnSync("/usr/bin/osascript", ['-e', "tell application id \\"com.example.harness\\" to quit"]`))
  assert.ok(mac.includes(`spawnSync("/usr/bin/open", ['-b', "com.example.harness"], { env: clean`))
  new Script(restartHelperSource({ kind: 'desktop-app', platform: 'win32', exe: 'C:\\App\\Harness.exe', appPid: 4242 }, 'C:\\x.log'))
})

test('the helper waits for the app to quit, then opens it again', { skip: process.platform === 'win32' ? 'uses sleep and a shell script' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mishu-restart-'))
  const marker = join(dir, 'reopened')
  // Orphaned like a real app (reaped by init/launchd), so a quit leaves no zombie that still looks alive.
  const appPid = Number(spawnSync('/bin/sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString().trim())
  const running = () => { try { process.kill(appPid, 0); return true } catch { return false } }
  assert.ok(running())
  const exe = join(dir, 'app.sh')
  writeFileSync(exe, `#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE" > ${JSON.stringify(marker)}\n`)
  chmodSync(exe, 0o755)
  const log = join(dir, 'restart.log')
  const r = spawnSync(process.execPath, ['-e', restartHelperSource({ kind: 'desktop-app', platform: 'linux', exe, appPid }, log)], {
    timeout: 20_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.equal(r.status, 0, String(r.stderr))
  for (let i = 0; i < 20 && !existsSync(marker); i++) await new Promise(res => setTimeout(res, 100))
  assert.equal(running(), false, 'the app was asked to quit')
  assert.equal(readFileSync(marker, 'utf8'), '\n', 'reopened, and not as Node')
  assert.match(readFileSync(log, 'utf8'), /asking the app \(pid \d+\) to quit\n.*opening the app \(attempt 1\)\n.*the app is running again/)
})

test('on macOS the helper quits, reopens without ELECTRON_RUN_AS_NODE, and checks the app is back', { skip: process.platform === 'win32' ? 'uses sleep and shell scripts' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mishu-restart-mac-'))
  const appPid = Number(spawnSync('/bin/sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString().trim())
  const opened = join(dir, 'opened')
  const script = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }
  // Stand-ins: "quit" stops the fake app; "is running" answers from what open left behind.
  const osascript = script('osascript', `case "$2" in *"to quit") kill ${appPid} ;; *"is running") [ -f ${JSON.stringify(opened)} ] && echo true || echo false ;; esac`)
  const open = script('open', `echo "run-as-node=[$ELECTRON_RUN_AS_NODE] $*" > ${JSON.stringify(opened)}`)
  const log = join(dir, 'restart.log')
  const r = spawnSync(process.execPath, ['-e', restartHelperSource({ kind: 'macos-app', bundleId: 'com.example.harness', appPid }, log, { osascript, open })], {
    timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.equal(r.status, 0, String(r.stderr))
  assert.equal(readFileSync(opened, 'utf8'), 'run-as-node=[] -b com.example.harness\n', 'the app is opened as an app, not as Node')
  assert.match(readFileSync(log, 'utf8'), /asking the app \(pid \d+\) to quit\n.*opening the app \(attempt 1\)\n.*open exited 0\n.*the app is running again\n$/)
})

test('the API restarts only where it can, and says why elsewhere', async () => {
  const runtime = new Runtime(Config({ github: { enabled: false } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  const scheduled: RestartPlan[] = []
  let plan: RestartPlan = restartPlan(facts({}))
  runtime.restarter = { plan: () => plan, schedule: (p) => { scheduled.push(p); return { log: '/tmp/x.log' } } }
  const api = apiHandlers(runtime, () => 0)
  assert.deepEqual(await api['/restart/info']!({ lang: 'en' }), { supported: false, why: 'This DSH was started with the dsh command, so the secretary cannot restart it: press Ctrl+C in the terminal running dsh, then run the same command again.' })
  await assert.rejects(api['/restart']!({ lang: 'zh' }), /Ctrl\+C/)
  assert.deepEqual(scheduled, [])

  plan = { kind: 'macos-app', bundleId: 'com.example.harness', appPid: 4242 }
  assert.deepEqual(await api['/restart/info']!({ lang: 'zh' }), { supported: true })
  assert.deepEqual(await api['/restart']!({ lang: 'zh' }), { restarting: true, log: '/tmp/x.log' })
  assert.deepEqual(scheduled, [plan])
})

test('on a dsh-vps server the gateway restarts DSH: DSH just exits, and the page reconnects', async () => {
  const gated = facts({ platform: 'linux', execPath: '/usr/bin/node', ppid: 812, env: { GATE_HOME: '/opt/dsh-vps' }, parentArgs: ['/usr/bin/node', '/opt/dsh-vps/gate/server.js'] })
  assert.deepEqual(restartPlan(gated), { kind: 'gate', gate: '/opt/dsh-vps/gate/server.js' })
  assert.equal(restartPlan({ ...gated, parentArgs: ['-bash'] }).kind, 'none', 'GATE_HOME in a shell is not the gateway')
  assert.equal(restartPlan({ ...gated, parentArgs: undefined }).kind, 'none', 'an unreadable parent is not guessed')

  let exited = 0
  assert.deepEqual(scheduleRestart({ kind: 'gate', gate: '/opt/dsh-vps/gate/server.js' }, () => { exited++ }), { reconnect: true })
  assert.equal(exited, 0, 'the page gets its answer first')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(exited, 1)

  const runtime = new Runtime(Config({ github: { enabled: false } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  runtime.restarter = { plan: () => ({ kind: 'gate', gate: '/opt/dsh-vps/gate/server.js' }), schedule: () => ({ reconnect: true }) }
  assert.deepEqual(await apiHandlers(runtime, () => 0)['/restart']!({ lang: 'zh' }), { restarting: true, reconnect: true })
})
