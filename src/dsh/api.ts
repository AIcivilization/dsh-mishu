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
  addDays, addSeries, buildAsk, buildBoard, buildDetail, dayOf, deleteMailAccount, describeMailError, MishuError, describeSeries, detectLang, errorText, GitHubClient,
  MAIL_PRESETS, mailReportKey, resolveGithubToken, resolveSeries, saveMailAccount, saveSettings, secretAccount, secretEnvName,
  setStatusByUser, snoozeByUser, stopSeries, tickManual,
  type AskRequest, type BoardData, type Category, type Lang, type MailAccount, type MailSyncReport, type MishuStore, type SeriesInput, type UserSettings,
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
    })
  }

  /** Everything the settings page shows. No secret is ever included. */
  const settingsView = async (lang: Lang) => {
    const store = need(lang)
    const token = await resolveGithubToken(runtime.config.github.tokenEnv, runtime.config.github.useGhCli)
    let available = false
    try { available = await runtime.secrets.available() } catch { available = false }
    const accounts = await Promise.all(runtime.accounts().map(async a => ({
      ...a,
      hasPassword: (await runtime.mailPassword(a.id)) !== undefined,
      envName: secretEnvName(secretAccount(a.id)),
      report: store.get<MailSyncReport>(mailReportKey(a.id)) ?? null,
    })))
    return {
      lang,
      settings: runtime.settings(),
      github: {
        tokenEnv: runtime.config.github.tokenEnv,
        token: 'error' in token ? { found: false, text: token.error[lang] } : { found: true, from: token.from },
        lastSync: store.get('github.lastSync') ?? null,
      },
      secrets: { kind: runtime.secrets.kind, available },
      accounts,
      presets: MAIL_PRESETS.map(p => ({ id: p.id, label: p.label[lang], host: p.host, port: p.port, secure: p.secure, supported: p.supported, howTo: p.howTo[lang] })),
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
      const kinds = ['matter', 'series', 'summary', 'github-error', 'mail-error', 'mail-setup']
      if (typeof ask.kind !== 'string' || !kinds.includes(ask.kind)) throw new ApiError(lang === 'zh' ? '不认识要问什么' : 'Unknown question')
      const request = {
        kind: ask.kind,
        ...ask.id === undefined ? {} : { id: Number(ask.id) },
        ...ask.accountId === undefined ? {} : { accountId: Number(ask.accountId) },
        ...ask.preset === undefined ? {} : { preset: String(ask.preset) },
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
      const token = await resolveGithubToken(runtime.config.github.tokenEnv, runtime.config.github.useGhCli)
      if ('error' in token) throw new ApiError(token.error[lang])
      const user = await new GitHubClient({ token: token.token }).user()
      return { login: user.login, from: token.from }
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
      const secret = password(body) ?? (input.id === undefined ? undefined : await runtime.mailPassword(input.id))
      if (secret === undefined) throw new ApiError(lang === 'zh' ? '先填密码（授权码）再测试' : 'Enter the password (app password) first')
      try {
        const messages = await runtime.fetcher.unread(draft, secret, draft.sinceDays, clock())
        return { unread: messages.length }
      } catch (error) {
        throw new MishuError(describeMailError(error, draft))
      }
    },

    '/mail/delete': async (body) => {
      const lang = langOf(body)
      if (!await deleteMailAccount(need(lang), runtime.secrets, Number(body.id), clock())) {
        throw new ApiError(lang === 'zh' ? `没有 #${body.id} 这个邮箱账户` : `There is no mail account #${body.id}`)
      }
      return { view: await settingsView(lang) }
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
