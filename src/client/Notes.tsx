/**
 * 随手贴：记一句话，看一眼 AI 整理出来的要点，需要时投递到对话或变成提醒。
 *
 * 和看板、邮件页一样，这页不自己保管数据：每一次改动都由 Host 回答新便签，
 * 列表再按 Host 说的排。所以别处改过的便签在这里也是对的，也就不会出现
 * "本地改了、服务端没改"的那种静默分叉。
 *
 * 两个地方特意没有做：捕获时认出相似便签只提示、不合并（两条都留着，是不是
 * 同一条由人判断）；保存时只把真正动过的字段发上去（否则改个错字也会把类别
 * 标成"你手选的"，之后 AI 再也改不动它）。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { NOTES_TEXT, NOTE_CATEGORY_KEYS } from './notes-text.ts'
import { settingsApi } from './api.ts'
import type { UiLang } from './text.ts'

// ── 与 Host 的契约 ──────────────────────────────────────────

export type CategorySource = 'rule' | 'model' | 'user'
export type NoteAiState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type NoteStatus = 'live' | 'archived' | 'deleted'

/** Host 已经算好的一句话时间（「刚刚」「3 天前」），这一页不自己算时钟。 */
export interface NoteView {
  id: string
  rev: number
  text: string
  title: string
  category: string
  categorySource: CategorySource
  tags: string[]
  aiState: NoteAiState
  aiBadge: boolean
  aiStale: boolean
  aiPoints: string[]
  aiTodos: string[]
  aiDueHint: string | null
  dueDay: string | null
  seriesId: number | null
  status: NoteStatus
  createdAt: number
  updatedAt: number
  when: string
  sends: Array<{ at: number; target: string }>
}

interface Counts { live: number; archived: number; deleted: number }
interface Related { id: string; title: string; score: number }
interface Detail { id: string; note: NoteView | undefined; related: Related[] }
interface Edit { id: string; text: string; category: string; tags: string }

type Reply<T> = ({ ok: true } & T) | { ok: false; message: string }

/**
 * 和 api.ts 里那个一模一样：走 DSH 自己那路已认证的 /api，失败一律变成
 * `{ ok:false, message }`，这样每个调用点都只需要处理一种形状。
 * 写在本地是为了不动 api.ts —— 那边主 agent 正在改。
 */
async function post<T>(path: string, body: Record<string, unknown>): Promise<Reply<T>> {
  try {
    const res = await fetch(new URL(`/api/dsh-mishu${path}`, document.baseURI), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value = await res.json().catch(() => null) as Reply<T> | null
    if (value === null) return { ok: false, message: `HTTP ${res.status}` }
    return value
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 没有对话服务时的兜底；浏览器不给剪贴板权限就返回 false，由调用方说清楚。 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ── 常量与小工具 ────────────────────────────────────────────

const VIEWS = ['live', 'archived', 'deleted'] as const
type ViewId = typeof VIEWS[number]

/** 三档视图各自对应便签的哪种状态，切换档位、判断便签是否还留在这档都靠它。 */
const STATUS_OF: Record<ViewId, NoteStatus> = { live: 'live', archived: 'archived', deleted: 'deleted' }

const REPEATS = ['none', 'weekly', 'monthly', 'yearly'] as const
type Repeat = typeof REPEATS[number]

/** 服务端认的六个类别（键在 notes-text.ts 里，因为它们是数据不是文案）。 */
const CATEGORIES = NOTE_CATEGORY_KEYS

const CATEGORY_LIST = 'mishu-note-categories'

const TEXT_COLOR = 'var(--dsw-alias-label-primary, CanvasText)'
const MUTED = 'var(--dsw-alias-label-secondary, GrayText)'
const FAINT = 'var(--dsw-alias-label-tertiary, GrayText)'
const LINE = 'var(--dsw-alias-border-l3, rgba(127,127,127,.35))'
const LAYER2 = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))'
const DANGER = 'var(--dsw-alias-state-error-primary, #d14343)'

// 颜色一律走 DSH 的主题变量，内联样式只管布局，深浅色主题才跟得住。
const FIELD: CSSProperties = {
  font: 'inherit',
  fontSize: 13,
  color: TEXT_COLOR,
  background: LAYER2,
  border: `1px solid ${LINE}`,
  borderRadius: 6,
  padding: '4px 8px',
  width: '100%',
  boxSizing: 'border-box',
}
const TAG: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.7,
  color: MUTED,
  border: `1px solid ${LINE}`,
  borderRadius: 999,
  padding: '0 7px',
  whiteSpace: 'nowrap',
}
const ROW: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
const COLUMNS: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 12,
  alignItems: 'start',
}
/** 卡片本身仍是 mishu-card（圆角、描边、间距都在 styles.ts 里）。 */
const PALE: CSSProperties = { fontSize: 11, color: FAINT }

/** 投递时间按浏览器语言格式化；Host 的 `when` 只描述便签本身。 */
function stamp(at: number, locale: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 逗号分隔的标签，中英文逗号、顿号都算。 */
function splitTags(value: string): string[] {
  return value.split(/[,，、]/).map(item => item.trim()).filter(item => item !== '')
}

function editOf(note: NoteView): Edit {
  return { id: note.id, text: note.text, category: note.category, tags: note.tags.join(', ') }
}

/**
 * 卡片上那一行字：Host 给的 title，空的话退到正文第一行，再空就明说没有标题。
 * Host 那边的 title 大多已经这么兜过了，这里再兜一层是为了标题被清空之后
 * 卡片不会变成一片空白。
 */
function headingOf(note: NoteView, fallback: string): string {
  if (note.title.trim() !== '') return note.title
  const line = note.text.split(/\r?\n/).find(item => item.trim() !== '')
  return line === undefined ? fallback : line.trim()
}

// ── 页面 ────────────────────────────────────────────────────

export function MishuNotes({ lang, locale, openChat }: {
  lang: UiLang
  locale: () => string
  openChat: (prompt: string) => boolean
}) {
  const t = NOTES_TEXT[lang]

  const [view, setView] = useState<ViewId>('live')
  const [notes, setNotes] = useState<NoteView[]>([])
  const [counts, setCounts] = useState<Counts | undefined>()
  const [found, setFound] = useState<NoteView[] | undefined>()
  const [query, setQuery] = useState('')
  const [detail, setDetailState] = useState<Detail | undefined>()
  const [edit, setEdit] = useState<Edit | undefined>()
  const [remindOpen, setRemindOpen] = useState(false)
  const [duePick, setDuePick] = useState('')
  const [repeat, setRepeat] = useState<Repeat>('none')
  const [draft, setDraft] = useState('')
  const [organize, setOrganize] = useState(false)
  // 设置页里的总开关。关着时这个勾选框不该能勾：勾了也会被 Host 静默跳过，
  // 用户只会以为 AI 坏了。所以关着时禁用，并把原因写在旁边。
  const [organiseAllowed, setOrganiseAllowed] = useState(false)
  const [dup, setDup] = useState<{ id: string; title: string } | undefined>()
  const [dueSeen, setDueSeen] = useState<{ day: string; label: string } | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  // 记一条时锁住捕获按钮；详情里正在跑的那个动作是另一份状态（`acting`），
  // 免得保存一条便签把整个列表的按钮都灰掉。
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState<string | undefined>()
  // 详情读不出来时的原话；空着说明还在读。
  const [detailError, setDetailError] = useState<string | undefined>()
  // 保存被服务端拒绝后，那一句原话只对这次编辑有意义，刷新成功就收起。
  const [saveFailed, setSaveFailed] = useState(false)

  // 异步回来的详情要知道用户是不是已经换了别的便签。
  const detailRef = useRef<string | undefined>(undefined)
  const showDetail = (next: Detail | undefined) => {
    detailRef.current = next?.id
    setDetailState(next)
  }
  // 上一次由服务端填进编辑框的那份原文：和它对不上，说明用户已经动过手了。
  const seeded = useRef<{ id: string; text: string } | undefined>(undefined)

  // 「记住后让 AI 整理」是异步的：Host 先存下、再排队列。这里跟着看几眼，
  // 等它落定就停；便签换掉了、页面走了也停，免得留一串没人要的定时器。
  const followTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const stopFollow = () => {
    if (followTimer.current !== undefined) clearTimeout(followTimer.current)
    followTimer.current = undefined
  }
  useEffect(() => stopFollow, [])

  /** 一句话的结果和一句错误不能同时在屏幕上：新的那个把旧的那个顶掉。 */
  const say = (text: string) => {
    setNotice(text)
    setError(undefined)
  }
  const fail = (message: string) => {
    setError(message)
    setNotice(undefined)
  }

  const categoryName = (key: string): string => t.categoryNames[key] ?? key
  const sourceName = (note: NoteView): string =>
    note.categorySource === 'user' ? t.categoryFromUser : note.categorySource === 'model' ? t.categoryFromModel : t.categoryFromRule

  const load = useCallback(async (mode: ViewId) => {
    setLoading(true)
    const scope = mode === 'archived' ? { archived: true } : mode === 'deleted' ? { trash: true } : { trash: false, archived: false }
    const result = await post<{ notes: NoteView[]; counts: Counts }>('/note-list', { lang, ...scope })
    setLoading(false)
    if (!result.ok) {
      fail(result.message)
      return
    }
    setError(undefined)
    setNotes(result.notes)
    setCounts(result.counts)
  }, [lang])

  useEffect(() => { void load(view) }, [load, view])

  // 读一次设置：开关在别的页签里改，回到这一页时会重新读（lang 变了也读）。
  useEffect(() => {
    let live = true
    void (async () => {
      const result = await settingsApi.load(locale())
      if (!live || !result.ok) return
      const allowed = result.view.settings.notes.organise
      setOrganiseAllowed(allowed)
      // 关了就把勾去掉，否则界面上勾着、实际不整理。
      if (!allowed) setOrganize(false)
    })()
    return () => { live = false }
  }, [locale])

  /** 有词时列表换成搜索结果：300ms 防抖，过期的回答按顺序丢掉。 */
  useEffect(() => {
    // 搜索不跨废纸篓（服务端就不返回已删的），所以在那一档里干脆不搜。
    const q = view === 'deleted' ? '' : query.trim()
    if (q === '') {
      setFound(undefined)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void (async () => {
        const result = await post<{ notes: NoteView[] }>('/note-search', { lang, q, limit: 50 })
        if (!live) return
        if (!result.ok) {
          fail(result.message)
          return
        }
        setError(undefined)
        // 服务端一次搜的是所有没删的便签，而这一页是按档看的：只留下本档的。
        setFound(result.notes.filter(note => note.status === STATUS_OF[view]))
      })()
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, lang, view])

  /** 一条便签的新版本，同时落进列表、搜索结果和已打开的详情。 */
  const keep = (note: NoteView) => {
    setNotes(list => list.map(item => (item.id === note.id ? note : item)))
    setFound(list => list === undefined ? undefined : list.map(item => (item.id === note.id ? note : item)))
    setDetailState(current => (current !== undefined && current.id === note.id ? { ...current, note } : current))
  }

  const follow = (id: string, rounds: number) => {
    stopFollow()
    if (rounds <= 0) return
    followTimer.current = setTimeout(() => {
      void (async () => {
        const result = await post<{ note: NoteView; related: Related[] }>('/note-get', { lang, id })
        if (!result.ok) return
        keep(result.note)
        if (result.note.aiState === 'pending' || result.note.aiState === 'running') follow(id, rounds - 1)
      })()
    }, 1500)
  }

  const loadDetail = async (id: string) => {
    setDetailError(undefined)
    const result = await post<{ note: NoteView; related: Related[] }>('/note-get', { lang, id })
    // 用户可能已经关了详情或点了别的便签：那样这个回答就没有意义了。
    if (detailRef.current !== id) return
    if (!result.ok) {
      setDetailError(result.message)
      return
    }
    setError(undefined)
    setDetailState({ id, note: result.note, related: result.related })
    // 这一次往返里用户可能已经开始打字了，那样就别用服务端的版本盖掉他的字；
    // 判据是「编辑框里还是点开时那份原文」。用函数式更新才读得到最新的一份。
    setEdit((current) => {
      const typed = current !== undefined && current.id === result.note.id && seeded.current !== undefined
        && current.text !== seeded.current.text
      if (typed) return current
      seeded.current = { id: result.note.id, text: result.note.text }
      return editOf(result.note)
    })
    // 人已经在挑提醒的日期了就别动那一行。
    if (!remindOpen) setDuePick(result.note.dueDay ?? '')
  }

  /** 换详情时把编辑框重置成这条便签的原文（`seeded` 跟着走，见 loadDetail）。 */
  const clearEdit = () => {
    seeded.current = undefined
    setEdit(undefined)
    setDuePick('')
    setRemindOpen(false)
    setSaveFailed(false)
  }

  /** 卡片：点开了同一条就收起，点别的就换过去。 */
  const pick = (note: NoteView) => {
    if (detailRef.current === note.id) {
      showDetail(undefined)
      clearEdit()
      return
    }
    // 列表里已经有这条的内容，先填上，详情再补齐相似便签和投递历史。
    showDetail({ id: note.id, note, related: [] })
    seeded.current = { id: note.id, text: note.text }
    setEdit(editOf(note))
    setDuePick(note.dueDay ?? '')
    setRemindOpen(false)
    setSaveFailed(false)
    void loadDetail(note.id)
  }

  const openRelated = async (id: string) => {
    showDetail({ id, note: undefined, related: [] })
    clearEdit()
    await loadDetail(id)
  }

  const switchView = (next: ViewId) => {
    if (next === view) return
    setView(next)
    // 列表清空再读：否则切档的那一瞬间会拿上一档的便签当这一档的先显示出来。
    setNotes([])
    setLoading(true)
    showDetail(undefined)
    clearEdit()
    setQuery('')
    setFound(undefined)
  }

  const capture = async () => {
    const text = draft.trim()
    if (text === '') {
      fail(t.captureEmpty)
      return
    }
    setBusy(true)
    const result = await post<{
      note: NoteView
      duplicate: { id: string; title: string; score: number } | null
      due: { day: string; label: string } | null
    }>('/note-capture', { lang, text, organize })
    setBusy(false)
    if (!result.ok) {
      fail(result.message)
      return
    }
    say(t.captured(headingOf(result.note, t.noTitle)))
    setDraft('')
    setDup(result.duplicate ?? undefined)
    setDueSeen(result.due ?? undefined)
    // 新便签一定在"便签"这一档；本来就在这档时直接插到最前，省一次往返。
    setQuery('')
    setFound(undefined)
    if (view === 'live') {
      setNotes(list => [result.note, ...list])
      setCounts(current => (current === undefined ? current : { ...current, live: current.live + 1 }))
    } else {
      // 在归档或废纸篓里记的便签也一定是活的：换到"便签"这一档，顺手把列表
      // 换成只有这一条，别让上一档的便签在重新读取之前先闪一下。
      setNotes([result.note])
      setLoading(true)
      setView('live')
    }
    // 勾了「让 AI 整理」时便签先是 pending：跟几眼，等它落定，角标就不会一直转。
    if (result.note.aiState === 'pending' || result.note.aiState === 'running') follow(result.note.id, 20)
  }

  const save = async (note: NoteView) => {
    if (edit === undefined) return
    const category = edit.category.trim()
    setActing('save')
    const result = await post<{ note: NoteView }>('/note-update', {
      lang,
      id: note.id,
      // 带上你看到的那一版：别处改过了就该被拒绝，而不是把别人的改动盖掉。
      rev: note.rev,
      text: edit.text,
      // 类别原样发回去会把它标成"你手选的"，之后 AI 再也改不动，所以只发真的改过的。
      ...category !== '' && category !== note.category ? { category } : {},
      tags: splitTags(edit.tags),
    })
    setActing(undefined)
    if (!result.ok) {
      fail(result.message)
      setSaveFailed(true)
      return
    }
    keep(result.note)
    // 存进去的这份就是新的"原文"：之后详情再回来，基线也对得上。
    seeded.current = { id: result.note.id, text: result.note.text }
    setEdit(editOf(result.note))
    setSaveFailed(false)
    say(t.saved)
  }

  const organizeNow = async (note: NoteView) => {
    setActing('organize')
    const result = await post<{ note: NoteView }>('/note-organize', { lang, id: note.id })
    setActing(undefined)
    if (!result.ok) {
      // 这台 Host 没接模型时服务端就是这么说的，原话照给。
      fail(result.message)
      return
    }
    keep(result.note)
    say(t.organized)
  }

  const toSeries = async (note: NoteView, due: string, every: Repeat) => {
    setActing('remind')
    const result = await post<{ note: NoteView; seriesId: number; title: string }>('/note-to-series', {
      lang,
      id: note.id,
      ...due === '' ? {} : { due },
      repeat: every,
    })
    setActing(undefined)
    if (!result.ok) {
      fail(result.message)
      return
    }
    keep(result.note)
    setRemindOpen(false)
    say(t.reminderSet(result.title))
  }

  /**
   * 日期是猜出来的东西，所以这一行只在人点了「设为提醒」之后才出现：便签自己
   * 认出了日期就先填进去（按一下就好），没认出来就空着等人挑，不替人猜。
   * 重复方式只有在这里选得到，所以两个分支都会把这一行打开。
   */
  const startRemind = (note: NoteView) => {
    setDuePick(note.dueDay ?? '')
    setRepeat('none')
    setRemindOpen(true)
  }

  const toChat = async (note: NoteView) => {
    setActing('chat')
    const rendered = await post<{ text: string }>('/note-render', { lang, id: note.id })
    if (!rendered.ok) {
      setActing(undefined)
      fail(rendered.message)
      return
    }
    const text = rendered.text
    const opened = openChat(text)
    const target: 'new-chat' | 'clipboard' = opened ? 'new-chat' : 'clipboard'
    if (!opened && !(await copy(text))) {
      setActing(undefined)
      fail(t.copyFailed)
      return
    }
    const recorded = await post<{ note: NoteView }>('/note-record', { lang, id: note.id, target, text })
    setActing(undefined)
    if (!recorded.ok) {
      fail(recorded.message)
      return
    }
    keep(recorded.note)
    say(opened ? t.chatOpened : t.chatCopied)
  }

  const changeStatus = async (note: NoteView, status: NoteStatus) => {
    setActing(status)
    const result = await post<{ note: NoteView; counts?: Counts }>('/note-status', { lang, id: note.id, status })
    setActing(undefined)
    if (!result.ok) {
      fail(result.message)
      return
    }
    say(status === 'live' ? t.restored : status === 'archived' ? t.archived : t.deleted)
    setQuery('')
    setFound(undefined)
    // 改过的状态都不是当前这一档的，便签会从列表里走掉，详情也就没有对象了。
    if (status !== STATUS_OF[view]) {
      showDetail(undefined)
      clearEdit()
    }
    void load(view)
  }

  const purgeNow = async (note: NoteView) => {
    if (!window.confirm(t.purgeConfirm)) return
    setActing('purge')
    const result = await post<{ counts?: Counts }>('/note-purge', { lang, id: note.id })
    setActing(undefined)
    if (!result.ok) {
      fail(result.message)
      return
    }
    say(t.purged)
    showDetail(undefined)
    clearEdit()
    void load(view)
  }

  const openNote = detail?.note
  const shown = found ?? notes
  const emptyText = (): string => found !== undefined
    ? t.searchEmpty(query.trim())
    : view === 'live' ? t.emptyLive : view === 'archived' ? t.emptyArchived : t.emptyTrash

  const card = (note: NoteView) => {
    const active = detail !== undefined && detail.id === note.id
    const title = headingOf(note, t.noTitle)
    // 用 div 而不是 button：卡片里要放要点列表和标签，这些塞不进 button（button
    // 只收行内内容）。借用 mishu-card-head 的样式，鼠标悬停和键盘焦点才和看板
    // 上那些卡片一致；role/tabIndex 是 button 平时免费给的那部分，这里自己补。
    return (
      <div key={note.id} className={`mishu-card${active ? ' open' : ''}`}>
        <div
          className="mishu-card-head"
          role="button"
          tabIndex={0}
          aria-expanded={active}
          style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}
          onClick={() => pick(note)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            pick(note)
          }}
        >
          <div className="mishu-card-top">
            <span className="mishu-card-title">{title}</span>
            <span className="mishu-card-meta" style={{ flex: '0 0 auto' }}>{note.when}</span>
          </div>
          <div style={ROW}>
            <span style={TAG} title={sourceName(note)}>{categoryName(note.category)}</span>
            {note.categorySource === 'user' ? <span style={PALE} title={t.userPickedTitle}>{t.userPicked}</span> : null}
            {note.aiBadge ? <span className="mishu-ai compact" title={note.aiStale ? t.aiStaleTitle : t.aiBadgeTitle}>{t.aiBadge}</span> : null}
            {note.aiState === 'pending' || note.aiState === 'running' ? <span style={PALE}>{t.aiWorking}</span> : null}
            {note.aiTodos.length === 0 ? null : <span style={PALE}>{t.todoCount(note.aiTodos.length)}</span>}
            {note.dueDay === null ? null : <span style={PALE}>{t.dueOn(note.dueDay)}</span>}
            {note.seriesId === null ? null : <span style={PALE}>{t.isReminder}</span>}
            {note.tags.map(tag => <span key={tag} style={TAG}>{tag}</span>)}
          </div>
          {note.aiPoints.length === 0 ? null : (
            <ul style={{ margin: '2px 0 0', paddingLeft: 16, fontSize: 12, color: MUTED, whiteSpace: 'normal' }}>
              {note.aiPoints.slice(0, 2).map((point, index) => <li key={`${note.id}-${index}`}>{point}</li>)}
            </ul>
          )}
        </div>
        {/* 废纸篓里的便签只有两个去处：留着（恢复）或者真的没了。别的动作
            在那一档里都没有意义，所以卡片上就只给这两个。 */}
        {view === 'deleted' ? (
          <div style={{ ...ROW, marginTop: 4 }}>
            <button type="button" className="mishu-btn" disabled={acting !== undefined} onClick={(event) => { event.stopPropagation(); void changeStatus(note, 'live') }}>{t.restore}</button>
            <button type="button" className="mishu-btn mishu-btn-quiet" style={{ color: DANGER }} disabled={acting !== undefined} onClick={(event) => { event.stopPropagation(); void purgeNow(note) }}>{t.purge}</button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mishu-page" data-mishu-notes="">
      <div className="mishu-head">
        <div className="mishu-title">
          <h1>{t.title}</h1>
          <div className="mishu-tabs" role="tablist">
            {VIEWS.map(id => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                className={view === id ? 'active' : ''}
                onClick={() => switchView(id)}
              >
                {t.tabs[id]}
              </button>
            ))}
          </div>
        </div>
        <div className="mishu-sources">
          {counts === undefined ? null : <span>{t.count(counts.live, counts.archived, counts.deleted)}</span>}
          <button type="button" className="mishu-btn" disabled={loading} onClick={() => { void load(view) }}>{t.reload}</button>
        </div>
      </div>

      {error === undefined ? null : <div className="mishu-error">{t.failed}{error}</div>}
      {notice === undefined ? null : <div className="mishu-ok" style={{ marginBottom: 10 }}>{notice}</div>}
      {/* 认出了相似的便签：只提示，两条都留着；是不是同一条由人判断。 */}
      {dup === undefined ? null : (
        <div className="mishu-banner" style={{ ...ROW, justifyContent: 'space-between' }}>
          <span>{t.duplicateHint(dup.title)} <span style={{ color: FAINT }}>{t.duplicateNote}</span></span>
          <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => setDup(undefined)}>{t.dismiss}</button>
        </div>
      )}
      {dueSeen === undefined ? null : (
        <div className="mishu-ok" style={{ ...ROW, justifyContent: 'space-between', marginTop: 10 }}>
          <span>{t.dueSeen(dueSeen.day, dueSeen.label)}</span>
          <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => setDueSeen(undefined)}>{t.dismiss}</button>
        </div>
      )}

      <div className="mishu-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', margin: '12px 0' }}>
        <textarea
          rows={3}
          value={draft}
          placeholder={t.capturePlaceholder}
          aria-label={t.capturePlaceholder}
          style={{ ...FIELD, resize: 'vertical' }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void capture()
            }
          }}
        />
        <div style={ROW}>
          <button type="button" className="mishu-btn primary" disabled={busy} onClick={() => { void capture() }}>{t.captureSave}</button>
          <label className="mishu-check mishu-check-inline">
            <input
              type="checkbox"
              checked={organize}
              disabled={!organiseAllowed}
              title={organiseAllowed ? undefined : t.captureOrganizeOff}
              onChange={(event) => setOrganize(event.target.checked)}
            />{t.captureOrganize}
          </label>
          <span className="mishu-hint" style={{ margin: 0 }}>{t.captureHint}</span>
        </div>
      </div>

      <div className="mishu-filters" style={{ alignItems: 'center' }} role="search">
        <input
          value={query}
          placeholder={t.searchPlaceholder}
          aria-label={t.searchPlaceholder}
          disabled={view === 'deleted'}
          style={{ ...FIELD, flex: '1 1 220px', width: 'auto', ...view === 'deleted' ? { opacity: 0.5 } : {} }}
          onChange={(event) => setQuery(event.target.value)}
        />
        {view === 'deleted' ? <span className="mishu-hint" style={{ margin: 0 }}>{t.searchTrashOff}</span> : null}
        {query.trim() === '' ? null : (
          <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => { setQuery(''); setFound(undefined) }}>{t.clearSearch}</button>
        )}
        {found === undefined ? null : <span className="mishu-hint" style={{ margin: 0 }}>{t.searchFound(found.length)}</span>}
      </div>

      <div style={COLUMNS}>
        <div className="mishu-panel" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px' }}>
          {loading && shown.length === 0 ? <p className="mishu-empty">{t.loading}</p> : null}
          {loading && shown.length === 0 ? null : shown.length === 0 ? <p className="mishu-empty">{emptyText()}</p> : null}
          {shown.map(note => card(note))}
        </div>

        <div className="mishu-panel" style={{ padding: '10px 12px', minHeight: 120 }}>
          {detail === undefined ? (
            <p className="mishu-empty">{t.pickOne}</p>
          ) : openNote === undefined ? (
            // 详情读不到时说清是哪一条、为什么，而不是留一块空白。
            detailError === undefined
              ? <p className="mishu-empty">{t.loading}</p>
              : <div className="mishu-error">{t.failed}{detailError}</div>
          ) : (
            <>
              <div className="mishu-card-top" style={{ alignItems: 'baseline', gap: 8 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, wordBreak: 'break-word' }}>{headingOf(openNote, t.noTitle)}</h2>
                <span style={{ fontSize: 12, color: MUTED, flex: '0 0 auto' }}>{openNote.when}</span>
              </div>
              <div style={{ ...ROW, marginTop: 6 }}>
                <span style={TAG} title={sourceName(openNote)}>{categoryName(openNote.category)}</span>
                {openNote.categorySource === 'user' ? <span style={PALE} title={t.userPickedTitle}>{t.userPicked}</span> : null}
                {openNote.aiBadge ? <span className="mishu-ai compact" title={openNote.aiStale ? t.aiStaleTitle : t.aiBadgeTitle}>{t.aiBadge}</span> : null}
                {openNote.aiState === 'pending' || openNote.aiState === 'running' ? <span style={PALE}>{t.aiWorking}</span> : null}
                {openNote.dueDay === null ? null : <span style={PALE}>{t.dueOn(openNote.dueDay)}</span>}
                {openNote.seriesId === null ? null : <span style={PALE}>{t.isReminder}</span>}
                {openNote.tags.map(tag => <span key={tag} style={TAG}>{tag}</span>)}
              </div>

              {openNote.status === 'deleted' ? (
                <p className="mishu-preview" style={{ marginTop: 10 }}>{openNote.text}</p>
              ) : (
                <>
                  <label className="mishu-field" style={{ marginTop: 8 }}>{t.editText}
                    <textarea
                      rows={8}
                      value={edit === undefined ? openNote.text : edit.text}
                      style={{ ...FIELD, resize: 'vertical' }}
                      onChange={(event) => setEdit(current => (current === undefined ? current : { ...current, text: event.target.value }))}
                    />
                  </label>
                  <div className="mishu-row">
                    <label className="mishu-field">{t.editCategory}
                      <input
                        list={CATEGORY_LIST}
                        value={edit === undefined ? openNote.category : edit.category}
                        style={FIELD}
                        onChange={(event) => setEdit(current => (current === undefined ? current : { ...current, category: event.target.value }))}
                      />
                    </label>
                    <label className="mishu-field">{t.editTags}
                      <input
                        value={edit === undefined ? openNote.tags.join(', ') : edit.tags}
                        placeholder={t.tagsPlaceholder}
                        style={FIELD}
                        onChange={(event) => setEdit(current => (current === undefined ? current : { ...current, tags: event.target.value }))}
                      />
                    </label>
                  </div>
                  <datalist id={CATEGORY_LIST}>
                    {CATEGORIES.map(key => <option key={key} value={key} label={categoryName(key)} />)}
                  </datalist>
                  <div style={ROW}>
                    <button type="button" className="mishu-btn primary" disabled={acting !== undefined} onClick={() => { void save(openNote) }}>{t.save}</button>
                    <button type="button" className="mishu-btn mishu-btn-quiet" disabled={acting !== undefined} onClick={() => { seeded.current = { id: openNote.id, text: openNote.text }; setEdit(editOf(openNote)); setSaveFailed(false) }}>{t.resetEdit}</button>
                    <button type="button" className="mishu-btn mishu-btn-quiet" disabled={acting !== undefined} onClick={() => { void loadDetail(openNote.id) }}>{t.refresh}</button>
                  </div>
                  {saveFailed ? <p className="mishu-hint">{t.refreshHint}</p> : null}
                </>
              )}

              <div className="mishu-actions">
                {openNote.status === 'deleted' ? (
                  <>
                    <button type="button" className="mishu-btn" disabled={acting !== undefined} onClick={() => { void changeStatus(openNote, 'live') }}>{t.restore}</button>
                    <button type="button" className="mishu-btn mishu-btn-quiet" style={{ color: DANGER }} disabled={acting !== undefined} onClick={() => { void purgeNow(openNote) }}>{t.purge}</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="mishu-btn" disabled={acting !== undefined} onClick={() => { void organizeNow(openNote) }}>
                      {acting === 'organize' ? t.aiWorking : t.aiOrganize}
                    </button>
                    {openNote.seriesId !== null ? null : (
                      <button type="button" className="mishu-btn" disabled={acting !== undefined} onClick={() => startRemind(openNote)}>{t.remind}</button>
                    )}
                    <button type="button" className="mishu-btn" disabled={acting !== undefined} onClick={() => { void toChat(openNote) }}>{t.toChat}</button>
                    {openNote.status === 'archived'
                      ? <button type="button" className="mishu-btn" disabled={acting !== undefined} onClick={() => { void changeStatus(openNote, 'live') }}>{t.restore}</button>
                      : <button type="button" className="mishu-btn" disabled={acting !== undefined} onClick={() => { void changeStatus(openNote, 'archived') }}>{t.archive}</button>}
                    <button type="button" className="mishu-btn mishu-btn-quiet" disabled={acting !== undefined} onClick={() => { void changeStatus(openNote, 'deleted') }}>{t.remove}</button>
                  </>
                )}
              </div>

              {/* 日期是猜出来的东西，所以只在人点"设为提醒"之后才出现。 */}
              {remindOpen && openNote.status !== 'deleted' ? (
                <div style={{ ...ROW, marginTop: 8 }}>
                  <label className="mishu-field" style={{ margin: 0, flex: '0 0 auto', minWidth: 150 }}>{t.remindPickDay}
                    <input type="date" value={duePick} style={FIELD} onChange={(event) => setDuePick(event.target.value)} />
                  </label>
                  <label className="mishu-field" style={{ margin: 0, flex: '0 0 auto', minWidth: 120 }}>{t.remindRepeat}
                    <select value={repeat} style={FIELD} onChange={(event) => setRepeat(event.target.value as Repeat)}>
                      {REPEATS.map(key => <option key={key} value={key}>{t.repeats[key] ?? key}</option>)}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="mishu-btn primary"
                    disabled={acting !== undefined || duePick === ''}
                    onClick={() => { void toSeries(openNote, duePick, repeat) }}
                  >
                    {t.remind}
                  </button>
                  <button type="button" className="mishu-btn mishu-btn-quiet" onClick={() => setRemindOpen(false)}>{t.cancel}</button>
                </div>
              ) : null}

              <div className="mishu-detail">
                {openNote.aiPoints.length === 0 && openNote.aiTodos.length === 0 && openNote.aiDueHint === null ? null : (
                  <>
                    {openNote.aiPoints.length === 0 ? null : (
                      <>
                        <div className="mishu-row-label">{t.aiPoints}{openNote.aiStale ? ` · ${t.aiStaleTitle}` : ''}</div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{openNote.aiPoints.map((point, index) => <li key={`p-${index}`}>{point}</li>)}</ul>
                      </>
                    )}
                    {openNote.aiTodos.length === 0 ? null : (
                      <>
                        <div className="mishu-row-label">{t.aiTodos}</div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{openNote.aiTodos.map((todo, index) => <li key={`t-${index}`}>{todo}</li>)}</ul>
                      </>
                    )}
                    {openNote.aiDueHint === null ? null : (
                      <>
                        <div className="mishu-row-label">{t.aiDueHint}</div>
                        <div style={{ fontSize: 12 }}>{openNote.aiDueHint}</div>
                      </>
                    )}
                  </>
                )}

                {openNote.sends.length === 0 ? null : (
                  <>
                    <div className="mishu-row-label">{t.sends}</div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: MUTED }}>
                      {openNote.sends.map((send, index) => (
                        <li key={`s-${index}`}>
                          <span style={{ color: FAINT, marginRight: 4 }}>{stamp(send.at, locale())}</span>
                          {t.sendTargets[send.target] ?? send.target}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {detail === undefined || detail.related.length === 0 ? null : (
                  <>
                    <div className="mishu-row-label">{t.related}</div>
                    <div style={ROW}>
                      {detail.related.map(hit => (
                        <button
                          key={hit.id}
                          type="button"
                          className="mishu-btn mishu-btn-quiet"
                          onClick={() => { void openRelated(hit.id) }}
                        >
                          {hit.title === '' ? hit.id : hit.title}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
