/**
 * The board page: a summary on top, three resizable columns below.
 *
 * Content (titles, explanations, the summary sentence) comes from the host
 * already in one language; this component only lays it out. Every change
 * goes through the host and the page shows the board the host answers with,
 * never a local guess. Cards can be dragged: onto "done for you" = done,
 * onto "keeping" = remind me tomorrow, onto "to handle" = handle it now.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { mishuApi, restartApi, type BoardCard, type BoardData, type CardAction, type MatterDetail, type NewItem } from './api.ts'
import { AskAI, type OpenChat } from './AskAI.tsx'
import { MishuSettings } from './Settings.tsx'
import { TEXT, uiLang, type UiLang } from './text.ts'

type Column = 'handle' | 'remember' | 'done'
type Source = 'all' | BoardCard['source']

const SOURCE_KEY = 'dsh-mishu.source'

function loadSource(): Source {
  try {
    const value = localStorage.getItem(SOURCE_KEY)
    if (value === 'github' || value === 'mail' || value === 'manual') return value
  } catch {
    // storage blocked: show everything
  }
  return 'all'
}

const REFRESH_MS = 60_000
const WIDTHS_KEY = 'dsh-mishu.columns'
const EQUAL: [number, number, number] = [1, 1, 1]
const MIN_COLUMN_PX = 220

/** What dropping a card from one column onto another means. */
function dropAction(card: BoardCard, from: Column, to: Column): CardAction | undefined {
  if (card.target !== 'matter' || from === to) return undefined
  if (to === 'done') return 'done'
  if (to === 'remember' && from === 'handle') return 'snooze'
  if (to === 'handle' && from === 'remember') return 'unsnooze'
  return undefined
}

/** Column widths are a per-viewer convenience: remembered in this browser if it allows, equal otherwise. */
function loadWidths(): [number, number, number] {
  try {
    const value = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null') as unknown
    if (Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && v > 0)) return value as [number, number, number]
  } catch {
    // storage blocked or unreadable: equal widths
  }
  return EQUAL
}

function saveWidths(widths: [number, number, number]): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
  } catch {
    // storage blocked: widths last for this visit only
  }
}

export function MishuBoard({ locale, openChat }: { locale: () => string; openChat: OpenChat }) {
  const [board, setBoard] = useState<BoardData | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [dropOn, setDropOn] = useState<Column | undefined>()
  const [widths, setWidths] = useState<[number, number, number]>(loadWidths)
  const [tab, setTab] = useState<'board' | 'settings'>('board')
  const [source, setSourceState] = useState<Source>(loadSource)
  const setSource = (next: Source) => {
    setSourceState(next)
    try { localStorage.setItem(SOURCE_KEY, next) } catch { /* this visit only */ }
  }
  const dragged = useRef<{ card: BoardCard; from: Column } | undefined>(undefined)
  const columnsRef = useRef<HTMLDivElement | null>(null)
  const lang: UiLang = board?.lang ?? uiLang(locale())
  const t = TEXT[lang]

  const take = useCallback((result: { ok: true; board: BoardData } | { ok: false; message: string }) => {
    if (result.ok) {
      setBoard(result.board)
      setError(undefined)
    } else {
      setError(result.message)
    }
  }, [])

  const load = useCallback(() => mishuApi.board(locale()).then(take), [locale, take])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    const onFocus = () => { void load() }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const act = async (card: BoardCard, action: CardAction) => {
    if (action === 'open') {
      if (card.url !== null) window.open(card.url, '_blank', 'noopener')
      return
    }
    setBusy(true)
    take(await mishuApi.action(locale(), card.target, card.id, action))
    setBusy(false)
  }

  const sync = async () => {
    setSyncing(true)
    take(await mishuApi.sync(locale()))
    setSyncing(false)
  }

  /** Drag the divider after column `index` (0 or 1): the two neighbours trade width, the third keeps its own. */
  const startResize = (index: 0 | 1) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = columnsRef.current
    if (container === null) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const start = widths
    const total = start[0] + start[1] + start[2]
    const usable = container.getBoundingClientRect().width - 2 * 10
    const minFr = (MIN_COLUMN_PX / usable) * total
    let latest = start
    const move = (e: PointerEvent) => {
      const delta = ((e.clientX - startX) / usable) * total
      const pair = start[index] + start[index + 1]!
      const left = Math.min(pair - minFr, Math.max(minFr, start[index] + delta))
      const next = [...start] as [number, number, number]
      next[index] = left
      next[index + 1] = pair - left
      latest = next
      setWidths(next)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      saveWidths(latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const resetWidths = () => {
    setWidths(EQUAL)
    saveWidths(EQUAL)
  }

  const dropProps = (column: Column) => ({
    onDragOver: (event: DragEvent) => {
      const drag = dragged.current
      if (drag === undefined || dropAction(drag.card, drag.from, column) === undefined) return
      event.preventDefault()
      setDropOn(column)
    },
    onDragLeave: () => setDropOn(current => (current === column ? undefined : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setDropOn(undefined)
      const drag = dragged.current
      dragged.current = undefined
      const action = drag === undefined ? undefined : dropAction(drag.card, drag.from, column)
      if (drag !== undefined && action !== undefined) void act(drag.card, action)
    },
  })

  const label: Record<CardAction, string> = {
    open: t.open, done: t.markDone, snooze: t.snooze, dismiss: t.dismiss, unsnooze: t.unsnooze, reopen: t.reopen, stop: t.stop,
  }

  const card = (item: BoardCard, column: Column) => (
    <Card
      key={`${item.target}-${item.id}`}
      item={item}
      column={column}
      lang={lang}
      locale={locale}
      busy={busy}
      label={label}
      openChat={openChat}
      onAct={(action) => { void act(item, action) }}
      onDragStart={() => { dragged.current = { card: item, from: column } }}
      onDragEnd={() => { dragged.current = undefined; setDropOn(undefined) }}
    />
  )

  if (board === undefined) {
    return (
      <div className="mishu-page">
        <div className="mishu-head"><div className="mishu-title"><h1>{t.title}</h1><RestartButton lang={lang} locale={locale} /></div></div>
        {error === undefined ? <p className="mishu-empty">{t.loading}</p> : <div className="mishu-error">{t.failed}{error}</div>}
      </div>
    )
  }

  const { metrics } = board
  const keep = (card: BoardCard) => source === 'all' || card.source === source
  const columns = {
    handle: board.columns.handle.filter(keep),
    remember: board.columns.remember.filter(keep),
    done: (() => {
      const groups = board.columns.done.groups.map(g => ({ ...g, items: g.items.filter(keep) })).filter(g => g.items.length > 0)
      return { total: groups.reduce((n, g) => n + g.items.length, 0), groups }
    })(),
  }
  const everything = [...board.columns.handle, ...board.columns.remember, ...board.columns.done.groups.flatMap(g => g.items)]
  const count = (s: Source) => everything.filter(c => s === 'all' || c.source === s).length
  const sources: Array<{ id: Source; label: string }> = [
    { id: 'all', label: t.all },
    { id: 'github', label: t.sourceGithub },
    { id: 'mail', label: t.sourceMail },
    { id: 'manual', label: t.sourceManual },
  ]
  const template = `minmax(0, ${widths[0]}fr) 10px minmax(0, ${widths[1]}fr) 10px minmax(0, ${widths[2]}fr)`
  const divider = (index: 0 | 1) => (
    <div
      className="mishu-divider"
      role="separator"
      aria-orientation="vertical"
      title={t.resize}
      onPointerDown={startResize(index)}
      onDoubleClick={resetWidths}
    />
  )
  return (
    <div className="mishu-page" data-mishu-board="">
      <div className="mishu-head">
        <div className="mishu-title">
          <h1>{t.title}</h1>
          <div className="mishu-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'board'} className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>{t.tabBoard}</button>
            <button type="button" role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>{t.tabSettings}</button>
          </div>
          <RestartButton lang={lang} locale={locale} />
        </div>
        <div className="mishu-sources">
          <span>
            <i className={`mishu-dot ${board.sources.github.state}`} />{board.sources.github.text}
            {board.sources.github.state === 'error' ? <AskAI topic={{ kind: 'github-error' }} lang={lang} locale={locale} openChat={openChat} compact /> : null}
          </span>
          {board.sources.mail.map(m => (
            <span key={m.id}>
              <i className={`mishu-dot ${m.state}`} />{m.text}
              {m.state === 'error' ? <AskAI topic={{ kind: 'mail-error', accountId: m.id }} lang={lang} locale={locale} openChat={openChat} compact /> : null}
            </span>
          ))}
          <button type="button" className="mishu-btn" disabled={syncing} onClick={() => { void sync() }}>{syncing ? t.syncing : t.sync}</button>
        </div>
      </div>
      {tab === 'settings' ? <MishuSettings lang={lang} locale={locale} openChat={openChat} /> : null}
      {tab === 'settings' ? null : <>
      {error === undefined ? null : <div className="mishu-error">{t.failed}{error}</div>}
      <p className="mishu-summary">{board.summary} <AskAI topic={{ kind: 'summary' }} lang={lang} locale={locale} openChat={openChat} compact /></p>

      <div className="mishu-metrics">
        <div className="mishu-metric">
          <div className="mishu-metric-label">{t.metricHandle}</div>
          <div className="mishu-metric-value">{metrics.handle}{metrics.overdue > 0 ? <small className="mishu-danger">{metrics.overdue} {t.metricOverdue}</small> : null}</div>
        </div>
        <div className="mishu-metric"><div className="mishu-metric-label">{t.metricSoon}</div><div className="mishu-metric-value">{metrics.dueSoon}</div></div>
        <div className="mishu-metric"><div className="mishu-metric-label">{t.metricClosed}</div><div className="mishu-metric-value">{metrics.closedToday}</div></div>
        <div className="mishu-metric">
          <div className="mishu-metric-label">{t.metricShadow}</div>
          <div className="mishu-metric-value">{metrics.shadow}{board.markRead === 'shadow' ? <small className="mishu-warn">{t.shadowTag}</small> : null}</div>
        </div>
      </div>

      <div className="mishu-filters" role="group">
        {sources.map(s => (
          <button key={s.id} type="button" aria-pressed={source === s.id} className={`mishu-chip ${source === s.id ? 'active' : ''}`} onClick={() => setSource(s.id)}>
            {s.label}<span>{count(s.id)}</span>
          </button>
        ))}
      </div>

      <div className="mishu-columns" ref={columnsRef} style={{ ['--mishu-cols' as string]: template }}>
        <section className={`mishu-col ${dropOn === 'handle' ? 'drop' : ''}`} {...dropProps('handle')} aria-label={t.handle}>
          <div className="mishu-col-head">{t.handle}<span>{columns.handle.length}</span></div>
          {columns.handle.length === 0 ? <div className="mishu-empty">{t.emptyHandle}</div> : columns.handle.map(item => card(item, 'handle'))}
        </section>
        {divider(0)}
        <section className={`mishu-col ${dropOn === 'remember' ? 'drop' : ''}`} {...dropProps('remember')} aria-label={t.remember} title={t.dropRemember}>
          <div className="mishu-col-head">{t.remember}<span>{columns.remember.length}</span></div>
          {columns.remember.length === 0 ? <div className="mishu-empty">{t.emptyRemember}</div> : columns.remember.map(item => card(item, 'remember'))}
          <AddForm lang={lang} locale={locale} onAdded={next => setBoard(next)} />
        </section>
        {divider(1)}
        <section className={`mishu-col ${dropOn === 'done' ? 'drop' : ''}`} {...dropProps('done')} aria-label={t.done} title={t.dropDone}>
          <div className="mishu-col-head">{t.done}<span>{columns.done.total}</span></div>
          {columns.done.groups.length === 0 ? <div className="mishu-empty">{t.emptyDone}</div> : columns.done.groups.map(group => (
            <details key={group.reason} className="mishu-group">
              <summary>{group.label}<span>{group.items.length}</span></summary>
              {group.items.map(item => card(item, 'done'))}
            </details>
          ))}
          {columns.done.total > 0 ? <p className="mishu-hint">{t.doneHint}</p> : null}
          {metrics.shadow > 0 ? <div className="mishu-banner">{t.shadow(metrics.shadow)}</div> : null}
        </section>
      </div>
      </>}
    </div>
  )
}

interface CardProps {
  item: BoardCard
  column: Column
  lang: UiLang
  locale: () => string
  busy: boolean
  label: Record<CardAction, string>
  openChat: OpenChat
  onAct: (action: CardAction) => void
  onDragStart: () => void
  onDragEnd: () => void
}

/**
 * One card. On "to handle" and "keeping" it says what this is, where the
 * problem is and what to do. On "done for you" it stays short, with a
 * "What happened" button that opens the full story.
 */
function Card({ item, column, lang, locale, busy, label, openChat, onAct, onDragStart, onDragEnd }: CardProps) {
  const t = TEXT[lang]
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<MatterDetail | { error: string } | undefined>()
  const explain = item.explain
  const compact = column === 'done'

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && item.target === 'matter') {
      void mishuApi.detail(locale(), item.id).then(r => setDetail(r.ok ? r.detail : { error: r.message }))
    }
  }

  const row = (name: string, text: string | null | undefined, className = '') =>
    text === null || text === undefined || text === '' ? null : (
      <div className={`mishu-row-explain ${className}`}><span className="mishu-row-label">{name}</span><span>{text}</span></div>
    )

  return (
    <div
      className={`mishu-card ${item.tone === 'normal' ? '' : item.tone}`}
      draggable={item.target === 'matter' && column !== 'done'}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; onDragStart() }}
      onDragEnd={onDragEnd}
    >
      <div className="mishu-card-title">{item.title}</div>
      <div className="mishu-card-meta">{item.meta}</div>
      {!compact && explain !== null ? (
        <div className="mishu-explain">
          {row(t.what, explain.what)}
          {row(column === 'remember' ? t.whyKeep : t.why, explain.why)}
          {row(t.fix, explain.fix, 'mishu-fix')}
        </div>
      ) : null}
      {!compact && explain === null && item.note !== null ? <div className="mishu-card-note">{item.note}</div> : null}
      {open ? (
        <div className="mishu-detail">
          {detail === undefined ? <div className="mishu-empty">{t.loading}</div> : 'error' in detail ? <div className="mishu-danger">{detail.error}</div> : (
            <>
              {compact && detail.explain !== null ? (
                <>
                  {row(t.what, detail.explain.what)}
                  {row(t.whyDone, detail.explain.why)}
                </>
              ) : null}
              {detail.did.length > 0 ? (
                <div className="mishu-row-explain">
                  <span className="mishu-row-label">{t.did}</span>
                  <span>{detail.did.map((line, i) => <div key={i}>{line}</div>)}</span>
                </div>
              ) : null}
              {detail.messages.length > 0 ? (
                <div className="mishu-messages">
                  <div className="mishu-row-label">{t.messages(detail.messages.length)}</div>
                  <ul>{detail.messages.map((m, i) => <li key={i}><span>{m.at}</span> {m.title}</li>)}</ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <div className="mishu-actions">
        {column === 'handle' ? <AskAI topic={item.target === 'series' ? { kind: 'series', id: item.id } : { kind: 'matter', id: item.id }} lang={lang} locale={locale} openChat={openChat} /> : null}
        {item.actions.map((action, index) => (
          <button
            key={action}
            type="button"
            className={`mishu-btn ${index === 0 ? 'primary' : ''}`}
            disabled={busy && action !== 'open'}
            onClick={() => onAct(action)}
          >
            {action === 'open' && explain?.link !== undefined ? explain.link.label : label[action]}
          </button>
        ))}
        {item.target === 'matter' ? (
          <button type="button" className="mishu-btn mishu-btn-quiet" aria-expanded={open} onClick={toggle}>
            {open ? t.hide : compact ? t.explainDone : t.detail}
          </button>
        ) : null}
        {column === 'handle' ? null : <AskAI topic={item.target === 'series' ? { kind: 'series', id: item.id } : { kind: 'matter', id: item.id }} lang={lang} locale={locale} openChat={openChat} compact />}
      </div>
    </div>
  )
}

const EMPTY: NewItem = { title: '', due: '', repeat: 'none', category: 'other', note: '' }

/** "Tell me something": a small form with a live preview of what was understood. */
function AddForm({ lang, locale, onAdded }: { lang: UiLang; locale: () => string; onAdded: (board: BoardData) => void }) {
  const t = TEXT[lang]
  const [open, setOpen] = useState(false)
  const [item, setItem] = useState<NewItem>(EMPTY)
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | undefined>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || item.title.trim() === '' || item.due === '') {
      setPreview(undefined)
      return
    }
    const timer = setTimeout(() => {
      void mishuApi.preview(locale(), item).then(r => setPreview(r.ok ? { ok: true, text: r.text } : { ok: false, text: r.message }))
    }, 250)
    return () => clearTimeout(timer)
  }, [open, item, locale])

  if (!open) {
    return <button type="button" className="mishu-btn mishu-add-toggle" onClick={() => setOpen(true)}>+ {t.add}</button>
  }

  const set = (key: keyof NewItem) => (event: { target: { value: string } }) => setItem({ ...item, [key]: event.target.value })
  const save = async () => {
    setSaving(true)
    const result = await mishuApi.add(locale(), item)
    setSaving(false)
    if (result.ok) {
      onAdded(result.board)
      setItem(EMPTY)
      setOpen(false)
    } else {
      setPreview({ ok: false, text: result.message })
    }
  }

  return (
    <div className="mishu-add">
      <label className="mishu-field">{t.addTitle}<input value={item.title} placeholder={t.addTitlePlaceholder} onChange={set('title')} /></label>
      <div className="mishu-row">
        <label className="mishu-field">{t.addDue}<input type="date" value={item.due} onChange={set('due')} /></label>
        <label className="mishu-field">{t.addRepeat}
          <select value={item.repeat} onChange={set('repeat')}>
            {Object.entries(t.repeats).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
      </div>
      <div className="mishu-row">
        <label className="mishu-field">{t.addCategory}
          <select value={item.category} onChange={set('category')}>
            {Object.entries(t.categories).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
        <label className="mishu-field">{t.addNote}<input value={item.note} onChange={set('note')} /></label>
      </div>
      <div className={`mishu-preview ${preview?.ok === false ? 'mishu-danger' : ''}`}>{preview?.text ?? t.previewHint}</div>
      <div className="mishu-actions">
        <button type="button" className="mishu-btn primary" disabled={saving || preview?.ok !== true} onClick={() => { void save() }}>{t.save}</button>
        <button type="button" className="mishu-btn" onClick={() => { setOpen(false); setItem(EMPTY) }}>{t.cancel}</button>
      </div>
      <p className="mishu-hint">{t.chatHint}</p>
    </div>
  )
}

/** "Restart DSH", for after plugins were reinstalled or upgraded. Where it cannot work (DSH started from a terminal) it says what to do instead. */
function RestartButton({ lang, locale }: { lang: UiLang; locale: () => string }) {
  const t = TEXT[lang]
  const [why, setWhy] = useState<string | undefined>()
  const [status, setStatus] = useState<{ ok: boolean; text: string } | undefined>()
  useEffect(() => {
    void restartApi.info(locale()).then((r) => { if (r.ok && !r.supported) setWhy(r.why) })
  }, [locale])
  const restart = async () => {
    if (why !== undefined) {
      setStatus({ ok: false, text: why })
      return
    }
    if (!window.confirm(t.restartConfirm)) return
    setStatus({ ok: true, text: t.restarting })
    const r = await restartApi.restart(locale())
    if (!r.ok) {
      setStatus({ ok: false, text: r.message })
    } else if (r.reconnect === true) {
      // On a server the page stays: wait for DSH to go away and come back, then reload.
      setStatus({ ok: true, text: t.restartingWeb })
      setStatus({ ok: true, text: await reconnect(locale) ? t.restartReloading : t.restartSlow })
    }
  }
  return (
    <>
      <button type="button" className="mishu-btn" title={why === undefined ? t.restartTip : `${t.restartTip}\n${why}`} disabled={status?.ok === true} onClick={() => { void restart() }}>{t.restart}</button>
      {status === undefined ? null : <span className={status.ok ? 'mishu-hint' : 'mishu-hint mishu-warn'}>{status.text}</span>}
    </>
  )
}

/** Wait for the server to go down and answer again (up to two minutes), then reload the page. */
async function reconnect(locale: () => string): Promise<boolean> {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  let wentDown = false
  for (const until = Date.now() + 120_000; Date.now() < until;) {
    await sleep(1500)
    const r = await restartApi.info(locale())
    if (!r.ok) wentDown = true
    else if (wentDown) {
      window.location.reload()
      return true
    }
  }
  return false
}
