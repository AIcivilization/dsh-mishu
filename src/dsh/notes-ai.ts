/**
 * Organising a note, when this Host has a model and you asked for it.
 *
 * The secretary's own standing rule is that the board never leaves the
 * computer: nothing here runs unless the note tab's "let AI organise" is on,
 * and the rule layer (`notes/rules.ts`) already places what it can without
 * asking anyone. So this file is the *second* opinion, never the first.
 *
 * Two things it will not do:
 *
 *   - **Touch your words.** The prompt says so and `applyOrganise` only writes
 *     the AI fields; there is no code path from a model result to `text`.
 *   - **Run unbounded.** One queue, one call at a time — parallel calls to the
 *     same provider just hit a rate limit, and a note's trim is cheap.
 *
 * Without `ctx.llm`, or before a model has been chosen, the queue never
 * starts. That is a state, not an error: notes stay exactly as you wrote them.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  applyOrganise, markOrganiseFailed, noteTitle, normalizeOrganise, noteView, pendingNotes,
  type NoteView,
} from '../core/notes/note.ts'
import { NOTE_CATEGORIES } from '../core/notes/rules.ts'
import { bi, type Lang } from '../core/i18n.ts'
import type { MishuStore, Note } from '../core/store.ts'

/** One note's trim is a small answer; 800 tokens is generous and cheap. */
const MAX_TOKENS = 800
/** How many notes one pass looks at, and how much of each goes into the prompt. */
const PROMPT_BODY_CHARS = 1200
const PROMPT_NEIGHBOURS = 6

interface StreamChunk {
  type?: string
  delta?: string
  text?: string
}

interface LlmContext {
  llm: {
    stream(options: Record<string, unknown>): AsyncIterable<StreamChunk>
  }
  agentDefaultModel?: { currentSelection(): { provider?: string; model?: string } }
  logger: { info(message: string): void; warn(message: string): void }
}

/**
 * The prompt. Two things it is emphatic about, because both failed before:
 * the original words are not to be repeated back rewritten, and an empty list
 * is the right answer when there is nothing to add. "Fill the blank" is how a
 * model starts inventing, so it is named as the worse outcome.
 */
export function buildPrompt(note: Note, neighbours: readonly Note[]): string {
  const categories = NOTE_CATEGORIES.join('、')
  const near = neighbours.length === 0
    ? '（无）'
    : neighbours.map(item => `- [${item.id}] ${noteTitle(item) || item.text.slice(0, 40)}`).join('\n')
  return [
    '你是便签整理员。用户随手写下一句话，你要把它变成一条结构化的便签。',
    '',
    '规则：',
    '1. 不改写原文，一个字都不能动。你只产出结构。',
    '2. title 不超过 20 字，用用户自己的说法，不要造词。',
    `3. category 只能从这六个里选一个：${categories}`,
    '4. points 是原文里没明说但显然成立的补充，1-3 条。宁少勿多，',
    '   想不出来就返回空数组 —— 编一条比空着糟糕得多。',
    '5. todos 只抽原文里真的包含的行动项。原文没有就返回 []。',
    '6. dueHint 只在原文明确提到时间时填（"明天""下周三""月底前"），',
    '   模糊的"以后"不算。没有就返回 null。',
    '7. 只输出 JSON，不要 markdown 代码块，不要解释。',
    '',
    '输出格式：',
    '{"title": "...", "category": "...", "points": [], "todos": [], "dueHint": null}',
    '',
    '已有便签（判断是否在讲同一件事时参考，不要合并）：',
    near,
    '',
    '要整理的便签原文：',
    '"""',
    note.text.slice(0, PROMPT_BODY_CHARS),
    '"""',
  ].join('\n')
}

/**
 * Pull the JSON object out of whatever the model said.
 *
 * Models wrap JSON in code fences and add a sentence before it often enough
 * that returning null here would waste the call. Braces are matched rather
 * than a greedy regex, so a `}` inside a string does not cut it short.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i += 1) {
    const char = body[i]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1)) as unknown
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export interface Organiser {
  /** True when a model is configured and reachable enough to try. */
  available(): boolean
  /** Organise one note now; throws a sentence the user can read. */
  organise(id: string, lang: Lang): Promise<NoteView>
  /** Note every `pending` note, one at a time. Safe to call repeatedly. */
  drain(store: MishuStore, lang: Lang): Promise<void>
  /** Stop the queue; called when the plugin goes away. */
  stop(): void
}

export interface OrganiserDeps {
  store(): MishuStore | undefined
  lang(): Lang
  logger: { info(message: string): void; warn(message: string): void }
  now(): number
  /** Read the setting; the queue and the button both honour it. */
  enabled(): boolean
}

/**
 * A queue that lives as long as the plugin does.
 *
 * `attach` is called from a `ctx.inject(['llm'], …)`, so on a Host without the
 * service the organiser keeps answering "no model" and nothing else changes.
 */
export function createOrganiser(ctx: Context, deps: OrganiserDeps): Organiser {
  let llm: LlmContext['llm'] | undefined
  let selection: LlmContext['agentDefaultModel'] | undefined
  let running: Promise<void> | undefined
  let stopped = false

  const log = deps.logger

  const attach = (scope: LlmContext): void => {
    llm = scope.llm
    selection = scope.agentDefaultModel
    log.info('dsh-mishu: notes can be organised by the model')
    // Anything left `pending` from a previous run is picked up now, so a restart
    // mid-organise does not strand a note without a badge for ever.
    const store = deps.store()
    if (store !== undefined && deps.enabled()) void organiser.drain(store, deps.lang()).catch(() => undefined)
  }

  /**
   * The model to call: whichever one the conversation is using.
   *
   * Not a list of fallbacks. A hardcoded substitute would quietly send your note
   * to a different provider than the one you picked, which is precisely the
   * thing the secretary's privacy table promises will not happen — so when
   * there is no selection, the answer is "no model", not "try another".
   */
  const pickModel = (): { provider: string; model: string } | undefined => {
    const current = selection?.currentSelection()
    if (current?.provider === undefined || current.model === undefined) return undefined
    if (current.provider === '' || current.model === '') return undefined
    return { provider: current.provider, model: current.model }
  }

  const organiser: Organiser = {
    available: () => llm !== undefined && pickModel() !== undefined,

    async organise(id: string, lang: Lang): Promise<NoteView> {
      const store = deps.store()
      if (store === undefined) throw new Error(bi('记事本没有打开', 'the notebook is not open')[lang])
      const note = store.noteById(id)
      if (note === undefined) throw new Error(bi('这条便签不在了', 'that note is gone')[lang])
      const target = pickModel()
      if (llm === undefined || target === undefined) {
        markOrganiseFailed(store, id, deps.now(), 'no-model')
        throw new Error(bi(
          '没有选中的模型，没法整理。原文照常保存。',
          'No model is selected, so nothing was organised. Your note is saved as written.',
        )[lang])
      }

      const neighbours = store.liveNotes(PROMPT_NEIGHBOURS + 5).filter(item => item.id !== id).slice(0, PROMPT_NEIGHBOURS)
      const at = deps.now()
      let answer = ''
      try {
        const chunks: StreamChunk[] = []
        for await (const chunk of llm.stream({
          provider: target.provider,
          model: target.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(note, neighbours) }] }],
          maxTokens: MAX_TOKENS,
          purpose: 'mishu-note-organise',
        })) {
          chunks.push(chunk)
        }
        answer = chunks.map(chunk => chunk.delta ?? chunk.text ?? '').join('')
      } catch (error) {
        markOrganiseFailed(store, id, at, (error as Error).message)
        throw new Error(bi(
          `整理没成功：${(error as Error).message}`,
          `Organising did not work: ${(error as Error).message}`,
        )[lang])
      }

      const parsed = extractJson(answer)
      if (parsed === null) {
        markOrganiseFailed(store, id, at, 'unparsable')
        throw new Error(bi('模型没有给出能用的结果，原文没动。', 'The model did not answer with anything usable; your note is unchanged.')[lang])
      }
      const result = normalizeOrganise(parsed, note)
      const stored = applyOrganise(store, id, result, at, { model: `${target.provider}/${target.model}` })
      return noteView(store, stored, at, lang)
    },

    async drain(store: MishuStore, lang: Lang): Promise<void> {
      if (stopped || !deps.enabled() || !organiser.available()) return
      // One pass at a time: two drains would double-call every pending note.
      if (running !== undefined) return running
      running = (async () => {
        try {
          for (const note of pendingNotes(store)) {
            if (stopped || !deps.enabled()) return
            try {
              await organiser.organise(note.id, lang)
            } catch {
              // Already recorded as `failed`; one bad note must not stop the rest.
            }
          }
        } finally {
          running = undefined
        }
      })()
      return running
    },

    stop(): void {
      stopped = true
    },
  }

  ctx.inject(['llm'], (scope) => {
    attach(scope as unknown as LlmContext)
    scope.effect(() => () => {
      llm = undefined
      selection = undefined
    })
  })

  return organiser
}
