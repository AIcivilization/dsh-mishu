/**
 * HTTP endpoints for the page. They live on DSH's own `/api` channel
 * (`ctx.connection.fetch`), so every request has already passed DSH's browser
 * authentication and Host/Origin checks before reaching these handlers.
 *
 * Every endpoint is POST with a JSON body and answers `{ ok: true, … }` or
 * `{ ok: false, message }`. Changing endpoints answer with fresh state, so
 * the page never shows something the notebook does not have. Passwords only
 * travel inward: they go straight to the keychain, and no endpoint ever
 * returns one.
 */

import {
  describeWatchError,
  addDays, addSeries, bi, deleteFeishu, deliver, FEISHU_WEBHOOK, notifySettings, NOTIFY_REPORT_KEY, saveFeishu, saveNotifySettings, testMessage, buildAsk, buildBoard, buildDetail, dayOf, deleteGithubToken, deleteMailAccount, describeMailError, MishuError, describeSeries, detectLang, errorText, GitHubClient,
  MAIL_PRESETS, mailReportKey, NEW_TOKEN_URL, normalizePassword, providerMismatch, resolveSeries, saveGithubToken, saveMailAccount, saveSettings, secretAccount, secretEnvName,
  setStatusByUser, snoozeByUser, stopSeries, tickManual,
  type AskRequest, type BoardData, type ChannelId, type DeviceState, type NotifySettings, type Category, type Lang, type MailAccount, type MailSyncReport, type MishuStore, type SeriesInput, type UserSettings,
  deleteWatch, describeKeywords, describeWatch, parseKeywords, readWatchBody, resolveWatch, saveWatch, watchById, watchReportKey, watchSources, type WatchInput, type WatchReport, type WatchSource,
} from '../core/index.ts'
import { resolveAccount } from '../core/mail/account.ts'
import type { Runtime } from './runtime.ts'

export const API_BASE = '/api/dsh-mishu'

type Body = Record<string, unknown>
type Handler = (body: Body) => Promise<Record<string, unknown>>

class ApiError extends Error {}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function seriesInput(value: unknown): SeriesInput {
  const item = (value ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
  const int = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  return {
    title: String(item.title ?? ''),
    due: String(item.due ?? ''),
    ...text(item.repeat) === undefined ? {} : { repeat: item.repeat as SeriesInput['repeat'] },
    ...int(item.every) === undefined ? {} : { every: int(item.every)! },
    ...text(item.category) === undefined ? {} : { category: item.category as Category },
    ...int(item.leadDays) === undefined ? {} : { leadDays: int(item.leadDays)! },
    ...text(item.note) === undefined ? {} : { note: String(item.note) },
  }
}

function accountInput(value: unknown): Partial<MailAccount> {
  const a = (value ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  const out: Partial<MailAccount> = {}
  if (num(a.id) !== undefined) out.id = num(a.id)!
  if (text(a.label) !== undefined) out.label = text(a.label)!
  if (text(a.address) !== undefined) out.address = text(a.address)!
  if (text(a.preset) !== undefined) out.preset = text(a.preset)!
  if (text(a.host) !== undefined) out.host = text(a.host)!
  if (num(a.port) !== undefined) out.port = num(a.port)!
  if (typeof a.secure === 'boolean') out.secure = a.secure
  if (text(a.user) !== undefined) out.user = text(a.user)!
  if (typeof a.enabled === 'boolean') out.enabled = a.enabled
  if (num(a.sinceDays) !== undefined) out.sinceDays = num(a.sinceDays)!
  return out
}

const password = (body: Body) => (typeof body.password === 'string' && body.password !== '' ? body.password : undefined)

function watchInput(value: unknown): WatchInput {
  const w = (value ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const out: WatchInput = {}
  if (Number.isInteger(Number(w.id)) && Number(w.id) > 0) out.id = Number(w.id)
  if (text(w.label) !== undefined) out.label = text(w.label)!
  if (text(w.url) !== undefined) out.url = text(w.url)!
  if (typeof w.keywords === 'string' || Array.isArray(w.keywords)) out.keywords = w.keywords as string | string[]
  if (typeof w.enabled === 'boolean') out.enabled = w.enabled
  if (w.intervalMinutes !== undefined && w.intervalMinutes !== null && w.intervalMinutes !== '') out.intervalMinutes = Number(w.intervalMinutes)
  return out
}

/** What the settings page shows for one watch. */
function watchView(store: MishuStore, source: WatchSource, lang: Lang) {
  return {
    id: source.id,
    label: source.label,
    url: source.url,
    keywords: source.keywords.join(' '),
    enabled: source.enabled,
    intervalMinutes: source.intervalMinutes,
    status: describeWatch(store, source, lang),
    summary: describeKeywords(source, lang),
    report: store.get<WatchReport>(watchReportKey(source.id)) ?? null,
  }
}

export function apiHandlers(runtime: Runtime, clock: () => number = Date.now): Record<string, Handler> {
  const langOf = (body: Body): Lang => runtime.fixedLang() ?? detectLang(typeof body.lang === 'string' ? body.lang : undefined)
  const need = (lang: Lang) => {
    const store = runtime.store
    if (store === undefined) throw new ApiError(lang === 'zh' ? '小秘书的记事本没有打开' : 'The notebook is not open')
    return store
  }
  const board = (store: MishuStore, lang: Lang): BoardData => {
    const at = clock()
    tickManual(store, dayOf(at), at)
    const settings = runtime.settings()
    return buildBoard(store, {
      now: at, lang, github: { enabled: settings.githubEnabled, markRead: settings.markRead },
      mailAccounts: runtime.accounts(),
      watches: runtime.watches(),
    })
  }

  /** Everything the settings page shows. No secret is ever included. */
  const settingsView = async (lang: Lang) => {
    const store = need(lang)
    const token = await runtime.githubToken()
    const secrets = await runtime.secrets.status().catch((error: Error) => ({ available: false as const, why: bi(error.message, error.message) }))
    const accounts = await Promise.all(runtime.accounts().map(async a => ({
      ...a,
      hasPassword: (await runtime.mailPassword(a.id)) !== undefined,
      envName: secretEnvName(secretAccount(a.id)),
      mismatch: providerMismatch(a)?.[lang] ?? null,
      report: store.get<MailSyncReport>(mailReportKey(a.id)) ?? null,
    })))
    return {
      lang,
      settings: runtime.settings(),
      github: {
        tokenEnv: runtime.config.github.tokenEnv,
        token: 'error' in token ? { found: false, text: token.error[lang] } : { found: true, from: token.from },
        newTokenUrl: NEW_TOKEN_URL,
        deviceLogin: runtime.config.github.clientId !== '',
        lastSync: store.get('github.lastSync') ?? null,
      },
      secrets: {
        kind: runtime.secrets.kind,
        available: secrets.available,
        ...secrets.available ? {} : { why: secrets.why[lang] },
        ...secrets.available && secrets.file !== undefined ? { file: { path: secrets.file.path, why: secrets.file.why[lang] } } : {},
      },
      accounts,
      watches: watchSources(store).map(source => watchView(store, source, lang)),
      notify: {
        settings: notifySettings(store),
        channels: await Promise.all((['desktop', 'feishu'] as ChannelId[]).map(async (id) => {
          const status = await runtime.channels[id].status()
          return { id, enabled: notifySettings(store).channels[id], available: status.available, ...status.available ? {} : { why: status.why[lang] } }
        })),
        feishu: { configured: (await runtime.secrets.get(FEISHU_WEBHOOK).catch(() => undefined)) !== undefined },
        last: store.get(NOTIFY_REPORT_KEY) ?? null,
      },
      presets: MAIL_PRESETS.map(p => ({
        id: p.id, label: p.label[lang], host: p.host, port: p.port, secure: p.secure, supported: p.supported, howTo: p.howTo[lang],
        domains: p.domains, passwordLength: p.passwordLength ?? null,
        steps: p.steps.map(step => ({ text: step.text[lang], ...step.link === undefined ? {} : { link: { url: step.link.url, label: step.link.label[lang] } } })),
      })),
    }
  }

  return {
    '/board': async (body) => {
      const lang = langOf(body)
      return { board: board(need(lang), lang) }
    },

    '/sync': async (body) => {
      const lang = langOf(body)
      await runtime.syncAll()
      return { board: board(need(lang), lang) }
    },

    '/action': async (body) => {
      const lang = langOf(body)
      const store = need(lang)
      const id = Number(body.id)
      const at = clock()
      const missing = () => new ApiError(lang === 'zh' ? `没有 #${body.id} 这一项` : `There is no item #${body.id}`)
      if (!Number.isInteger(id) || id <= 0) throw missing()
      if (body.target === 'series') {
        if (body.action !== 'stop' || stopSeries(store, id, at) === undefined) throw missing()
        return { board: board(store, lang) }
      }
      switch (body.action) {
        case 'done':
        case 'dismiss':
        case 'reopen': {
          const status = body.action === 'done' ? 'done' : body.action === 'dismiss' ? 'dismissed' : 'open'
          if (setStatusByUser(store, id, status, at) === undefined) throw missing()
          break
        }
        case 'snooze': {
          const days = Number.isInteger(body.days) && Number(body.days) > 0 ? Number(body.days) : 1
          if (snoozeByUser(store, id, addDays(dayOf(at), days), at) === undefined) throw missing()
          break
        }
        case 'unsnooze':
          if (snoozeByUser(store, id, null, at) === undefined) throw missing()
          break
        default:
          throw new ApiError(lang === 'zh' ? `不认识的操作：${String(body.action)}` : `Unknown action: ${String(body.action)}`)
      }
      return { board: board(store, lang) }
    },

    '/detail': async (body) => {
      const lang = langOf(body)
      const detail = buildDetail(need(lang), Number(body.id), { now: clock(), lang, markRead: runtime.settings().markRead })
      if (detail === undefined) throw new ApiError(lang === 'zh' ? `没有 #${body.id} 这一项` : `There is no item #${body.id}`)
      return { detail }
    },

    '/preview': async (body) => {
      const lang = langOf(body)
      const resolved = resolveSeries(seriesInput(body.item), runtime.settings().leadDays)
      return { text: describeSeries(resolved, dayOf(clock()), lang) }
    },

    '/add': async (body) => {
      const lang = langOf(body)
      const store = need(lang)
      const resolved = resolveSeries(seriesInput(body.item), runtime.settings().leadDays)
      const series = addSeries(store, resolved, clock())
      return { id: series.id, board: board(store, lang) }
    },

    /** "+AI": the text for a new chat's input box, built from what the board shows. */
    '/ask': async (body) => {
      const lang = langOf(body)
      const ask = (body.ask ?? {}) as Partial<AskRequest> & Record<string, unknown>
      const kinds = ['matter', 'series', 'summary', 'github-error', 'mail-error', 'mail-setup', 'watch-error', 'watch-setup']
      if (typeof ask.kind !== 'string' || !kinds.includes(ask.kind)) throw new ApiError(lang === 'zh' ? '不认识要问什么' : 'Unknown question')
      const request = {
        kind: ask.kind,
        ...ask.id === undefined ? {} : { id: Number(ask.id) },
        ...ask.accountId === undefined ? {} : { accountId: Number(ask.accountId) },
        ...ask.preset === undefined ? {} : { preset: String(ask.preset) },
        ...ask.watchId === undefined ? {} : { watchId: Number(ask.watchId) },
        ...typeof ask.error === 'string' && ask.error !== '' ? { error: ask.error.slice(0, 1000) } : {},
      } as AskRequest
      const prompt = buildAsk(need(lang), request, { now: clock(), lang, markRead: runtime.settings().markRead, accounts: runtime.accounts() })
      return { prompt }
    },

    // ── settings ──────────────────────────────────────────

    '/settings': async (body) => ({ view: await settingsView(langOf(body)) }),

    '/settings/save': async (body) => {
      const store = need(langOf(body))
      saveSettings(store, (body.settings ?? {}) as UserSettings, clock())
      return { view: await settingsView(langOf(body)) }
    },

    '/github/test': async (body) => {
      const lang = langOf(body)
      const token = await runtime.githubToken()
      if ('error' in token) throw new ApiError(token.error[lang])
      const user = await new GitHubClient({ token: token.token }).user()
      return { login: user.login, from: token.from }
    },

    /** A pasted token: checked with GitHub, then kept in the keychain only. */
    '/github/token/save': async (body) => {
      const lang = langOf(body)
      const { login } = await saveGithubToken(runtime.secrets, typeof body.token === 'string' ? body.token : '')
      return { login, view: await settingsView(lang) }
    },

    /** "Sign in with GitHub": a code to enter on github.com; the host waits for your approval. */
    '/github/device/start': async (body) => ({ login: deviceView(await runtime.githubLogin.start(), langOf(body)) }),

    '/github/device/status': async (body) => {
      const lang = langOf(body)
      const state = runtime.githubLogin.status()
      return { login: deviceView(state, lang), ...state.state === 'done' ? { view: await settingsView(lang) } : {} }
    },

    '/github/device/cancel': async (body) => {
      runtime.githubLogin.cancel()
      return { login: deviceView(runtime.githubLogin.status(), langOf(body)) }
    },

    '/github/token/delete': async (body) => {
      await deleteGithubToken(runtime.secrets)
      return { view: await settingsView(langOf(body)) }
    },

    // ── reminders ─────────────────────────────────────────

    '/notify/save': async (body) => {
      const lang = langOf(body)
      saveNotifySettings(need(lang), (body.notify ?? {}) as Partial<NotifySettings>, clock())
      return { view: await settingsView(lang) }
    },

    /** One test message through one channel, turned on or not. */
    '/notify/test': async (body) => {
      const lang = langOf(body)
      const id = String(body.channel) as ChannelId
      const channel = runtime.channels[id]
      if (channel === undefined) throw new ApiError(lang === 'zh' ? '没有这个渠道' : 'No such channel')
      const status = await channel.status()
      if (!status.available) throw new ApiError(status.why[lang])
      const report = await deliver(need(lang), [channel], testMessage(lang), 0, clock())
      const failed = report.results.find(r => !r.ok)
      if (failed !== undefined) throw new ApiError(failed.error ?? '')
      return { sent: true }
    },

    /** A Feishu bot: tried with a first message, then kept as a secret; reminders go there from now on. */
    '/feishu/save': async (body) => {
      const lang = langOf(body)
      const store = need(lang)
      await saveFeishu(runtime.secrets, { webhook: String(body.webhook ?? ''), ...typeof body.secret === 'string' ? { secret: body.secret } : {} }, lang)
      saveNotifySettings(store, { channels: { ...notifySettings(store).channels, feishu: true } }, clock())
      return { view: await settingsView(lang) }
    },

    '/feishu/delete': async (body) => {
      const lang = langOf(body)
      const store = need(lang)
      await deleteFeishu(runtime.secrets)
      saveNotifySettings(store, { channels: { ...notifySettings(store).channels, feishu: false } }, clock())
      return { view: await settingsView(lang) }
    },

    '/mail/save': async (body) => {
      const lang = langOf(body)
      const account = await saveMailAccount(need(lang), runtime.secrets, accountInput(body.account), password(body), clock())
      return { id: account.id, view: await settingsView(lang) }
    },

    /** Try the connection without saving: the given password, or the stored one for an existing account. */
    '/mail/test': async (body) => {
      const lang = langOf(body)
      const input = accountInput(body.account)
      const draft = resolveAccount(input, input.id ?? 0)
      const typed = password(body)
      const secret = typed !== undefined ? normalizePassword(draft.preset, typed) : input.id === undefined ? undefined : await runtime.mailPassword(input.id)
      if (secret === undefined) throw new ApiError(lang === 'zh' ? '先填密码（授权码）再测试' : 'Enter the password (app password) first')
      try {
        const messages = await runtime.fetcher.unread(draft, secret, draft.sinceDays, clock())
        return { unread: messages.length }
      } catch (error) {
        // The dialog shows the provider's steps already; the error only says what went wrong.
        throw new MishuError(describeMailError(error, draft, { steps: false }))
      }
    },

    '/mail/delete': async (body) => {
      const lang = langOf(body)
      if (!await deleteMailAccount(need(lang), runtime.secrets, Number(body.id), clock())) {
        throw new ApiError(lang === 'zh' ? `没有 #${body.id} 这个邮箱账户` : `There is no mail account #${body.id}`)
      }
      return { view: await settingsView(lang) }
    },

    // ── things you watch yourself ─────────────────────────

    '/watch/save': async (body) => {
      const lang = langOf(body)
      const source = saveWatch(need(lang), watchInput(body.watch), clock())
      return { id: source.id, view: await settingsView(lang) }
    },

    /**
     * Read it once without saving: how many entries came back, and what the
     * first one is — enough to tell a feed from a login wall.
     */
    '/watch/test': async (body) => {
      const lang = langOf(body)
      const input = watchInput(body.watch)
      const source = resolveWatch(input, input.id ?? 0)
      let page: { status: number; body: string; contentType: string }
      try {
        page = await runtime.watchFetch(source.url)
      } catch (error) {
        throw new MishuError(describeWatchError(error, source))
      }
      if (page.status >= 400) throw new ApiError(lang === 'zh' ? `这个网址返回 ${page.status}` : `The address answered ${page.status}`)
      const items = readWatchBody({ body: page.body, contentType: page.contentType, url: source.url, now: clock() })
      if (items.length === 0) throw new ApiError(lang === 'zh' ? '读到了，但里面没有内容' : 'It loaded, but there was nothing in it')
      const first = items[0]!
      const words = parseKeywords(input.keywords)
      const haystack = `${first.title}\n${first.text}`.toLowerCase()
      const hit = words.find(word => haystack.includes(word))
      return {
        items: items.length,
        title: first.title.slice(0, 120),
        excerpt: first.text.slice(0, 200),
        ...words.length === 0 ? {} : { keywordHit: hit !== undefined, ...hit === undefined ? {} : { keyword: hit } },
      }
    },

    '/watch/delete': async (body) => {
      const lang = langOf(body)
      if (!deleteWatch(need(lang), Number(body.id), clock())) throw new ApiError(lang === 'zh' ? `没有 #${body.id} 这个关注` : `There is no watch #${body.id}`)
      return { view: await settingsView(lang) }
    },

    /** Look at it right now, whatever the interval says. */
    '/watch/sync': async (body) => {
      const lang = langOf(body)
      const store = need(lang)
      const source = watchById(store, Number(body.id))
      if (source === undefined) throw new ApiError(lang === 'zh' ? `没有 #${body.id} 这个关注` : `There is no watch #${body.id}`)
      const report = await runtime.syncWatchSource(source)
      if (report?.error !== undefined) throw new ApiError(report.error[lang])
      return { report: report ?? null, board: board(store, lang), view: await settingsView(lang) }
    },

    /** Whether the page's "restart DSH" button can work here, and if not, what to do instead. */
    '/restart/info': async (body) => {
      const plan = runtime.restarter.plan()
      return plan.kind === 'none' ? { supported: false, why: plan.why[langOf(body)] } : { supported: true }
    },

    '/restart': async (body) => {
      const plan = runtime.restarter.plan()
      if (plan.kind === 'none') throw new ApiError(plan.why[langOf(body)])
      return { restarting: true, ...runtime.restarter.schedule(plan) }
    },

    '/mail/sync': async (body) => {
      const lang = langOf(body)
      const account = runtime.accounts().find(a => a.id === Number(body.id))
      if (account === undefined) throw new ApiError(lang === 'zh' ? `没有 #${body.id} 这个邮箱账户` : `There is no mail account #${body.id}`)
      const report = await runtime.syncMailAccount(account)
      return { report: report ?? null, view: await settingsView(lang) }
    },
  }
}

/** The page's view of a sign-in: messages in its language. */
function deviceView(state: DeviceState, lang: Lang): Record<string, unknown> {
  return state.state === 'failed' ? { state: 'failed', message: state.message[lang] } : { ...state }
}

/** Run one handler; failures become `{ ok: false, message }` in the caller's language. */
export async function handle(handler: Handler, request: Request, fixedLang: () => Lang | undefined): Promise<Response> {
  let body: Body = {}
  try {
    const text = await request.text()
    body = text === '' ? {} : JSON.parse(text) as Body
  } catch {
    return json(400, { ok: false, message: 'invalid JSON' })
  }
  const lang = fixedLang() ?? detectLang(typeof body.lang === 'string' ? body.lang : undefined)
  try {
    return json(200, { ok: true, ...await handler(body) })
  } catch (error) {
    return json(200, { ok: false, message: errorText(error, lang) })
  }
}
