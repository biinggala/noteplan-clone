// Pointer-events 기반 라인 드래그 (HTML5 DnD 대체).
//
// 왜: Tauri(WKWebView)는 HTML5 네이티브 drag-and-drop(draggable + dragstart/drop)을
// 제대로 지원하지 않아 타임블록킹/줄 재정렬이 동작하지 않음 (Electron/Chromium에선 됐음).
// pointer 이벤트는 WKWebView·터치 모두에서 동작하므로 데스크톱+모바일 공용.
//
// 드래그 소스: 에디터 거터의 6점 핸들 (dragHandle.ts)
// 드롭 대상:
//   1) 타임라인 슬롯 `[data-tl-slot]` → TimeBlock 생성 + 노트 라인에 시간 prefix
//   2) 에디터 본문(.cm-content) → 줄 재정렬

import type { EditorView } from '@codemirror/view'
import type { StateEffect } from '@codemirror/state'
import { useTimeBlockStore, type TimeBlock } from '@/lib/stores/timeBlockStore'
import { useTimelineDragStore, openDailyNoteDate } from '@/lib/dnd/timelineDragStore'
import { formatTimeRange, parseTimeBlockLines } from '@/lib/parser/timeBlockParser'
import {
  linkedEventFor, moveTimeblockEvent, createTimeblockEvent, blockStartMins,
} from '@/lib/google/timeblockLink'
import type { GoogleCalendarEvent } from '@/lib/google/calendar'

const SLOT_H = 60          // 타임라인 1시간 높이(px) — DayTimeline과 동일
const SNAP = 15            // 15분 스냅
const DEFAULT_DURATION = 30
const MARKER_RE = /^(-\s*\[.?\]\s*|-\s+|\*\s+|\+\s+)/

function snap15(m: number) { return Math.round(m / SNAP) * SNAP }

interface ActiveDrag {
  fromLine: number      // 1-based, 포함
  toLine: number        // 1-based, 포함 (한 줄이면 fromLine과 같음)
  lines: string[]       // 옮기는 줄들의 원문
  view: EditorView
  ghost: HTMLElement
  moved: boolean
  scrollEl: HTMLElement | null  // 타임라인 스크롤 컨테이너 (엣지 자동 스크롤용)
  lastX: number
  lastY: number
  rafId: number | null
  onMove: (e: PointerEvent) => void
  onUp: (e: PointerEvent) => void
  onCancel: (e: PointerEvent) => void
  onMouseMove: (e: MouseEvent) => void
  onMouseUp: (e: MouseEvent) => void
  /** WebKit 이 pointer 를 끊어 mouse 이벤트로 이어 받는 중 */
  mouseFallback: boolean
  /** 미리보기 길이 — 이미 시간이 붙은 줄이면 그 길이 */
  duration: number
}

const EDGE_ZONE = 90      // 컨테이너 상/하단 90px 이내면 자동 스크롤
const EDGE_MAX_SPEED = 14 // px/frame

let active: ActiveDrag | null = null

// ── 진단 기록 ─────────────────────────────────────────────────────────────
// 맥 앱에서만 '끌어다 놓았는데 아무 일도 없음'이 생겨 원인을 직접 볼 수 있게, 마지막
// 드래그의 이벤트 흐름을 남긴다. ⌘⌥⇧L 로 보고 복사할 수 있다 (showDragLog).
let curLog: string[] = []
let lastLog: string[] = []
let logT0 = 0
function dlog(msg: string) {
  if (curLog.length < 300) curLog.push(`${String(Math.round(performance.now() - logT0)).padStart(5)}ms ${msg}`)
}
function describeEl(el: Element | null): string {
  if (!el) return '(없음)'
  const h = el as HTMLElement
  const cls = typeof h.className === 'string' ? h.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
  const data = [...h.attributes].filter(a => a.name.startsWith('data-')).map(a => a.name).slice(0, 2).join(',')
  return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${data ? `[${data}]` : ''}`
}

/** 잠깐 뜨는 안내 (드롭이 안 된 이유 등) */
function toast(msg: string) {
  const el = document.createElement('div')
  el.className = 'np-toast'
  el.textContent = msg
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('np-toast--on'))
  setTimeout(() => { el.classList.remove('np-toast--on'); setTimeout(() => el.remove(), 300) }, 4500)
}

/** 마지막 드래그 기록 창 (⌘⌥⇧L) — 복사해서 보내 주면 원인을 바로 알 수 있다 */
export function showDragLog() {
  document.querySelector('.np-draglog')?.remove()
  const text = [
    `NotePlan drag log · ${new Date().toISOString()} · ${navigator.userAgent}`,
    `url=${location.pathname}${location.search} · viewport=${innerWidth}x${innerHeight} · dpr=${devicePixelRatio}`,
    ...(lastLog.length ? lastLog : ['(아직 드래그 기록이 없습니다 — 줄 왼쪽 ⋮⋮ 손잡이를 끌어 보세요)']),
  ].join('\n')
  const box = document.createElement('div')
  box.className = 'np-draglog'
  const pre = document.createElement('textarea')
  pre.readOnly = true
  pre.value = text
  const row = document.createElement('div')
  const copy = document.createElement('button'); copy.textContent = '복사'
  const close = document.createElement('button'); close.textContent = '닫기'
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text) } catch { pre.select(); document.execCommand('copy') }
    copy.textContent = '복사됨 ✓'
  }
  close.onclick = () => box.remove()
  row.append(copy, close); box.append(pre, row); document.body.appendChild(box)
  pre.focus(); pre.select()
}

/** 줄 드래그 중인지 — 에디터가 드래그 동안 hover 표시를 바꾸지 않게 (dragHandle.ts) */
export function isLineDragActive(): boolean { return active != null }

// ── WebKit(맥 앱) 대비 ──────────────────────────────────────────────────────
// Chromium 에선 멀쩡하지만 WebKit 은 (1) 드래그 도중 네이티브 드래그(dragstart)를
// 시작하며 pointercancel 을 보내거나 (2) 잡은 핸들 DOM 이 다시 그려지면 pointer
// 이벤트를 끊을 수 있다. 그러면 '끌고 가서 놓았는데 아무 일도 없음'이 된다.
//  - 드래그 동안 네이티브 dragstart 와 텍스트 선택을 막고
//  - pointer 가 끊기면(마우스·펜) mouse 이벤트로 이어서 따라간다
const blockNative = (e: Event) => { if (active) e.preventDefault() }

/** 거터 핸들 pointerdown에서 호출 — 라인 드래그 시작 */
export function startLineDrag(
  e: PointerEvent,
  view: EditorView,
  fromLine: number,
  toLine: number = fromLine,
) {
  if (active) cleanup()
  e.preventDefault()
  curLog = []; logT0 = performance.now(); lastHint = ''
  dlog(`start lines ${fromLine}-${toLine} pointer=${e.pointerType} id=${e.pointerId} at ${Math.round(e.clientX)},${Math.round(e.clientY)} target=${describeEl(e.target as Element)}`)

  const doc = view.state.doc
  const lines: string[] = []
  for (let n = fromLine; n <= Math.min(toLine, doc.lines); n++) lines.push(doc.line(n).text)

  // 드래그 고스트 — 실제 줄 텍스트를 담은 작은 카드 (6점 그립 + 텍스트)
  const ghost = document.createElement('div')
  ghost.className = 'np-drag-ghost'
  const head = (lines.find(l => l.trim()) ?? '').trim().replace(MARKER_RE, '') || '빈 줄'
  const label = lines.length > 1 ? `${head} 외 ${lines.length - 1}줄` : head
  ghost.innerHTML =
    `<span class="np-drag-ghost__grip" aria-hidden="true">` +
    `<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">` +
    `<circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/>` +
    `<circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/>` +
    `<circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg></span>` +
    `<span class="np-drag-ghost__text"></span><span class="np-drag-ghost__hint"></span>`
  ;(ghost.querySelector('.np-drag-ghost__text') as HTMLElement).textContent = label
  document.body.appendChild(ghost)

  const onMove = (ev: PointerEvent) => {
    if (!active) return
    if (!active.moved) dlog(`first move (${ev.type}) at ${Math.round(ev.clientX)},${Math.round(ev.clientY)}`)
    active.moved = true
    active.lastX = ev.clientX
    active.lastY = ev.clientY
    ghost.classList.add('np-drag-ghost--on')
    ghost.style.left = `${ev.clientX + 14}px`
    ghost.style.top = `${ev.clientY + 14}px`
    highlightUnderXY(ev.clientX, ev.clientY, view)
  }

  const onUp = (ev: PointerEvent) => {
    if (!active) return
    dlog(`${ev.type} at ${Math.round(ev.clientX)},${Math.round(ev.clientY)} moved=${active.moved} fallback=${active.mouseFallback}`)
    const drag = active
    cleanup()
    clearReorder(view)
    if (!drag.moved) return
    drop(ev, drag)
  }

  // pointercancel: 터치(스크롤 제스처 등)는 정리만 한다 — 예전엔 onUp 과 같아서
  // 취소된 자리에 그대로 드롭됐다. 마우스·펜은 WebKit 이 중간에 pointer 를 끊은
  // 것이라 mouse 이벤트로 이어서 따라가고, 버튼을 놓을 때(mouseup) 드롭한다.
  const onCancel = (ev: PointerEvent) => {
    if (!active) return
    dlog(`pointercancel pointer=${ev.pointerType} → ${ev.pointerType === 'mouse' || ev.pointerType === 'pen' ? 'mouse 이벤트로 계속' : '중단'}`)
    if (ev.pointerType === 'mouse' || ev.pointerType === 'pen') { active.mouseFallback = true; return }
    cleanup()
    clearReorder(view)
  }
  const onMouseMove = (ev: MouseEvent) => {
    if (!active?.mouseFallback) return
    onMove(ev as unknown as PointerEvent)
  }
  const onMouseUp = (ev: MouseEvent) => {
    if (!active) return
    // pointerup 이 정상으로 오면 그쪽이 먼저 처리한다 — 여긴 pointer 가 끊겼을 때만
    if (!active.mouseFallback) return
    onUp(ev as unknown as PointerEvent)
  }

  // 타임라인 스크롤 컨테이너 탐색 (드래그 동안 상/하단 엣지 자동 스크롤)
  const slotEl = document.querySelector('[data-tl-slot]') as HTMLElement | null
  const scrollEl = slotEl?.closest<HTMLElement>('[class*="overflow-y-auto"]') ?? null
  const firstTimed = parseTimeBlockLines(lines.find(l => l.trim()) ?? '')[0]

  active = {
    fromLine, toLine, lines, view, ghost, moved: false,
    scrollEl, lastX: e.clientX, lastY: e.clientY, rafId: null, onMove, onUp, onCancel,
    onMouseMove, onMouseUp, mouseFallback: false,
    duration: firstTimed?.duration ?? DEFAULT_DURATION,
  }
  active.rafId = requestAnimationFrame(edgeScrollStep)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  document.addEventListener('dragstart', blockNative, true)
  document.addEventListener('selectstart', blockNative, true)
  document.body.classList.add('np-line-dragging')
}

function cleanup() {
  if (!active) return
  window.removeEventListener('pointermove', active.onMove)
  window.removeEventListener('pointerup', active.onUp)
  window.removeEventListener('pointercancel', active.onCancel)
  window.removeEventListener('mousemove', active.onMouseMove)
  window.removeEventListener('mouseup', active.onMouseUp)
  document.removeEventListener('dragstart', blockNative, true)
  document.removeEventListener('selectstart', blockNative, true)
  document.body.classList.remove('np-line-dragging')
  if (active.rafId != null) cancelAnimationFrame(active.rafId)
  dlog('cleanup')
  lastLog = curLog
  active.ghost.remove()
  active = null
  hideAfterIndicator()
  useTimelineDragStore.getState().setPreview(null)
}

// 상/하단 엣지 근처에서 타임라인 자동 스크롤 (보이지 않는 시간대에 드롭 가능)
function edgeScrollStep() {
  if (!active) return
  const { scrollEl, lastX, lastY, view } = active
  if (scrollEl) {
    const r = scrollEl.getBoundingClientRect()
    // 포인터가 타임라인 위(가로 범위 안)에 있을 때만 엣지 스크롤.
    // (에디터에서 줄을 재정렬할 땐 타임라인이 스크롤되면 안 됨)
    const overTimeline = lastX >= r.left && lastX <= r.right
    const dTop = lastY - r.top
    const dBot = r.bottom - lastY
    let speed = 0
    if (!overTimeline) { active.rafId = requestAnimationFrame(edgeScrollStep); return }
    if (dTop < EDGE_ZONE) speed = -Math.round(EDGE_MAX_SPEED * (1 - Math.max(0, dTop) / EDGE_ZONE))
    else if (dBot < EDGE_ZONE) speed = Math.round(EDGE_MAX_SPEED * (1 - Math.max(0, dBot) / EDGE_ZONE))
    if (speed !== 0) {
      const before = scrollEl.scrollTop
      scrollEl.scrollTop += speed
      // 스크롤로 포인터 아래 슬롯이 바뀌므로 미리보기 갱신
      if (scrollEl.scrollTop !== before) highlightUnderXY(lastX, lastY, view)
    }
  }
  active.rafId = requestAnimationFrame(edgeScrollStep)
}

/**
 * 타임블록은 '그 날짜 일간 노트의 줄'이다 (다시 열 때 일간 노트에서 읽어 만든다).
 * 그래서 일간 노트에서 끌어온 줄은 그 노트 날짜 칸에만 놓을 수 있다.
 * 예전엔 여러 날 보기의 다른 칸에 놓으면 줄은 지금 노트에서 고쳐지고 블록·이벤트는
 * 다른 날짜에 생겨, 다시 열면 블록이 원래 날짜로 돌아가 있었다.
 * 주간·일반 노트에서 끌어온 줄은 어느 칸이든 된다 (줄에 시각이 붙고, 블록은 이번 세션 동안 표시).
 */
function canDropOn(date: string): boolean {
  const src = openDailyNoteDate()
  return !src || src === date
}

/** elementFromPoint → 타임라인 슬롯의 date/hour/minute (없으면 null) */
function slotInfoAt(clientX: number, clientY: number) {
  // 포인터 아래 '맨 위 요소'로 칸을 찾으면, 그 자리에 구글 일정·다른 타임블록이 있을 때
  // 그 일정이 잡혀 칸을 못 찾고 드롭이 그냥 무시됐다 (일정이 빽빽한 날엔 거의 항상).
  // 타임라인 영역 안이기만 하면 좌표로 칸을 고른다.
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
  const root = el?.closest('[data-tl-root]') as HTMLElement | null
  if (!root) return null
  let slot: HTMLElement | null = null
  for (const s of root.querySelectorAll<HTMLElement>('[data-tl-slot]')) {
    const r = s.getBoundingClientRect()
    if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) { slot = s; break }
  }
  if (!slot) return null
  const date = slot.getAttribute('data-tl-date') ?? ''
  const baseHour = parseInt(slot.getAttribute('data-tl-hour') ?? '0', 10)
  const rect = slot.getBoundingClientRect()
  const within = Math.max(0, Math.min(clientY - rect.top, SLOT_H))
  // 절대 분으로 스냅 → 시간 행 하단에서 다음 시각으로 자연스럽게 넘어감
  // (행별 %60 스냅은 하단 ~7px에서 같은 시각 :00으로 튀는 버그가 있었음)
  const total = Math.min(snap15(baseHour * 60 + (within / SLOT_H) * 60), 23 * 60 + 45)
  return { date, hour: Math.floor(total / 60), minute: total % 60, allowed: canDropOn(date) }
}

// ── 드롭 처리 ────────────────────────────────────────────────────────────────

function drop(e: PointerEvent, drag: ActiveDrag) {
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  dlog(`drop under=${describeEl(el)} inTimeline=${!!el?.closest('[data-tl-root]')}`)
  // 1) 타임라인 슬롯에 드롭 → TimeBlock 생성/이동
  const slot = slotInfoAt(e.clientX, e.clientY)
  if (slot) {
    dlog(`slot ${slot.date} ${slot.hour}:${String(slot.minute).padStart(2, '0')} allowed=${slot.allowed}`)
    if (!slot.allowed) {
      toast(`이 날짜에는 놓을 수 없어요 — 지금 열린 노트(${openDailyNoteDate()})의 날짜 칸에 놓아 주세요`)
      return
    }
    if (slot.date) {
      const n = dropOnTimeline(drag, slot.date, slot.hour * 60 + slot.minute)
      dlog(`dropOnTimeline → ${n}줄 반영`)
      if (n === 0) toast('타임블록을 만들 줄을 찾지 못했어요 (끄는 사이 노트가 바뀌었을 수 있어요). 다시 시도해 주세요')
    }
    return
  }

  // 2) 에디터 본문에 드롭 → 줄 재정렬
  if (el?.closest('.cm-content')) {
    dlog('reorder')
    reorder(e, drag)
    return
  }
  // 타임라인 쪽에 놓았는데 칸을 못 찾았으면 알려 준다 (예전엔 말없이 무시)
  if (el?.closest('[data-tl-root], .cm-editor') == null && el?.closest('aside, [class*="overflow-y-auto"]')) {
    dlog('no slot found near timeline')
    toast('타임라인의 시간 칸을 찾지 못했어요. 시간 줄 위에 놓아 주세요 (⌘⌥⇧L 로 기록 보기)')
  }
}

interface PlannedLine {
  from: number; to: number; insert: string
  startMins: number; duration: number; content: string
  /** 이미 시간이 붙어 있던 줄의 기존 블록 (있으면 새로 만들지 않고 옮긴다) */
  moveBlock?: TimeBlock
}

/**
 * 줄을 타임라인에 놓았을 때.
 * - 줄에 시각을 붙이는 편집은 '끌어온 에디터'에 직접 한다 (view.dispatch) → 그 화면의
 *   평소 onChange/저장 경로를 탄다. 주간·일반 노트에서 끌어와도 원래 노트가 고쳐진다.
 *   (예전엔 lineUpdateStore 에 쌓아 일간 노트 화면만 소비해서, 다른 노트에서 끌어오면
 *   노트는 그대로이고 쌓인 요청은 나중에 연 아무 일간 노트에 적용됐다.)
 * - 이미 시간이 붙은 줄이면 기존 시각을 떼고 새 시각으로 바꾸며, 연결된 블록·이벤트는
 *   새로 만들지 않고 옮긴다 (예전엔 "12:00 PM - 12:30 PM 9:00 AM - 9:30 AM 할일" + 이벤트 2개).
 * - 들여쓰기는 그대로 둔다.
 */
function dropOnTimeline(drag: ActiveDrag, date: string, dropMins: number): number {
  const { view } = drag
  const doc = view.state.doc
  const src = openDailyNoteDate()
  const tbStore = useTimeBlockStore.getState()
  const plans: PlannedLine[] = []
  const claimed = new Set<string>()
  let total = dropMins

  for (let i = 0; i < drag.lines.length; i++) {
    const raw = drag.lines[i]
    if (!raw.trim()) continue                       // 빈 줄은 건너뜀
    if (total >= 24 * 60) break                     // 자정 넘어가면 중단
    const lineNo = drag.fromLine + i
    if (lineNo > doc.lines || doc.line(lineNo).text !== raw) continue   // 드래그 중 문서가 바뀜
    const line = doc.line(lineNo)
    const indent = raw.match(/^\s*/)?.[0] ?? ''
    const h = Math.floor(total / 60), m = total % 60
    const timed = parseTimeBlockLines(raw)[0]
    let plan: PlannedLine
    if (timed) {
      const duration = timed.duration
      const text = `${timed.linePrefix}${formatTimeRange(h, m, duration)} ${timed.originalContent}`
      const oldStart = timed.startHour * 60 + timed.startMinute
      const sameLine = (b: TimeBlock) =>
        !claimed.has(b.id) && blockStartMins(b) === oldStart && b.content === timed.content
      // 일간 노트: 그 노트 날짜의 블록 (같은 줄이 여럿이면 줄 번호가 맞는 것).
      // 그 밖: 이번 세션에 만든(노트 줄이 없는) 블록
      const moveBlock = src
        ? tbStore.timeBlocks.find(b => b.date === src && sameLine(b) && b.lineIndex === lineNo - 1)
          ?? tbStore.timeBlocks.find(b => b.date === src && sameLine(b))
        : tbStore.timeBlocks.find(b => !b.noteLineText && sameLine(b))
      if (moveBlock) claimed.add(moveBlock.id)
      plan = { from: line.from, to: line.to, insert: indent + text, startMins: total, duration, content: timed.content, moveBlock }
    } else {
      const trimmed = raw.trim()
      const mk = trimmed.match(MARKER_RE)
      const linePrefix = mk ? mk[0] : ''
      const cleanContent = trimmed.slice(linePrefix.length).trim()
      if (!cleanContent) continue
      const range = formatTimeRange(h, m, DEFAULT_DURATION)
      const text = linePrefix ? `${linePrefix.trimEnd()} ${range} ${cleanContent}` : `${range} ${trimmed}`
      plan = { from: line.from, to: line.to, insert: indent + text, startMins: total, duration: DEFAULT_DURATION, content: cleanContent }
    }
    plans.push(plan)
    total += plan.duration
  }
  if (plans.length === 0) return 0

  // 옮기는 블록은 노트를 고치기 '전에' 새 시각으로 바꿔 둔다 — 일간 노트는 고친 직후
  // syncTimeBlocks 로 블록을 다시 만드는데, 시각+내용이 같으면 같은 블록(id)으로 이어진다.
  const moves: { ev: GoogleCalendarEvent | undefined; startMins: number; duration: number }[] = []
  for (const p of plans) {
    if (!p.moveBlock) continue
    const ev = linkedEventFor(p.moveBlock)
    tbStore.updateTimeBlock(p.moveBlock.id, {
      date, startHour: Math.floor(p.startMins / 60), startMinute: p.startMins % 60, duration: p.duration,
    })
    moves.push({ ev, startMins: p.startMins, duration: p.duration })
  }

  view.dispatch({
    changes: plans.map(p => ({ from: p.from, to: p.to, insert: p.insert })),
    scrollIntoView: false,
  })

  for (const p of plans) {
    if (p.moveBlock) continue
    const sh = Math.floor(p.startMins / 60), sm = p.startMins % 60
    // 일간 노트면 방금 편집으로 블록이 이미 생겼다 — 없을 때만(주간·일반 노트) 추가
    const exists = useTimeBlockStore.getState().timeBlocks.some(b =>
      b.date === date && b.startHour === sh && b.startMinute === sm && b.content === p.content)
    if (!exists) {
      useTimeBlockStore.getState().addTimeBlock({
        date, startHour: sh, startMinute: sm, duration: p.duration, content: p.content,
      })
    }
    // 실제 Google Calendar에도 이벤트 생성 (마커로 중복 표시 방지)
    void createTimeblockEvent(date, p.startMins, p.duration, p.content)
  }
  for (const mv of moves) void moveTimeblockEvent(mv.ev, date, mv.startMins, mv.duration)
  return plans.length
}

/** 드롭 위치 → 대상 줄. 줄의 세로 중간보다 아래면 그 줄 '다음'에 넣는다. */
function dropTarget(view: EditorView, x: number, y: number): { lineNum: number; after: boolean } | null {
  const pos = view.posAtCoords({ x, y })
  if (pos == null) return null
  const line = view.state.doc.lineAt(pos)
  const blk = view.lineBlockAt(line.from)
  const mid = view.documentTop + (blk.top + blk.bottom) / 2
  return { lineNum: line.number, after: y > mid }
}

function reorder(e: PointerEvent, drag: ActiveDrag) {
  const { view } = drag
  const target = dropTarget(view, e.clientX, e.clientY)
  if (!target) return
  const doc = view.state.doc
  const fromLine = drag.fromLine
  const toLine = Math.min(drag.toLine, doc.lines)
  if (fromLine < 1 || fromLine > doc.lines) return
  // 넣을 자리 = 이 줄 번호 '앞'. 마지막 줄 아래쪽 절반이면 doc.lines + 1 (맨 끝).
  // 예전엔 항상 대상 줄 앞에만 넣어서 줄을 맨 끝으로는 옮길 수 없었다.
  const gap = target.after ? target.lineNum + 1 : target.lineNum
  // 옮기는 블록 안(또는 바로 위·아래 경계)이면 제자리 — 아무것도 안 한다
  if (gap >= fromLine && gap <= toLine + 1) return

  const first = doc.line(fromLine)
  const last = doc.line(toLine)
  const text = drag.lines.join('\n')

  // 예전엔 문서 전체를 갈아끼웠다(from:0 ~ to:doc.length). 그러면 커서가 항상
  // 위치 0으로 무너진다(측정 확인) — 교체 범위 안의 위치는 매핑할 곳이 없기 때문.
  // WebKit(Tauri)은 이렇게 바뀐 선택을 DOM에 반영하면서 캐럿을 화면에 보이게
  // 스크롤하므로, 줄을 옮길 때마다 노트 맨 위로 튀었다.
  // 옮기는 줄만 지우고 다시 넣는 최소 변경이면 커서가 제자리에 매핑된다.
  const del = toLine < doc.lines
    ? { from: first.from, to: last.to + 1 }    // 블록 + 뒤따르는 개행
    : { from: first.from - 1, to: last.to }    // 마지막 줄까지면 앞 개행을 대신 제거
  const ins = gap <= doc.lines
    ? { from: doc.line(gap).from, insert: text + '\n' }   // gap 줄 앞
    : { from: doc.length, insert: '\n' + text }            // 문서 맨 끝

  // 줄 재정렬은 줄 수가 그대로라 문서 전체 높이도 그대로다. 그래서 스크롤 위치는
  // 원래 값 그대로가 정답 — 엔진이 어떻게 재계산하든 되돌려 놓는다.
  const scroller = view.scrollDOM
  const keepTop = scroller.scrollTop

  view.dispatch({
    // 변경은 위치 순서대로 넘겨야 한다
    changes: fromLine < gap ? [del, ins] : [ins, del],
    scrollIntoView: false,
  })

  const restore = () => { if (scroller.scrollTop !== keepTop) scroller.scrollTop = keepTop }
  restore()
  // CodeMirror가 다음 프레임에 다시 측정하면서 한 줄 높이만큼 밀 수 있어 한 번 더
  requestAnimationFrame(restore)
}

// 마지막 줄 '아래'에 넣을 때의 표시 — 에디터 쪽 인디케이터는 '그 줄 위' 선만 그린다
let afterIndicator: HTMLElement | null = null
function showAfterIndicator(view: EditorView, lineNum: number) {
  const line = view.state.doc.line(lineNum)
  const blk = view.lineBlockAt(line.from)
  const content = view.contentDOM.getBoundingClientRect()
  if (!afterIndicator) {
    afterIndicator = document.createElement('div')
    afterIndicator.style.cssText =
      'position:fixed;height:2px;background:#f59e0b;pointer-events:none;z-index:9999;border-radius:1px'
    document.body.appendChild(afterIndicator)
  }
  afterIndicator.style.left = `${content.left}px`
  afterIndicator.style.width = `${content.width}px`
  afterIndicator.style.top = `${view.documentTop + blk.bottom - 1}px`
}
function hideAfterIndicator() {
  afterIndicator?.remove()
  afterIndicator = null
}

// ── 드롭 대상 하이라이트 ───────────────────────────────────────────────────────

/** 고스트 카드에 '놓으면 무엇이 되는지' 표시 + 대상이 바뀔 때만 기록 */
let lastHint = ''
function setHint(hint: string) {
  if (hint === lastHint) return
  lastHint = hint
  dlog(`over: ${hint || '(대상 없음)'}`)
  const el = active?.ghost.querySelector('.np-drag-ghost__hint') as HTMLElement | null
  if (el) { el.textContent = hint; el.dataset.kind = hint.startsWith('✕') ? 'no' : hint ? 'ok' : '' }
}
const fmt12 = (h: number, m: number) => `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}`

function highlightUnderXY(x: number, y: number, view: EditorView) {
  // 타임라인 슬롯 위 → 미리보기 블록(시작시각 + 길이). 놓을 수 없는 칸이면 빨갛게
  const slot = slotInfoAt(x, y)
  setHint(slot ? (slot.allowed ? `→ ${fmt12(slot.hour, slot.minute)} 타임블록` : '✕ 열린 노트 날짜에만')
    : (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.cm-content') ? '→ 줄 이동' : '')
  if (slot) {
    useTimelineDragStore.getState().setPreview({
      date: slot.date, hour: slot.hour, minute: slot.minute,
      duration: active?.duration ?? DEFAULT_DURATION,
      disabled: !slot.allowed,
      reason: slot.allowed ? undefined : '열린 노트 날짜에만',
    })
    clearReorder(view)
    hideAfterIndicator()
    return
  }
  useTimelineDragStore.getState().setPreview(null)

  // 에디터 본문 위 → 줄 재정렬 인디케이터 (넣을 자리 '위' 선)
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (el?.closest('.cm-content')) {
    const t = dropTarget(view, x, y)
    if (t) {
      const gap = t.after ? t.lineNum + 1 : t.lineNum
      if (gap > view.state.doc.lines) {
        clearReorder(view)
        showAfterIndicator(view, view.state.doc.lines)
        return
      }
      hideAfterIndicator()
      const eff = setReorderLine(gap)
      if (eff) view.dispatch({ effects: eff })
      return
    }
  }
  hideAfterIndicator()
  clearReorder(view)
}

// 재정렬 인디케이터는 dragHandle의 StateField를 통해 표시 (콜백 주입)
let setReorderLine: (n: number) => StateEffect<number> | null = () => null
let clearReorder: (view: EditorView) => void = () => undefined
export function wireReorderIndicator(
  setLine: (n: number) => StateEffect<number>,
  clear: (view: EditorView) => void,
) {
  setReorderLine = setLine
  clearReorder = clear
}
