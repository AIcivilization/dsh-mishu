/**
 * The DSH shell: opens the notebook, syncs every source and ticks the
 * reminders on timers, and exposes `/mishu`, the agent tools and the page's
 * API. Shared state lives in `Runtime`.
 *
 * Everything hangs off `ctx.effect`, so disabling or uninstalling the plugin
 * stops the timers and closes the notebook. It writes only under its home
 * (and, for passwords you enter, the system keychain).
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  bi, dayOf, describeActiveSeries, mishuPaths, MishuStore, pick, renderClosed, setStatusByUser, stopSeries, tickManual,
  type Lang, type MatterStatus,
} from '../core/index.ts'
import type { MishuConfig } from './config.ts'
import { API_BASE, apiHandlers, handle } from './api.ts'
import { Runtime } from './runtime.ts'
import { ADD_TOOL, addApproval, describeChange, registerTools } from './tools.ts'

interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { rawInput: string }) => Promise<{ kind: 'success' | 'error'; text: string }>
  }): () => void
}

interface ConnectionLike {
  fetch: {
    register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch: (request: Request) => Promise<Response> }): () => void
  }
}

interface ToolsCtx {
  tools: { register(definition: unknown): unknown }
  on(event: 'tools/pre-execute', listener: (exec: { name: string; arguments: unknown }, next: () => Promise<{ kind: string }>) => Promise<unknown>): () => void
}

const TICK_MS = 10 * 60_000

const HELP = bi([
  '/mishu — 简报：要处理的、快到了的、替你关掉了什么',
  '/mishu 同步 — 立刻同步一次（GitHub 和邮箱）',
  '/mishu 完成 <编号> · /mishu 忽略 <编号> · /mishu 恢复 <编号>',
  '/mishu 已关闭 — 最近 3 天关掉的事项和理由（判错了就恢复）',
  '/mishu 交代 — 你交代过的事；/mishu 停止 <交代编号>',
  '要交代新的事，直接在对话里说，比如"护照 2027 年 3 月 10 日到期"。邮箱和其他设置在左侧栏"小秘书"页面的"设置"里。',
  '中英文命令都可以用：sync、done、dismiss、reopen、closed、series、stop。',
].join('\n'), [
  '/mishu — brief: what needs you, what is coming up, what was closed for you',
  '/mishu sync — sync now (GitHub and mail)',
  '/mishu done <id> · /mishu dismiss <id> · /mishu reopen <id>',
  '/mishu closed — items closed in the last 3 days and why (reopen any that are wrong)',
  '/mishu series — things you told me; /mishu stop <series id>',
  'To tell me something new, just say it in the chat, e.g. "my passport expires on 2027-03-10". Mail accounts and other settings are under Settings on the "Secretary" page in the left sidebar.',
  'Chinese commands work too: 同步, 完成, 忽略, 恢复, 已关闭, 交代, 停止.',
].join('\n'))

/** Command words in both languages, mapped to one verb. */
const VERBS: Record<string, string> = {
  '': 'brief', brief: 'brief', 简报: 'brief',
  sync: 'sync', 同步: 'sync',
  done: 'done', 完成: 'done',
  dismiss: 'dismiss', 忽略: 'dismiss',
  reopen: 'reopen', 恢复: 'reopen',
  closed: 'closed', 已关闭: 'closed',
  series: 'series', 交代: 'series',
  stop: 'stop', 停止: 'stop',
}

export function apply(ctx: Context, config: MishuConfig, runtime = new Runtime(config, ctx.logger)): void {
  const paths = mishuPaths(config.home)
  const say = (lang: Lang, zh: string, en: string) => pick(bi(zh, en), lang)

  ctx.effect(() => {
    runtime.store = MishuStore.open(paths.db)
    const opened = runtime.store
    const tick = () => {
      try {
        const now = Date.now()
        const created = tickManual(opened, dayOf(now), now)
        if (created.length > 0) ctx.logger.info(`dsh-mishu: ${created.length} reminder(s) due`)
      } catch (error) {
        ctx.logger.warn(`dsh-mishu: reminder tick failed (${(error as Error).message})`)
      }
    }
    tick()
    const tickTimer = setInterval(tick, TICK_MS)
    tickTimer.unref()
    const firstSync = setTimeout(() => { void runtime.syncAll() }, 20_000)
    firstSync.unref()
    const syncTimer = setInterval(() => { void runtime.syncAll() }, config.github.intervalMinutes * 60_000)
    syncTimer.unref()
    const settings = runtime.settings()
    ctx.logger.info(`dsh-mishu: notebook ${paths.db}; language ${runtime.lang()}; github ${settings.githubEnabled ? `every ${config.github.intervalMinutes} min, mark read ${settings.markRead}` : 'off'}; ${runtime.accounts().length} mail account(s); secrets in ${runtime.secrets.kind}`)
    return async () => {
      clearInterval(tickTimer)
      clearTimeout(firstSync)
      clearInterval(syncTimer)
      await Promise.race([runtime.idle(), new Promise(resolve => setTimeout(resolve, 5000).unref())])
      opened.close()
      runtime.store = undefined
    }
  })

  ctx.inject(['tools'], (toolsCtx) => {
    const scoped = toolsCtx as unknown as ToolsCtx
    void registerTools(scoped.tools, {
      store: () => runtime.store,
      leadDays: () => runtime.settings().leadDays,
      lang: () => runtime.lang(),
      brief: () => runtime.brief(),
      markRead: () => runtime.settings().markRead,
    }).catch(error => ctx.logger.warn(`dsh-mishu: tools not registered (${(error as Error).message})`))
    scoped.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind !== 'allow' || exec.name !== ADD_TOOL) return decision
      const card = addApproval(exec.arguments, runtime.settings().leadDays, Date.now())
      // Invalid arguments run and fail in execute with the reason; nothing is saved.
      if (card === undefined) return decision
      return { kind: 'ask', reason: card[runtime.lang()], displayReason: { en: card.en, zh: card.zh, 'zh-CN': card.zh } }
    })
  })

  // The page's API, on DSH's own authenticated `/api` channel.
  ctx.inject(['connection'], (webCtx) => {
    const connection = (webCtx as unknown as { connection: ConnectionLike }).connection
    for (const [path, handler] of Object.entries(apiHandlers(runtime))) {
      webCtx.effect(() => connection.fetch.register({
        path: `${API_BASE}${path}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handle(handler, request, () => runtime.fixedLang()),
      }))
    }
  })

  ctx.inject(['commands'], (commandCtx) => {
    const commands = (commandCtx as unknown as { commands: CommandsLike }).commands
    commandCtx.effect(() => commands.register({
      name: 'mishu',
      description: 'Secretary · 小秘书: brief, sync, done/dismiss/reopen items, closed items, series',
      input: { hint: '[sync|done N|dismiss N|reopen N|closed|series|stop N|help] · [同步|完成 N|忽略 N|恢复 N|已关闭|交代|停止 N|帮助]' },
      async handler(invocation) {
        const lang = runtime.lang()
        const store = runtime.store
        if (store === undefined) return { kind: 'error', text: say(lang, 'dsh-mishu：记事本没有打开', 'dsh-mishu: the notebook is not open') }
        const [word = '', arg = ''] = invocation.rawInput.trim().split(/\s+/)
        const verb = VERBS[word.toLowerCase()] ?? 'help'
        const id = Number(arg.replace(/^#/, ''))
        const validId = Number.isInteger(id) && id > 0
        const now = Date.now()
        const setStatus = (status: MatterStatus) => {
          if (!validId) return { kind: 'error' as const, text: say(lang, `用法：/mishu ${word} <编号>`, `Usage: /mishu ${word} <id>`) }
          const change = setStatusByUser(store, id, status, now)
          if (change === undefined) return { kind: 'error' as const, text: say(lang, `没有 #${id} 这一项`, `There is no item #${id}`) }
          return { kind: 'success' as const, text: describeChange(id, change.matter.title, status, change.corrected, lang) }
        }
        switch (verb) {
          case 'brief':
            return { kind: 'success', text: runtime.brief(lang) }
          case 'sync':
            await runtime.syncAll()
            return { kind: 'success', text: runtime.brief(lang) }
          case 'done':
            return setStatus('done')
          case 'dismiss':
            return setStatus('dismissed')
          case 'reopen':
            return setStatus('open')
          case 'closed':
            return { kind: 'success', text: renderClosed(store, now, lang) }
          case 'series': {
            const lines = describeActiveSeries(store, dayOf(now), lang)
            if (lines.length === 0) {
              return { kind: 'success', text: say(lang, '还没有交代过事情。在对话里说一句就行，比如"每月 15 号交房租"。', 'Nothing told yet. Just say it in the chat, e.g. "rent is due on the 15th every month".') }
            }
            return { kind: 'success', text: `${say(lang, `你交代过的事（${lines.length}）`, `Things you told me (${lines.length})`)}\n${lines.join('\n')}` }
          }
          case 'stop': {
            const series = validId ? stopSeries(store, id, now) : undefined
            return series === undefined
              ? { kind: 'error', text: say(lang, `没有交代 #${arg}`, `There is no series #${arg}`) }
              : { kind: 'success', text: say(lang, `交代 #${series.id}「${series.title}」不再提醒了。`, `Series #${series.id} "${series.title}" will not remind any more.`) }
          }
          default:
            return { kind: 'success', text: pick(HELP, lang) }
        }
      },
    }))
  })
}
