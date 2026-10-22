/**
 * "+AI": what to put in a new chat so the model can help you understand
 * something on the board.
 *
 * One builder for every place the button appears — a card in any column,
 * the summary, a source error, a mail provider's setup — so the wording and
 * what is shared stay consistent. The text goes into the chat's input box
 * unsent: you see exactly what would go to the model, can edit it, and
 * decide whether to send. Passwords and tokens are never included.
 */

import { buildDetail, type MatterDetail } from './board.ts'
import { sortOpen } from './brief.ts'
import type { GithubSyncReport, MarkReadMode } from './github/sync.ts'
import { MishuError, bi, decode, type Lang } from './i18n.ts'
import { presetById, type MailAccount } from './mail/account.ts'
import { mailReportKey, type MailSyncReport } from './mail/sync.ts'
import { isActive } from './matters.ts'
import { CATEGORY_LABELS, describeRepeat, occurrence, remindDay } from './recur.ts'
import type { MishuStore } from './store.ts'
import { dayOf, formatMoment } from './time.ts'

export type AskRequest =
  | { kind: 'matter'; id: number }
  | { kind: 'series'; id: number }
  | { kind: 'summary' }
  | { kind: 'github-error' }
  | { kind: 'mail-error'; accountId: number }
  | { kind: 'mail-setup'; preset: string }

export interface AskOptions {
  now: number
  lang: Lang
  markRead: MarkReadMode
  accounts: MailAccount[]
}

/** The tools the model can use in that chat, so it can look further and act only with your OK. */
function toolsHint(lang: Lang, id?: number): string {
  return lang === 'zh'
    ? `\n\n（你可以用 mishu_detail 工具查${id === undefined ? '事项' : ` #${id} `}的完整记录，用 mishu_list 看整个看板。要改状态的话先问我，我同意了再用 mishu_update。）`
    : `\n\n(You can use the mishu_detail tool to look up ${id === undefined ? 'an item' : `#${id}`} in full, and mishu_list for the whole board. Ask me before changing anything; only then use mishu_update.)`
}

function lines(label: string, value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '' : `\n${label}${value}`
}

function matterBlock(detail: MatterDetail, lang: Lang, url: string | null): string {
  const zh = lang === 'zh'
  const e = detail.explain
  let text = zh ? `【#${detail.id}】${detail.title}` : `[#${detail.id}] ${detail.title}`
  text += lines(zh ? '状态：' : 'Status: ', detail.reason)
  if (e !== null) {
    text += lines(zh ? '是什么：' : 'What: ', e.what)
    text += lines(detail.status === 'open' ? (zh ? '问题在哪：' : 'The problem: ') : (zh ? '为什么关掉：' : 'Why it was closed: '), e.why)
    text += lines(zh ? '小秘书的建议：' : "The secretary's suggestion: ", e.fix)
  }
  text += lines(zh ? '链接：' : 'Link: ', e?.link?.url ?? url)
  if (detail.did.length > 0) text += lines(zh ? '小秘书做了什么：' : 'What the secretary did: ', detail.did.join(zh ? '' : ' '))
  if (detail.messages.length > 0) {
    const shown = detail.messages.slice(0, 10)
    text += zh ? `\n相关通知（${detail.messages.length} 条）：` : `\nRelated notifications (${detail.messages.length}):`
    for (const m of shown) text += `\n- ${m.at} ${m.title}`
    if (detail.messages.length > shown.length) text += zh ? `\n- ……还有 ${detail.messages.length - shown.length} 条` : `\n- …and ${detail.messages.length - shown.length} more`
  }
  return text
}

/** One item in full, for the agent's mishu_detail tool. */
export function detailText(store: MishuStore, id: number, options: Pick<AskOptions, 'now' | 'lang' | 'markRead'>): string | undefined {
  const matter = store.matterById(id)
  const detail = buildDetail(store, id, options)
  return matter === undefined || detail === undefined ? undefined : matterBlock(detail, options.lang, matter.url)
}

export function buildAsk(store: MishuStore, request: AskRequest, options: AskOptions): string {
  const { now, lang } = options
  const zh = lang === 'zh'
  const notFound = () => new MishuError(bi('找不到要问的这一项', 'that item no longer exists'))

  switch (request.kind) {
    case 'matter': {
      const matter = store.matterById(request.id)
      const detail = buildDetail(store, request.id, { now, lang, markRead: options.markRead })
      if (matter === undefined || detail === undefined) throw notFound()
      const today = dayOf(now)
      const intro = matter.status !== 'open'
        ? (zh ? '小秘书把下面这件事关掉了，帮我看看它的判断对不对、我还需不需要做什么：' : 'The secretary closed the item below. Help me check whether that was right and whether anything is left for me to do:')
        : !isActive(matter, today)
          ? (zh ? '下面这件事我说过"明天再说"，帮我看看它要不要紧、我该什么时候处理：' : 'I put the item below off until later. Help me judge how urgent it is and when I should deal with it:')
          : (zh ? '我在小秘书看板的"要你处理"里看到下面这件事，帮我弄明白它是怎么回事、我该怎么处理：' : 'This item is under "To handle" on my secretary board. Help me understand what is going on and how to deal with it:')
      return `${intro}\n\n${matterBlock(detail, lang, matter.url)}${toolsHint(lang, matter.id)}`
    }

    case 'series': {
      const series = store.seriesById(request.id)
      if (series === undefined) throw notFound()
      const due = occurrence(series, series.nextK)
      const category = CATEGORY_LABELS[series.category][lang]
      let text = zh
        ? `这是我交代给小秘书的一件事，帮我看看需要提前准备什么、有什么容易忘的：\n\n【交代 #${series.id}】${series.title}\n类别：${category}\n重复：${describeRepeat(series, lang)}`
        : `This is something I told my secretary about. Help me see what to prepare in advance and what is easy to forget:\n\n[Series #${series.id}] ${series.title}\nCategory: ${category}\nRepeats: ${describeRepeat(series, lang)}`
      if (due !== undefined) {
        text += zh ? `\n下一次到期：${due}（${remindDay(due, series.leadDays)} 开始提醒）` : `\nNext due: ${due} (reminders from ${remindDay(due, series.leadDays)})`
      }
      text += lines(zh ? '备注：' : 'Note: ', series.note)
      return text
    }

    case 'summary': {
      const today = dayOf(now)
      const open = sortOpen(store.openMatters()).filter(m => isActive(m, today))
      if (open.length === 0) {
        return zh ? '小秘书看板上现在没有要我处理的事。帮我想想，有没有什么到期的、该续费的、该回复的事情我可能漏交代了？' : 'My secretary board has nothing for me to handle right now. Help me think: is there anything due, up for renewal or waiting for a reply that I may have forgotten to tell it about?'
      }
      let text = zh
        ? `这是小秘书看板上现在要我处理的 ${open.length} 件事。帮我排个先后，说说每件大概要多久、哪些可以合并一起做：\n`
        : `These are the ${open.length} items my secretary says need me now. Help me order them, estimate how long each takes, and spot any I can do together:\n`
      for (const m of open) {
        const detail = buildDetail(store, m.id, { now, lang, markRead: options.markRead })
        const why = detail?.explain?.why ?? ''
        const due = m.dueDay === null ? '' : (zh ? `（${m.dueDay} 到期）` : ` (due ${m.dueDay})`)
        text += `\n- #${m.id} ${decode(m.title, lang)}${due}${why === '' ? '' : (zh ? `：${why}` : `: ${why}`)}`
      }
      return text + toolsHint(lang)
    }

    case 'github-error': {
      const report = store.get<GithubSyncReport>('github.lastSync')
      const error = report?.error?.[lang] ?? (zh ? '（没有记录到错误）' : '(no error recorded)')
      return zh
        ? `小秘书同步 GitHub 通知时出错了，帮我弄明白是什么原因、怎么解决：\n\n时间：${report === undefined ? '?' : formatMoment(report.at, now)}\n报错：${error}\n\n小秘书取 GitHub token 的顺序：先读环境变量，没有就用 gh auth token（GitHub CLI 的登录）。`
        : `My secretary failed to sync GitHub notifications. Help me understand why and how to fix it:\n\nWhen: ${report === undefined ? '?' : formatMoment(report.at, now)}\nError: ${error}\n\nThe secretary gets its GitHub token from an environment variable first, then from gh auth token (the GitHub CLI login).`
    }

    case 'mail-error': {
      const account = options.accounts.find(a => a.id === request.accountId)
      if (account === undefined) throw notFound()
      const report = store.get<MailSyncReport>(mailReportKey(account.id))
      const preset = presetById(account.preset)
      const error = report?.error?.[lang] ?? (zh ? '（没有记录到错误）' : '(no error recorded)')
      return zh
        ? `小秘书收我的邮箱时出错了，帮我弄明白是什么原因、怎么解决（我不会把密码发给你）：\n\n邮箱服务商：${preset.label.zh}\nIMAP 服务器：${account.host}:${account.port}（${account.secure ? 'SSL/TLS' : '不加密'}）\n用户名：${account.user}\n报错：${error}\n\n小秘书怎么连：只读打开收件箱，用的是我在设置页填的客户端授权码。该服务商的说明：${preset.howTo.zh}`
        : `My secretary could not check my mailbox. Help me understand why and how to fix it (I will not share the password):\n\nProvider: ${preset.label.en}\nIMAP server: ${account.host}:${account.port} (${account.secure ? 'SSL/TLS' : 'no TLS'})\nUser name: ${account.user}\nError: ${error}\n\nHow it connects: read-only, with the app password I entered on the settings page. The provider's note: ${preset.howTo.en}`
    }

    case 'mail-setup': {
      const preset = presetById(request.preset)
      return zh
        ? `我想让小秘书只读地查看我的「${preset.label.zh}」收件箱，需要开通 IMAP 并拿到客户端授权码（或应用专用密码）。请一步步教我怎么做，包括在网页上点哪里、要注意什么。\n\n小秘书给的说明：${preset.howTo.zh}\nIMAP 服务器：${preset.host || '（自己填）'}:${preset.port}`
        : `I want my secretary to read my ${preset.label.en} inbox (read-only), which needs IMAP turned on and an app password. Walk me through it step by step, including where to click and what to watch out for.\n\nThe secretary's note: ${preset.howTo.en}\nIMAP server: ${preset.host || '(enter your own)'}:${preset.port}`
    }
  }
}
