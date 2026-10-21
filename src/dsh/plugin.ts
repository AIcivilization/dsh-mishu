/**
 * The DSH shell: opens the notebook, runs the GitHub sync and the daily
 * reminder tick on timers, and exposes `/mishu` plus the agent tools.
 *
 * Everything hangs off `ctx.effect`, so disabling or uninstalling the plugin
 * stops the timers and closes the notebook. It writes only under its home.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  bi, dayOf, describeActiveSeries, detectLang, GitHubClient, mishuPaths, MishuStore, pick, renderBrief, renderClosed,
  resolveGithubToken, setStatusByUser, stopSeries, syncGithub, tickManual, type GithubSyncReport, type Lang, type MatterStatus,
} from '../core/index.ts'
import type { MishuConfig } from './config.ts'
import { API_BASE, apiHandlers, handle } from './api.ts'
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
  '/mishu 同步 — 立刻同步一次 GitHub',
  '/mishu 完成 <编号> · /mishu 忽略 <编号> · /mishu 恢复 <编号>',
  '/mishu 已关闭 — 最近 3 天关掉的事项和理由（判错了就恢复）',
  '/mishu 交代 — 你交代过的事；/mishu 停止 <交代编号>',
  '要交代新的事，直接在对话里说，比如"护照 2027 年 3 月 10 日到期"。',
  '中英文命令都可以用：sync、done、dismiss、reopen、closed、series、stop。',
].join('\n'), [
  '/mishu — brief: what needs you, what is coming up, what was closed for you',
  '/mishu sync — sync GitHub now',
  '/mishu done <id> · /mishu dismiss <id> · /mishu reopen <id>',
  '/mishu closed — items closed in the last 3 days and why (reopen any that are wrong)',
  '/mishu series — things you told me; /mishu stop <series id>',
  'To tell me something new, just say it in the chat, e.g. "my passport expires on 2027-03-10".',
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

export function apply(ctx: Context, config: MishuConfig): void {
  const paths = mishuPaths(config.home)
  const lang: Lang = config.language === 'auto' ? detectLang() : config.language
  const say = (zh: string, en: string) => pick(bi(zh, en), lang)
  let store: MishuStore | undefined
  let syncing: Promise<GithubSyncReport | undefined> | undefined

  const brief = () => {
    if (store === undefined) return say('小秘书的记事本没有打开', 'The secretary\'s notebook is not open')
    const now = Date.now()
    tickManual(store, dayOf(now), now)
    return renderBrief(store, { now, lang, upcomingDays: config.upcomingDays, github: { enabled: config.github.enabled, markRead: config.github.markRead } })
  }

  /** One GitHub sync; concurrent callers share the one in flight. */
  const syncNow = (): Promise<GithubSyncReport | undefined> => {
    if (!config.github.enabled || store === undefined) return Promise.resolve(undefined)
    const opened = store
    syncing ??= (async () => {
      const token = await resolveGithubToken(config.github.tokenEnv, config.github.useGhCli)
      if ('error' in token) {
        const report: GithubSyncReport = { at: Date.now(), notifications: 0, opened: 0, closed: 0, wouldMarkRead: 0, markedRead: 0, checkFailures: 0, apiCalls: 0, error: token.error }
        opened.set('github.lastSync', report)
        ctx.logger.warn(`dsh-mishu: ${token.error.en}`)
        return report
      }
      const report = await syncGithub({
        store: opened,
        gh: new GitHubClient({ token: token.token }),
        now: Date.now(),
        markRead: config.github.markRead,
        markReadReasons: config.github.markReadReasons,
      })
      ctx.logger.info(`dsh-mishu: github sync ${report.error?.en ?? `ok (${report.notifications} notifications, +${report.opened} open, ${report.closed} closed, ${report.apiCalls} calls)`}`)
      return report
    })().catch((error) => {
      ctx.logger.warn(`dsh-mishu: github sync failed (${(error as Error).message})`)
      return undefined
    }).finally(() => { syncing = undefined })
    return syncing
  }

  ctx.effect(() => {
    store = MishuStore.open(paths.db)
    const opened = store
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
    const firstSync = setTimeout(() => { void syncNow() }, 20_000)
    firstSync.unref()
    const syncTimer = setInterval(() => { void syncNow() }, config.github.intervalMinutes * 60_000)
    syncTimer.unref()
    ctx.logger.info(`dsh-mishu: notebook ${paths.db}; language ${lang}; github ${config.github.enabled ? `every ${config.github.intervalMinutes} min, mark read ${config.github.markRead}` : 'off'}`)
    return async () => {
      clearInterval(tickTimer)
      clearTimeout(firstSync)
      clearInterval(syncTimer)
      await Promise.race([syncing, new Promise(resolve => setTimeout(resolve, 5000).unref())])
      opened.close()
      store = undefined
    }
  })

  ctx.inject(['tools'], (toolsCtx) => {
    const scoped = toolsCtx as unknown as ToolsCtx
    void registerTools(scoped.tools, {
      store: () => store,
      leadDays: () => config.leadDays,
      lang: () => lang,
      brief,
    }).catch(error => ctx.logger.warn(`dsh-mishu: tools not registered (${(error as Error).message})`))
    scoped.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind !== 'allow' || exec.name !== ADD_TOOL) return decision
      const card = addApproval(exec.arguments, config.leadDays, Date.now())
      // Invalid arguments run and fail in execute with the reason; nothing is saved.
      if (card === undefined) return decision
      return { kind: 'ask', reason: card[lang], displayReason: { en: card.en, zh: card.zh, 'zh-CN': card.zh } }
    })
  })

  // The board page's API, on DSH's own authenticated `/api` channel.
  ctx.inject(['connection'], (webCtx) => {
    const connection = (webCtx as unknown as { connection: ConnectionLike }).connection
    const fixedLang = config.language === 'auto' ? undefined : config.language
    const handlers = apiHandlers({ store: () => store, config, fixedLang, sync: syncNow })
    for (const [path, handler] of Object.entries(handlers)) {
      webCtx.effect(() => connection.fetch.register({
        path: `${API_BASE}${path}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handle(handler, request, fixedLang),
      }))
    }
  })

  ctx.inject(['commands'], (commandCtx) => {
    const commands = (commandCtx as unknown as { commands: CommandsLike }).commands
    commandCtx.effect(() => commands.register({
      name: 'mishu',
      description: 'Secretary · 小秘书: brief, sync, done/dismiss/reopen items, closed items, series',
      input: { hint: say('[同步|完成 N|忽略 N|恢复 N|已关闭|交代|停止 N|帮助]', '[sync|done N|dismiss N|reopen N|closed|series|stop N|help]') },
      async handler(invocation) {
        if (store === undefined) return { kind: 'error', text: say('dsh-mishu：记事本没有打开', 'dsh-mishu: the notebook is not open') }
        const opened = store
        const [word = '', arg = ''] = invocation.rawInput.trim().split(/\s+/)
        const verb = VERBS[word.toLowerCase()] ?? 'help'
        const id = Number(arg.replace(/^#/, ''))
        const validId = Number.isInteger(id) && id > 0
        const now = Date.now()
        const setStatus = (status: MatterStatus) => {
          if (!validId) return { kind: 'error' as const, text: say(`用法：/mishu ${word} <编号>`, `Usage: /mishu ${word} <id>`) }
          const change = setStatusByUser(opened, id, status, now)
          if (change === undefined) return { kind: 'error' as const, text: say(`没有 #${id} 这一项`, `There is no item #${id}`) }
          return { kind: 'success' as const, text: describeChange(id, change.matter.title, status, change.corrected, lang) }
        }
        switch (verb) {
          case 'brief':
            return { kind: 'success', text: brief() }
          case 'sync':
            if (!config.github.enabled) return { kind: 'error', text: say('GitHub 没有开启（配置 github.enabled）', 'GitHub is off (config github.enabled)') }
            await syncNow()
            return { kind: 'success', text: brief() }
          case 'done':
            return setStatus('done')
          case 'dismiss':
            return setStatus('dismissed')
          case 'reopen':
            return setStatus('open')
          case 'closed':
            return { kind: 'success', text: renderClosed(opened, now, lang) }
          case 'series': {
            const lines = describeActiveSeries(opened, dayOf(now), lang)
            if (lines.length === 0) {
              return { kind: 'success', text: say('还没有交代过事情。在对话里说一句就行，比如"每月 15 号交房租"。', 'Nothing told yet. Just say it in the chat, e.g. "rent is due on the 15th every month".') }
            }
            return { kind: 'success', text: `${say(`你交代过的事（${lines.length}）`, `Things you told me (${lines.length})`)}\n${lines.join('\n')}` }
          }
          case 'stop': {
            const series = validId ? stopSeries(opened, id, now) : undefined
            return series === undefined
              ? { kind: 'error', text: say(`没有交代 #${arg}`, `There is no series #${arg}`) }
              : { kind: 'success', text: say(`交代 #${series.id}「${series.title}」不再提醒了。`, `Series #${series.id} "${series.title}" will not remind any more.`) }
          }
          default:
            return { kind: 'success', text: pick(HELP, lang) }
        }
      },
    }))
  })
}
