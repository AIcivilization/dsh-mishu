import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/dsh/config.ts'
import { apply } from '../src/dsh/plugin.ts'
import { Runtime } from '../src/dsh/runtime.ts'
import { MemorySecrets } from '../src/core/secrets.ts'
import type { MishuConfig } from '../src/dsh/config.ts'

/** Never the real keychain or a real mail server in tests. */
const offline = (config: MishuConfig) => new Runtime(config, { info() {}, warn() {} }, new MemorySecrets(), { unread: async () => [] })
import { addDays, addMonths, dayOf } from '../src/core/time.ts'

/** Due tomorrow, so it is on the list at once whatever day the tests run. */
const tomorrow = () => addDays(dayOf(Date.now()), 1)

interface ToolDef { name: string; execute: (args: unknown) => Promise<{ text: string }> }
type Listener = (exec: { name: string; arguments: unknown }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string; reason?: string }>
type Handler = (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }>

/** Just enough of a DSH context to mount the shell: inject, effect, on, tools, commands. */
function fakeDsh() {
  const disposers: Array<() => unknown> = []
  const tools: ToolDef[] = []
  const listeners: Listener[] = []
  const commands = new Map<string, Handler>()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const scope: Record<string, unknown> = {
    logger: { info() {}, warn() {} },
    effect(fn: () => unknown) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
    },
    tools: { register(def: ToolDef) { tools.push(def) } },
    commands: { register(def: { name: string; handler: Handler }) { commands.set(def.name, def.handler); return () => commands.delete(def.name) } },
    on(_event: string, listener: Listener) { listeners.push(listener) },
    connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) { routes.set(route.path, route.fetch); return () => routes.delete(route.path) } } },
  }
  scope.inject = (_names: string[], cb: (ctx: unknown) => void) => cb(scope)
  return {
    ctx: scope as unknown as Context,
    tools,
    tool: (name: string) => tools.find(t => t.name === name)!,
    preExecute: (name: string, args: unknown) => listeners[0]!({ name, arguments: args }, async () => ({ kind: 'allow' })),
    command: (raw: string) => commands.get('mishu')!({ rawInput: raw }),
    api: async (path: string, body: unknown = {}) => {
      const response = await routes.get(path)!(new Request(`http://dsh${path}`, { method: 'POST', body: JSON.stringify(body) }))
      return { status: response.status, json: await response.json() as Record<string, unknown> }
    },
    dispose: async () => { for (const d of disposers.reverse()) await d() },
  }
}

test('the shell mounts with schema defaults, gates mishu_add behind approval, and answers /mishu', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mishu-test-'))
  const dsh = fakeDsh()
  try {
    const config = Config({ home, language: 'zh', github: { enabled: false } })
    assert.equal(config.github.markRead, 'shadow', 'marking read starts in shadow mode')
    assert.equal(config.leadDays.document, 90)
    apply(dsh.ctx, config, offline(config))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(dsh.tools.map(t => t.name), ['mishu_add', 'mishu_list', 'mishu_update', 'mishu_stop'])

    const due = tomorrow()
    const args = { title: '交物业费', due, category: 'bill' }
    const gate = await dsh.preExecute('mishu_add', args)
    assert.equal(gate.kind, 'ask')
    assert.match(gate.reason!, /小秘书要记下这件事，请核对：\n事项：交物业费/)
    assert.deepEqual(await dsh.preExecute('mishu_list', {}), { kind: 'allow' }, 'other tools are not gated')

    const added = await dsh.tool('mishu_add').execute(args)
    assert.match(added.text, /记下了（交代 #1）/)

    const brief = await dsh.command('')
    assert.match(brief.text, /要处理（1）\n#1 \[交代·账单\] 交物业费/)
    assert.doesNotMatch(brief.text, /GitHub/, 'no GitHub line when it is off')

    assert.ok((await dsh.command('交代')).text.includes(`#1 交物业费 · 不重复 ${due}`), 'a one-off on the list is still in play')
    assert.match((await dsh.command('完成 1')).text, /#1 交物业费 已标为完成/)
    assert.match((await dsh.command('')).text, /要处理：没有。/)
    assert.match((await dsh.command('交代')).text, /还没有交代过事情/)
    assert.equal((await dsh.command('完成 abc')).kind, 'error')
    assert.match((await dsh.command('帮助')).text, /\/mishu 同步/)
    assert.equal((await dsh.command('同步')).kind, 'success', 'sync now covers mail too, so it runs even with GitHub off')
  } finally {
    await dsh.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('in English, the same shell speaks English and still accepts Chinese commands', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mishu-test-'))
  const dsh = fakeDsh()
  try {
    assert.equal(Config({}).language, 'auto')
    const en = Config({ home, language: 'en', github: { enabled: false } })
    apply(dsh.ctx, en, offline(en))
    await new Promise(resolve => setTimeout(resolve, 20))
    const due = tomorrow()
    const args = { title: 'Pay rent', due, repeat: 'monthly', category: 'bill' }
    const gate = await dsh.preExecute('mishu_add', args)
    assert.match(gate.reason!, /^The secretary will note this\. Please check:\nItem: Pay rent\nCategory: Bill\nRepeats: monthly on day \d+/)
    assert.match((await dsh.tool('mishu_add').execute(args)).text, /^Noted \(#1\)\./)
    assert.match((await dsh.command('')).text, /To handle \(1\)\n#1 \[Noted·Bill\] Pay rent/)
    assert.match((await dsh.command('完成 1')).text, /#1 Pay rent marked done/)
    assert.ok((await dsh.command('series')).text.includes(`#1 Pay rent · monthly on day ${Number(due.slice(8))}${Number(due.slice(8)) >= 29 ? ' (month end when shorter)' : ''}; next ${addMonths(due, 1)}`))
    assert.match((await dsh.command('help')).text, /\/mishu sync — sync now \(GitHub and mail\)/)
    await assert.rejects(dsh.tool('mishu_add').execute({ title: 'x', due: 'soon' }), /not a valid date/)
  } finally {
    await dsh.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
