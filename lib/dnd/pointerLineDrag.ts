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
import { useTimeBlockStore } from '@/lib/stores/timeBlockStore'
import { useLineUpdateStore } from '@/lib/stores/lineUpdateStore'
import { useTimelineDragStore } from '@/lib/dnd/timelineDragStore'
import { formatTimeRange } from '@/lib/parser/timeBlockParser'

const SLOT_H = 60          // 타임라인 1시간 높이(px) — DayTimeline과 동일
const SNAP = 15            // 15분 스냅
const DEFAULT_DURATION = 30
const MARKER_RE = /^(-\s*\[.?\]\s*|-\s+|\*\s+|\+\s+)/

function snap15(m: number) { return Math.round(m / SNAP) * SNAP }

interface ActiveDrag {
  lineNumber: number
  content: string
  view: EditorView
  ghost: HTMLElement
  moved: boolean
  scrollEl: HTMLElement | null  // 타임라인 스크롤 컨테이너 (엣지 자동 스크롤용)
  lastX: number
  lastY: number
  rafId: number | null
  onMove: (e: PointerEvent) => void
  onUp: (e: PointerEvent) => void
}

const EDGE_ZONE = 90      // 컨테이너 상/하단 90px 이내면 자동 스크롤
const EDGE_MAX_SPEED = 14 // px/frame

let active: ActiveDrag | null = null

/** 거터 핸들 pointerdown에서 호출 — 라인 드래그 시작 */
export function startLineDrag(
  e: PointerEvent,
  view: EditorView,
  lineNumber: number,
  content: string,
) {
  if (active) cleanup()
  e.preventDefault()

  // 드래그 고스트 — 실제 줄 텍스트를 담은 작은 카드 (6점 그립 + 텍스트)
  const ghost = document.createElement('div')
  ghost.className = 'np-drag-ghost'
  const label = content.trim().replace(MARKER_RE, '') || '빈 줄'
  ghost.innerHTML =
    `<span class="np-drag-ghost__grip" aria-hidden="true">` +
    `<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">` +
    `<circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/>` +
    `<circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/>` +
    `<circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg></span>` +
    `<span class="np-drag-ghost__text"></span>`
  ;(ghost.querySelector('.np-drag-ghost__text') as HTMLElement).textContent = label
  document.body.appendChild(ghost)

  const onMove = (ev: PointerEvent) => {
    if (!active) return
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
    const drag = active
    cleanup()
    clearReorder(view)
    if (!drag.moved) return
    drop(ev, drag)
  }

  // 타임라인 스크롤 컨테이너 탐색 (드래그 동안 상/하단 엣지 자동 스크롤)
  const slotEl = document.querySelector('[data-tl-slot]') as HTMLElement | null
  const scrollEl = slotEl?.closest<HTMLElement>('[class*="overflow-y-auto"]') ?? null

  active = {
    lineNumber, content, view, ghost, moved: false,
    scrollEl, lastX: e.clientX, lastY: e.clientY, rafId: null, onMove, onUp,
  }
  active.rafId = requestAnimationFrame(edgeScrollStep)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

function cleanup() {
  if (!active) return
  window.removeEventListener('pointermove', active.onMove)
  window.removeEventListener('pointerup', active.onUp)
  window.removeEventListener('pointercancel', active.onUp)
  if (active.rafId != null) cancelAnimationFrame(active.rafId)
  active.ghost.remove()
  active = null
  useTimelineDragStore.getState().setPreview(null)
}

// 상/하단 엣지 근처에서 타임라인 자동 스크롤 (보이지 않는 시간대에 드롭 가능)
function edgeScrollStep() {
  if (!active) return
  const { scrollEl, lastX, lastY, view } = active
  if (scrollEl) {
    const r = scrollEl.getBoundingClientRect()
    const dTop = lastY - r.top
    const dBot = r.bottom - lastY
    let speed = 0
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

/** elementFromPoint → 타임라인 슬롯의 date/hour/minute (없으면 null) */
function slotInfoAt(clientX: number, clientY: number) {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
  const slot = el?.closest('[data-tl-slot]') as HTMLElement | null
  if (!slot) return null
  const date = slot.getAttribute('data-tl-date') ?? ''
  const baseHour = parseInt(slot.getAttribute('data-tl-hour') ?? '0', 10)
  const rect = slot.getBoundingClientRect()
  const within = Math.max(0, Math.min(clientY - rect.top, SLOT_H))
  // 절대 분으로 스냅 → 시간 행 하단에서 다음 시각으로 자연스럽게 넘어감
  // (행별 %60 스냅은 하단 ~7px에서 같은 시각 :00으로 튀는 버그가 있었음)
  const total = Math.min(snap15(baseHour * 60 + (within / SLOT_H) * 60), 23 * 60 + 45)
  return { date, hour: Math.floor(total / 60), minute: total % 60 }
}

// ── 드롭 처리 ────────────────────────────────────────────────────────────────

function drop(e: PointerEvent, drag: ActiveDrag) {
  // 1) 타임라인 슬롯에 드롭 → TimeBlock 생성
  const slot = slotInfoAt(e.clientX, e.clientY)
  if (slot) {
    createTimeBlock(slot.date, slot.hour, slot.minute, drag.content)
    return
  }

  // 2) 에디터 본문에 드롭 → 줄 재정렬
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  if (el?.closest('.cm-content')) {
    reorder(e, drag)
  }
}

function createTimeBlock(date: string, hour: number, minute: number, content: string) {
  const rawLine = content.trim()
  const m = rawLine.match(MARKER_RE)
  const linePrefix = m ? m[0] : ''
  const cleanContent = rawLine.slice(linePrefix.length).trim()
  if (!cleanContent || !date) return
  const timeRange = formatTimeRange(hour, minute, DEFAULT_DURATION)
  const newLine = linePrefix
    ? `${linePrefix.trimEnd()} ${timeRange} ${cleanContent}`
    : `${timeRange} ${rawLine}`
  useTimeBlockStore.getState().addTimeBlock({
    date, startHour: hour, startMinute: minute, duration: DEFAULT_DURATION, content: cleanContent,
  })
  useLineUpdateStore.getState().requestUpdate(rawLine, newLine)
}

function reorder(e: PointerEvent, drag: ActiveDrag) {
  const { view } = drag
  const dropPos = view.posAtCoords({ x: e.clientX, y: e.clientY })
  if (dropPos == null) return
  const dragIdx = drag.lineNumber - 1
  const dropIdx = view.state.doc.lineAt(dropPos).number - 1
  if (dragIdx === dropIdx) return
  const lines = view.state.doc.toString().split('\n')
  const [removed] = lines.splice(dragIdx, 1)
  const adjusted = dragIdx < dropIdx ? dropIdx - 1 : dropIdx
  lines.splice(adjusted, 0, removed)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: lines.join('\n') } })
}

// ── 드롭 대상 하이라이트 ───────────────────────────────────────────────────────

function highlightUnderXY(x: number, y: number, view: EditorView) {
  // 타임라인 슬롯 위 → 미리보기 블록(시작시각 + 길이) 표시
  const slot = slotInfoAt(x, y)
  if (slot) {
    useTimelineDragStore.getState().setPreview({ ...slot, duration: DEFAULT_DURATION })
    clearReorder(view)
    return
  }
  useTimelineDragStore.getState().setPreview(null)

  // 에디터 본문 위 → 줄 재정렬 인디케이터
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (el?.closest('.cm-content')) {
    const pos = view.posAtCoords({ x, y })
    if (pos != null) {
      const lineNum = view.state.doc.lineAt(pos).number
      const eff = setReorderLine(lineNum)
      if (eff) view.dispatch({ effects: eff })
      return
    }
  }
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
