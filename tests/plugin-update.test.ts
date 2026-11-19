import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  bundleEligibility, pickUpdateVersion, PluginUpdater,
  type PluginBundleLike, type PluginManagerLike, type PluginVersionLike,
} from '../src/core/plugin-update.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import { MishuStore } from '../src/core/store.ts'
import { apiHandlers } from '../src/dsh/api.ts'
import { Config } from '../src/dsh/config.ts'
import { Runtime } from '../src/dsh/runtime.ts'

const version = (v: string, over: Partial<PluginVersionLike> = {}): PluginVersionLike => ({ version: v, bundle: true, prerelease: false, ...over })

const bundle = (name: string, over: Partial<PluginBundleLike> = {}): PluginBundleLike => ({
  name, installed: true, official: false, availability: 'profile', update: 'registry', version: '1.0.0', ...over,
})

test('the version to install is the newest one that can replace what runs', () => {
  assert.equal(pickUpdateVersion([version('2.0.0'), version('1.5.0')])?.version, '2.0.0')
  assert.equal(pickUpdateVersion([version('3.0.0', { prerelease: true }), version('2.0.0')])?.version, '2.0.0', 'a prerelease is skipped')
  assert.equal(pickUpdateVersion([version('3.0.0', { deprecated: 'do not use' }), version('2.0.0')])?.version, '2.0.0', 'a deprecated version is skipped')
  assert.equal(pickUpdateVersion([version('3.0.0', { bundle: false }), version('2.0.0')])?.version, '2.0.0', 'a version with no bundle cannot replace one')
  assert.equal(pickUpdateVersion([version('3.0.0', { incompatible: { name: 'x' } }), version('2.0.0')])?.version, '2.0.0', 'a version this DSH rejects is skipped')
  assert.equal(pickUpdateVersion([version('3.0.0', { prerelease: true })]), undefined, 'nothing installable means nothing to do')
})

test('which installed bundles an update run may replace, and which it leaves alone', () => {
  assert.equal(bundleEligibility(bundle('dsh-mishu')), null, 'a registry package this profile installed is updatable')
  assert.equal(bundleEligibility(bundle('dsh-base', { official: true })), 'official', 'official bundles follow the DSH version')
  assert.equal(bundleEligibility(bundle('dsh-x', { installed: false })), 'not-installed')
  assert.equal(bundleEligibility(bundle('dsh-x', { availability: 'installation' })), 'not-installed', 'what ships with DSH is not a profile install')
  assert.equal(bundleEligibility(bundle('dsh-x', { readOnlyReason: 'management-required' })), 'read-only')
  assert.equal(bundleEligibility(bundle('dsh-x', { update: 'git' })), 'git', 'a pinned commit has no version list')
  assert.equal(bundleEligibility(bundle('dsh-x', { update: undefined })), 'no-registry-update')
})

/** A plugin manager that answers from memory and records every call. */
function fakeManager(bundles: PluginBundleLike[], lists: Record<string, Awaited<ReturnType<PluginManagerLike['listVersions']>>>, outcome?: (name: string) => unknown) {
  const calls: Array<{ name: string; to: string; registry?: string }> = []
  const manager: PluginManagerLike = {
    listBundles: async () => bundles,
    listVersions: async (name) => {
      const list = lists[name]
      if (list === undefined) throw new Error(`no list for ${name}`)
      return list
    },
    updateBundle: async (name, to, options) => {
      calls.push({ name, to, ...options?.registry === undefined ? {} : { registry: options.registry } })
      return outcome?.(name) ?? { result: { application: 'applied' } }
    },
  }
  return { manager, calls }
}

test('one run updates everything updatable, names what it skipped, and says a restart is needed', async () => {
  const { manager, calls } = fakeManager(
    [bundle('dsh-mishu', { version: '1.0.0' }), bundle('dsh-quiet', { version: '2.0.0' }), bundle('dsh-base', { official: true }), bundle('dsh-her', { update: 'git' })],
    {
      'dsh-mishu': { status: 'listed', installed: '1.0.0', registry: 'https://registry.npmjs.org/', versions: [version('1.1.0')] },
      'dsh-quiet': { status: 'listed', installed: '2.0.0', registry: 'https://registry.npmjs.org/', versions: [] },
    },
    name => (name === 'dsh-mishu' ? { result: { application: 'restart-required' } } : { result: { application: 'applied' } }),
  )
  const updater = new PluginUpdater(manager, () => 1_000)
  await updater.start()
  const report = updater.report()
  assert.deepEqual(calls, [{ name: 'dsh-mishu', to: '1.1.0', registry: 'https://registry.npmjs.org/' }])
  assert.deepEqual(report.updated, [{ name: 'dsh-mishu', from: '1.0.0', to: '1.1.0' }])
  assert.equal(report.restartNeeded, true, 'a change that waits for the next start is reported')
  assert.deepEqual(report.skipped, [
    { name: 'dsh-quiet', why: 'up-to-date' },
    { name: 'dsh-base', why: 'official' },
    { name: 'dsh-her', why: 'git' },
  ])
  assert.equal(report.running, false)
  assert.equal(report.failed.length, 0)
  assert.deepEqual([report.startedAt, report.finishedAt], [1_000, 1_000])
})

test('a refused version list, a failed install and an unreachable registry all land in the report, not in a throw', async () => {
  const bundles = [bundle('dsh-refused'), bundle('dsh-broken'), bundle('dsh-offline'), bundle('dsh-mishu', { version: '1.0.0' })]
  const calls: string[] = []
  const manager: PluginManagerLike = {
    listBundles: async () => bundles,
    listVersions: async (name) => {
      if (name === 'dsh-mishu') return { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] }
      if (name === 'dsh-refused') return { status: 'refused', problem: 'network', reason: 'offline' }
      throw new Error('boom')
    },
    updateBundle: async (name, to) => {
      calls.push(`${name}@${to}`)
      if (name === 'dsh-broken') throw new Error('pnpm exited 1')
      return { result: { application: 'applied' } }
    },
  }
  const updater = new PluginUpdater(manager)
  await updater.start()
  const report = updater.report()
  assert.deepEqual(report.skipped, [
    { name: 'dsh-refused', why: 'version-list-refused' },
    { name: 'dsh-broken', why: 'version-list-refused' },
    { name: 'dsh-offline', why: 'version-list-refused' },
  ])
  assert.deepEqual(report.updated, [{ name: 'dsh-mishu', from: '1.0.0', to: '1.1.0' }])
  assert.deepEqual(calls, ['dsh-mishu@1.1.0'])
  assert.equal(report.restartNeeded, false)
})

test('a failing update is reported with the host’s own words and does not stop the next one', async () => {
  const { manager } = fakeManager(
    [bundle('dsh-a', { version: '1.0.0' }), bundle('dsh-b', { version: '1.0.0' })],
    {
      'dsh-a': { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] },
      'dsh-b': { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] },
    },
    name => (name === 'dsh-a'
      ? { result: { application: 'failed', error: { code: 'incompatible-version', diagnostic: 'package needs dsh 0.3' } } }
      : { result: { application: 'applied' } }),
  )
  const updater = new PluginUpdater(manager)
  await updater.start()
  const report = updater.report()
  assert.deepEqual(report.failed, [{ name: 'dsh-a', error: 'package needs dsh 0.3' }])
  assert.deepEqual(report.updated.map(u => u.name), ['dsh-b'], 'a failure does not stop the run')
})

test('an install that throws is a failed package, not a crashed run', async () => {
  const { manager } = fakeManager(
    [bundle('dsh-throws', { version: '1.0.0' })],
    { 'dsh-throws': { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] } },
    () => { throw new Error('pnpm exited 1') },
  )
  const updater = new PluginUpdater(manager)
  await updater.start()
  const report = updater.report()
  assert.deepEqual(report.failed, [{ name: 'dsh-throws', error: 'pnpm exited 1' }])
  assert.deepEqual(report.updated, [])
  assert.equal(report.running, false)
  assert.equal(report.current, null)
})

test('a run already in flight is joined rather than started twice', async () => {
  let listings = 0
  const manager: PluginManagerLike = {
    listBundles: async () => { listings += 1; return [bundle('dsh-mishu', { version: '1.0.0' })] },
    listVersions: async () => ({ status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] }),
    updateBundle: async () => ({ result: { application: 'applied' } }),
  }
  const updater = new PluginUpdater(manager)
  await Promise.all([updater.start(), updater.start(), updater.start()])
  assert.equal(listings, 1, 'the same run answered every caller')
  assert.deepEqual(updater.report().updated.map(u => u.name), ['dsh-mishu'])
})

test('the page is told whether this host can update plugins, and starting without a manager is refused in words', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mishu-update-'))
  const runtime = new Runtime(Config({ home, github: { enabled: false, useGhCli: false, tokenEnv: 'DSH_MISHU_TEST_NO_TOKEN' } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  runtime.store = MishuStore.open(':memory:')
  const api = apiHandlers(runtime)
  const bare = await api['/plugins/update/info']!({ lang: 'zh' }) as { supported: boolean; why: string }
  assert.equal(bare.supported, false)
  assert.match(bare.why, /dsh plugin add/)
  await assert.rejects(api['/plugins/update']!({ lang: 'en' }), /has no plugin manager/)

  const { manager } = fakeManager([bundle('dsh-mishu', { version: '1.0.0' })], {
    'dsh-mishu': { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.2.0')] },
  })
  runtime.updater = new PluginUpdater(manager)
  const info = await api['/plugins/update/info']!({ lang: 'zh' }) as { supported: boolean; report: { running: boolean } }
  assert.equal(info.supported, true)
  assert.equal(info.report.running, false, 'nothing has run yet')
  const started = await api['/plugins/update']!({ lang: 'zh' }) as { started: boolean; report: { running: boolean } }
  assert.equal(started.started, true)
  // The run settles in the background; the page polls until it says so.
  for (let i = 0; i < 50 && (runtime.updater.report().running); i += 1) await new Promise(r => setTimeout(r, 5))
  assert.deepEqual(runtime.updater.report().updated, [{ name: 'dsh-mishu', from: '1.0.0', to: '1.2.0' }])
  const after = await api['/plugins/update/info']!({ lang: 'en' }) as { report: { updated: unknown[] } }
  assert.equal(after.report.updated.length, 1)
})

test('the shell picks the host’s plugin manager up, and the page’s board says whether the button shows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mishu-update-shell-'))
  const { manager } = fakeManager([bundle('dsh-mishu', { version: '1.0.0' })], {
    'dsh-mishu': { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] },
  })
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const scope: Record<string, unknown> = {
    logger: { info() {}, warn() {} },
    effect(fn: () => unknown) { const dispose = fn(); return dispose },
    on() {},
    tools: { register() { return () => {} } },
    commands: { register() { return () => {} } },
    connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) { routes.set(route.path, route.fetch); return () => {} } } },
    pluginManager: manager,
  }
  scope.inject = (_names: string[], cb: (ctx: unknown) => void) => cb(scope)
  const runtime = new Runtime(Config({ home, language: 'zh', github: { enabled: false, useGhCli: false, tokenEnv: 'DSH_MISHU_TEST_NO_TOKEN' } }), { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
  runtime.store = MishuStore.open(':memory:')
  const { apply } = await import('../src/dsh/plugin.ts')
  apply(scope as never, Config({ home, language: 'zh', github: { enabled: false } }), runtime)
  assert.ok(runtime.updater !== undefined, 'the host service became the page’s updater')

  const post = async (path: string, body: unknown = {}) => {
    const response = await routes.get(path)!(new Request(`http://dsh${path}`, { method: 'POST', body: JSON.stringify(body) }))
    return await response.json() as { ok: boolean; board?: { toolbar: { updateButton: boolean } }; view?: { settings: { toolbar: { updateButton: boolean } } } }
  }
  const shown = await post('/api/dsh-mishu/board', { lang: 'zh' })
  assert.equal(shown.board?.toolbar.updateButton, true, 'the button shows by default')

  const off = await post('/api/dsh-mishu/settings/save', { lang: 'zh', settings: { toolbar: { updateButton: false } } })
  assert.equal(off.view?.settings.toolbar.updateButton, false)
  const hidden = await post('/api/dsh-mishu/board', { lang: 'zh' })
  assert.equal(hidden.board?.toolbar.updateButton, false, 'turning it off hides the top-bar button')
})

test('this plugin updates last, so its own replacement cannot cut the run short', async () => {
  const { manager, calls } = fakeManager(
    [bundle('dsh-mishu', { version: '1.0.0' }), bundle('dsh-other', { version: '1.0.0' })],
    {
      'dsh-mishu': { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] },
      'dsh-other': { status: 'listed', installed: '1.0.0', registry: 'https://r/', versions: [version('1.1.0')] },
    },
  )
  const updater = new PluginUpdater(manager)
  await updater.start()
  assert.deepEqual(calls.map(c => c.name), ['dsh-other', 'dsh-mishu'])
})

test('a run that throws outright settles instead of leaving the button disabled for ever', async () => {
  const manager: PluginManagerLike = {
    listBundles: async () => { throw new Error('profile unreadable') },
    listVersions: async () => ({ status: 'refused', problem: 'unknown', reason: 'x' }),
    updateBundle: async () => ({}),
  }
  const updater = new PluginUpdater(manager)
  await updater.start()
  const report = updater.report()
  assert.equal(report.running, false)
  assert.equal(report.error, 'profile unreadable')
})
