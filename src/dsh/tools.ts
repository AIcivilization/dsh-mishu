/**
 * Tools for the agent in any DSH session: tell the secretary something,
 * read the list, close or reopen an item.
 *
 * `mishu_add` never saves on the model's word alone: a `tools/pre-execute`
 * listener turns every call into an approval card that shows exactly what
 * was understood (date, weekday, repeat, when reminding starts). Without an
 * approval channel DSH denies the call, so nothing is saved unseen.
 */

import {
  addSeries, CATEGORIES, dayOf, decode, describeSeries, errorText, REPEATS, resolveSeries, setStatusByUser, stopSeries, tickManual,
  type Category, type Lang, type MishuStore, type Repeat, type SeriesInput,
} from '../core/index.ts'

type DefineTool = (definition: unknown) => unknown

export async function loadDefineTool(): Promise<DefineTool> {
  try {
    const mod = await import('@deepseek-ai/dsh-tools' as string) as { defineTool?: DefineTool }
    return mod.defineTool ?? (d => d)
  } catch {
    return d => d
  }
}

const ANY_JSON = { type: 'json' } as const

const textResult = {
  schema: ANY_JSON,
  render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
}

interface AddArgs {
  title: string
  due: string
  repeat?: string
  every?: number
  category?: string
  lead_days?: number
  note?: string
}

export function toSeriesInput(args: AddArgs): SeriesInput {
  return {
    title: args.title,
    due: args.due,
    ...args.repeat === undefined ? {} : { repeat: args.repeat as Repeat },
    ...args.every === undefined ? {} : { every: args.every },
    ...args.category === undefined ? {} : { category: args.category as Category },
    ...args.lead_days === undefined ? {} : { leadDays: args.lead_days },
    ...args.note === undefined ? {} : { note: args.note },
  }
}

export const ADD_TOOL = 'mishu_add'

const ADD_DESCRIPTION = [
  'Tell the user\'s secretary (dsh-mishu) about something with a date: a deadline, a bill, a renewal, a document expiry, a birthday, or a repeating chore.',
  'Compute `due` (YYYY-MM-DD, the first due day) from today\'s date yourself. For repeating things set `repeat` and use the next upcoming occurrence as `due`.',
  'If the user\'s wording does not pin down the date (e.g. "early next month", "下个月初", "过几天"), ask them first instead of guessing.',
  'The user sees what you understood and approves it before anything is saved, so pass exactly what they said, without padding. Keep `title` in the user\'s language.',
].join(' ')

export interface ToolDeps {
  store: () => MishuStore | undefined
  leadDays: () => Record<Category, number>
  lang: () => Lang
  brief: () => string
  now?: () => number
}

/** Run a tool body; a `MishuError` reaches the model in the user's language. */
async function speak<T>(lang: Lang, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    throw new Error(errorText(error, lang))
  }
}

/** Register the secretary's tools on a DSH tools registry. */
export async function registerTools(tools: { register(definition: unknown): unknown }, deps: ToolDeps): Promise<void> {
  const defineTool = await loadDefineTool()
  const now = deps.now ?? Date.now
  const need = () => {
    const store = deps.store()
    if (store === undefined) throw new Error(deps.lang() === 'zh' ? '小秘书的记事本没有打开' : 'the secretary\'s notebook is not open')
    return store
  }

  tools.register(defineTool({
    name: ADD_TOOL,
    description: ADD_DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: 'What it is, in the user\'s words, e.g. "护照到期", "Pay rent"' },
      due: { type: 'string', required: true, description: 'First due day, YYYY-MM-DD' },
      repeat: { type: 'string', enum: [...REPEATS], description: 'none (default), weekly, monthly or yearly' },
      every: { type: 'integer', description: 'Every how many weeks/months/years (default 1), e.g. 2 for "every two years"' },
      category: { type: 'string', enum: [...CATEGORIES], description: 'document, bill, birthday, renewal or other; sets the default warning time' },
      lead_days: { type: 'integer', description: 'Days before each due day to start reminding; omit to use the category default' },
      note: { type: 'string', description: 'Optional detail worth keeping (amount, account, where to go)' },
    },
    output: textResult,
    execute: (args: AddArgs) => speak(deps.lang(), () => {
      const lang = deps.lang()
      const store = need()
      const resolved = resolveSeries(toSeriesInput(args), deps.leadDays())
      const at = now()
      const series = addSeries(store, resolved, at)
      const shown = tickManual(store, dayOf(at), at).filter(m => m.seriesId === series.id)
      const ids = shown.map(m => `#${m.id}`).join(lang === 'zh' ? '、' : ', ')
      const summary = describeSeries(resolved, dayOf(at), lang)
      if (lang === 'zh') {
        const tail = shown.length > 0 ? `已经到了提醒的时候，现在就在待处理里（${ids}）。` : '到提醒的时候会自动出现在待处理里。'
        return { text: `记下了（交代 #${series.id}）。\n${summary}\n${tail}` }
      }
      const tail = shown.length > 0 ? `It is already due for a reminder and on the list now (${ids}).` : 'It will appear on the list when its reminder day comes.'
      return { text: `Noted (#${series.id}).\n${summary}\n${tail}` }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_list',
    description: 'Show the user\'s secretary brief: what needs them now, what is coming up, and what was closed automatically and why.',
    parameters: {},
    output: textResult,
    execute: async () => ({ text: deps.brief() }),
  }))

  tools.register(defineTool({
    name: 'mishu_update',
    description: 'Mark one item on the secretary\'s list done, dismiss it, or reopen one that was closed by mistake (ids are the #numbers in the brief). Only do this when the user says so.',
    parameters: {
      id: { type: 'integer', required: true, description: 'Item number, e.g. 12 for #12' },
      action: { type: 'string', enum: ['done', 'dismiss', 'reopen'], required: true, description: 'done, dismiss, or reopen' },
    },
    output: textResult,
    execute: (args: { id: number; action: 'done' | 'dismiss' | 'reopen' }) => speak(deps.lang(), () => {
      const lang = deps.lang()
      const status = args.action === 'done' ? 'done' : args.action === 'dismiss' ? 'dismissed' : 'open'
      const change = setStatusByUser(need(), args.id, status, now())
      if (change === undefined) throw new Error(lang === 'zh' ? `没有 #${args.id} 这一项` : `there is no item #${args.id}`)
      return { text: describeChange(args.id, change.matter.title, status, change.corrected, lang) }
    }),
  }))

  tools.register(defineTool({
    name: 'mishu_stop',
    description: 'Stop a repeating item the user told the secretary about (its series #number), e.g. when they moved out and no longer pay that rent.',
    parameters: {
      series_id: { type: 'integer', required: true, description: 'The series number' },
    },
    output: textResult,
    execute: (args: { series_id: number }) => speak(deps.lang(), () => {
      const lang = deps.lang()
      const series = stopSeries(need(), args.series_id, now())
      if (series === undefined) throw new Error(lang === 'zh' ? `没有交代 #${args.series_id}` : `there is no series #${args.series_id}`)
      return {
        text: lang === 'zh'
          ? `交代 #${series.id}「${series.title}」不再提醒了。已经在待处理里的那一期不受影响。`
          : `Series #${series.id} "${series.title}" will not remind any more. An occurrence already on the list stays there.`,
      }
    }),
  }))
}

/** "#12 交房租 已标为完成" / "#12 Pay rent marked done", plus the correction note. */
export function describeChange(id: number, title: string, status: 'open' | 'done' | 'dismissed', corrected: string | undefined, lang: Lang): string {
  const name = decode(title, lang)
  if (lang === 'zh') {
    const word = status === 'done' ? '标为完成' : status === 'dismissed' ? '标为忽略' : '重新打开'
    const note = corrected === undefined ? '' : `。已记下这次纠正：「${corrected}」这条规则判错了一次`
    return `#${id} ${name} 已${word}${note}`
  }
  const word = status === 'done' ? 'marked done' : status === 'dismissed' ? 'dismissed' : 'reopened'
  const note = corrected === undefined ? '' : `. Correction recorded: the "${corrected}" rule was wrong once`
  return `#${id} ${name} ${word}${note}`
}

/** The approval card for a `mishu_add` call, or `undefined` when the arguments are invalid (execute reports why). */
export function addApproval(args: unknown, leadDays: Record<Category, number>, now: number): { zh: string; en: string } | undefined {
  try {
    const resolved = resolveSeries(toSeriesInput(args as AddArgs), leadDays)
    const today = dayOf(now)
    return {
      zh: `小秘书要记下这件事，请核对：\n${describeSeries(resolved, today, 'zh')}`,
      en: `The secretary will note this. Please check:\n${describeSeries(resolved, today, 'en')}`,
    }
  } catch {
    return undefined
  }
}
