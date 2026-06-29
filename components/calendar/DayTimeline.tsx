'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { addDays, format, parseISO } from 'date-fns'
import { useTimeBlockStore, type TimeBlock } from '@/lib/stores/timeBlockStore'
import { useLineUpdateStore } from '@/lib/stores/lineUpdateStore'
import { DRAG_TYPE, type LineDragData } from '@/components/editor/extensions/dragHandle'
import { formatTimeRange } from '@/lib/parser/timeBlockParser'
import { useAuthStore } from '@/lib/stores/authStore'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useTimelineDragStore } from '@/lib/dnd/timelineDragStore'
import { useTimeblockLinkStore, tbKey } from '@/lib/stores/timeblockLinkStore'
import {
  fetchCalendarList,
  fetchAllCalendarEventsForRange,
  createCalendarEvent,
  createAllDayEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  eventToTimeRange, type GoogleCalendarEvent,
} from '@/lib/google/calendar'

interface DayTimelineProps {
  date: string   // YYYY-MM-DD anchor date
  days?: number  // 1–7 columns (default 1)
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const SLOT_H = 60              // px per hour
const PX_PER_MIN = SLOT_H / 60
const SNAP = 15
const DEFAULT_DURATION = 30
const TOTAL_H = HOURS.length * SLOT_H

const getW = () => window as unknown as Record<string, unknown>

function snapTo15(m: number) { return Math.round(m / SNAP) * SNAP }

// ── Day column header labels ───────────────────────────────────────────────

const DAY_FMT = ['EEE\nd', 'EEE d', 'EEE, MMM d']

export default function DayTimeline({ date, days = 1 }: DayTimelineProps) {
  // ── Time ─────────────────────────────────────────────────────────────────
  const [now, setNow] = useState<Date | null>(null)
  const nowLineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  // 현재 시간으로 자동 스크롤 (최초 1회)
  useEffect(() => {
    if (!nowLineRef.current) return
    nowLineRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [!!now])  // now가 처음 세팅될 때 1번만

  const currentHour   = now?.getHours() ?? -1
  const currentMinute = now?.getMinutes() ?? 0
  const todayStr      = now ? format(now, 'yyyy-MM-dd') : ''

  // ── Stores ────────────────────────────────────────────────────────────────
  const { timeBlocks, addTimeBlock, removeTimeBlock, updateTimeBlock } = useTimeBlockStore()
  const { requestUpdate } = useLineUpdateStore()
  const { googleAccessToken } = useAuthStore()
  const {
    calendars, enabledCalendarIds,
    setCalendars, eventsByDate, setFetching, fetchingDates,
    mergeEvents, addEvent, removeEvent, patchEvent,
  } = useCalendarEventStore()

  // pointer 드래그 미리보기 (pointerLineDrag → 슬롯 위 점선 블록)
  const dragPreview = useTimelineDragStore(s => s.preview)

  // ── Local state ───────────────────────────────────────────────────────────
  const [dragOverSlot, setDragOverSlot] = useState<{
    date: string; hour: number; minute: number; duration: number
  } | null>(null)

  const [resizing, setResizing] = useState<{
    blockId: string; startY: number; startDuration: number
  } | null>(null)

  const [resizingTop, setResizingTop] = useState<{
    blockId: string; originalEndMins: number
  } | null>(null)

  // ── New-event inline form ─────────────────────────────────────────────────
  const [newEventSlot, setNewEventSlot] = useState<{
    date: string; startHour: number; startMinute: number
  } | null>(null)
  const [newEventTitle, setNewEventTitle] = useState('')
  // 종일(all-day) 새 이벤트 입력 (date + 제목)
  const [newAllDayDate, setNewAllDayDate] = useState<string | null>(null)
  const [newAllDayTitle, setNewAllDayTitle] = useState('')
  // Default to "primary" literal — always resolves to the user's main calendar.
  // Updated to a real ID once calendars load (prefers writable owner/writer calendars).
  const [newEventCalId, setNewEventCalId] = useState<string>('primary')
  const [savingEvent, setSavingEvent] = useState(false)
  const newEventInputRef = useRef<HTMLInputElement>(null)
  const newEventFormRef  = useRef<HTMLDivElement>(null)
  const allDayInputRef   = useRef<HTMLInputElement>(null)

  // Close new-event form on outside click
  useEffect(() => {
    if (!newEventSlot) return
    function onDown(e: MouseEvent) {
      if (newEventFormRef.current && !newEventFormRef.current.contains(e.target as Node)) {
        setNewEventSlot(null)
        setNewEventTitle('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [newEventSlot])

  // Writable calendars: owner or writer access only
  const writableCalendars = useMemo(
    () => calendars.filter(c => !c.accessRole || c.accessRole === 'owner' || c.accessRole === 'writer'),
    [calendars]
  )

  // Pick primary (or first writable) calendar when calendars load
  useEffect(() => {
    if (writableCalendars.length === 0) return
    const primary = writableCalendars.find(c => c.primary) ?? writableCalendars[0]
    setNewEventCalId(primary.id)
  }, [writableCalendars])

  useEffect(() => {
    if (newEventSlot) setTimeout(() => newEventInputRef.current?.focus(), 50)
  }, [newEventSlot])

  // ── Google Calendar event drag/resize state ───────────────────────────────
  const [gcalDrag, setGcalDrag] = useState<{
    ev: GoogleCalendarEvent
    date: string
    startMins: number   // drag start absolute minutes
    durMins: number
    grabOffsetMins: number
  } | null>(null)

  const [gcalResizing, setGcalResizing] = useState<{
    ev: GoogleCalendarEvent
    date: string
    startY: number
    startDurMins: number
    startStartMins: number
  } | null>(null)

  const [gcalResizingTop, setGcalResizingTop] = useState<{
    ev: GoogleCalendarEvent
    date: string
    originalEndMins: number
  } | null>(null)

  // Optimistic override while dragging/resizing a GCal event
  const [gcalOverride, setGcalOverride] = useState<{
    id: string; startMins: number; durMins: number
  } | null>(null)

  // ── Event detail panel ────────────────────────────────────────────────────
  const [eventPanel, setEventPanel] = useState<{
    ev: GoogleCalendarEvent
    date: string
    anchorRect: DOMRect
  } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 이벤트 패널 내 이름 변경
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')

  // Close panel on outside click
  useEffect(() => {
    if (!eventPanel) return
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setEventPanel(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [eventPanel])

  // 다른 이벤트 패널 열면 rename 모드 초기화
  useEffect(() => { setRenaming(false) }, [eventPanel?.ev.id])

  // 이벤트 이름 변경 (Google 연동)
  async function confirmRename(ev: GoogleCalendarEvent, evDate: string) {
    const title = renameText.trim()
    setRenaming(false)
    if (!title || title === ev.summary || !googleAccessToken) return
    patchEvent(evDate, evDate, ev.id, { summary: title })
    try {
      await updateCalendarEvent(googleAccessToken, ev.calendarId, ev.id, { summary: title })
    } catch (err) {
      console.error('[rename event]', err)
      patchEvent(evDate, evDate, ev.id, { summary: ev.summary })
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const dates = useMemo(() => {
    const anchor = parseISO(date)
    return Array.from({ length: days }, (_, i) =>
      format(addDays(anchor, i), 'yyyy-MM-dd')
    )
  }, [date, days])

  const blocksByDate = useMemo(() => {
    const map: Record<string, TimeBlock[]> = {}
    for (const d of dates) map[d] = []
    for (const b of timeBlocks) {
      if (map[b.date] !== undefined) map[b.date].push(b)
    }
    return map
  }, [timeBlocks, dates])

  const todayInView = dates.includes(todayStr)

  // ── Google Calendar: 캘린더 목록 fetch ───────────────────────────────────
  // accessToken 변경마다 항상 re-fetch (캐시 무효화 + accessRole 최신화)
  useEffect(() => {
    if (!googleAccessToken) return
    fetchCalendarList(googleAccessToken)
      .then(list => setCalendars(list))
      .catch(err => console.error('[CalendarList]', err))
  }, [googleAccessToken])

  // ── Google Calendar: 날짜 범위 이벤트 fetch (한 번에) ───────────────────
  const fetchedTokenRef = useRef<string | null>(null)
  useEffect(() => {
    if (!googleAccessToken || calendars.length === 0 || dates.length === 0) return
    // 토큰이 바뀌었으면(재연결/자동갱신) 캐시 무시하고 전체 재fetch
    const tokenChanged = fetchedTokenRef.current !== googleAccessToken
    const unfetched = tokenChanged
      ? [...dates]
      : dates.filter(d => eventsByDate[d] === undefined && !fetchingDates.has(d))
    if (unfetched.length === 0) return
    fetchedTokenRef.current = googleAccessToken

    const startDate = unfetched[0]
    const endDate   = unfetched[unfetched.length - 1]
    unfetched.forEach(d => setFetching(d, true))

    fetchAllCalendarEventsForRange(googleAccessToken, calendars, enabledCalendarIds, startDate, endDate)
      .then(grouped => {
        // 이벤트 없는 날도 빈 배열로 표시해 중복 fetch 방지
        const full: Record<string, GoogleCalendarEvent[]> = {}
        unfetched.forEach(d => { full[d] = grouped[d] ?? [] })
        mergeEvents(full)
      })
      .catch(err => {
        if (err instanceof Error && err.message !== 'GOOGLE_TOKEN_EXPIRED')
          console.error('[Timeline fetch]', err)
      })
      .finally(() => unfetched.forEach(d => setFetching(d, false)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleAccessToken, calendars, enabledCalendarIds, dates])

  // 타임블록 완료(체크) 전환 → 링크된 Google 이벤트 제목에 ✓ 추가/제거
  const syncedDoneRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!googleAccessToken) return
    const getLink = useTimeblockLinkStore.getState().getLink
    for (const b of timeBlocks) {
      const status = getTaskStatus(b.linePrefix)
      const done = status === 'done' || status === 'cancelled'
      const key = tbKey(b.date, b.startHour, b.startMinute, b.content)
      const link = getLink(key)
      if (!link) continue
      if (done && !syncedDoneRef.current.has(key)) {
        syncedDoneRef.current.add(key)
        updateCalendarEvent(googleAccessToken, link.calendarId, link.eventId, { summary: `✓ ${b.content}` })
          .catch(err => console.error('[done→gcal]', err))
      } else if (!done && syncedDoneRef.current.has(key)) {
        syncedDoneRef.current.delete(key)
        updateCalendarEvent(googleAccessToken, link.calendarId, link.eventId, { summary: b.content })
          .catch(err => console.error('[undone→gcal]', err))
      }
    }
  }, [timeBlocks, googleAccessToken])

  // gridRef is on the flex container (gutter + columns) — used for Y calculation
  const gridRef = useRef<HTMLDivElement>(null)

  // ── 드래그 중 엣지 자동 스크롤 ────────────────────────────────────────────
  const autoScrollRef = useRef<number | null>(null)

  function startEdgeScroll(clientY: number) {
    // 가장 가까운 scroll 가능한 조상 찾기
    const scrollEl = gridRef.current?.closest<HTMLElement>('[class*="overflow-y-auto"]')
    if (!scrollEl) return

    const rect = scrollEl.getBoundingClientRect()
    const ZONE = 80      // 엣지에서 80px 이내일 때 스크롤 시작
    const MAX_SPEED = 12  // px/frame

    if (autoScrollRef.current) cancelAnimationFrame(autoScrollRef.current)

    const step = () => {
      const distFromTop = clientY - rect.top
      const distFromBot = rect.bottom - clientY
      let speed = 0
      if (distFromTop < ZONE) speed = -Math.round(MAX_SPEED * (1 - distFromTop / ZONE))
      else if (distFromBot < ZONE) speed = Math.round(MAX_SPEED * (1 - distFromBot / ZONE))

      if (speed !== 0) {
        scrollEl.scrollTop += speed
        autoScrollRef.current = requestAnimationFrame(step)
      } else {
        autoScrollRef.current = null
      }
    }
    autoScrollRef.current = requestAnimationFrame(step)
  }

  function stopEdgeScroll() {
    if (autoScrollRef.current) {
      cancelAnimationFrame(autoScrollRef.current)
      autoScrollRef.current = null
    }
  }

  // 컴포넌트 언마운트 시 정리
  useEffect(() => () => stopEdgeScroll(), [])

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getLineDragPayload(e: React.DragEvent): LineDragData | null {
    const g = getW()['__npLineDrag'] as LineDragData | null
    if (g?.type === 'line') return g
    try {
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      if (raw) return JSON.parse(raw) as LineDragData
    } catch { /* ignore */ }
    return null
  }

  /** Snap minute from Y position within an hour-row div. */
  function minuteFromRowEvent(e: { clientY: number; currentTarget: EventTarget }): number {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const offsetY = Math.max(0, Math.min(e.clientY - rect.top, SLOT_H - 1))
    return snapTo15((offsetY / SLOT_H) * 60) % 60
  }

  function getDragDuration(): number {
    const id = getW()['__npBlockDrag'] as string | null
    if (id) {
      const b = useTimeBlockStore.getState().timeBlocks.find(b => b.id === id)
      if (b) return b.duration
    }
    return DEFAULT_DURATION
  }

  /** Y → { hour, minute } using the shared grid ref, applying grab-offset for blocks. */
  function slotFromClientY(clientY: number): { hour: number; minute: number } {
    const top = gridRef.current?.getBoundingClientRect().top ?? 0
    const grabY = (getW()['__npBlockGrabY'] as number | null) ?? 0
    const rawMins = Math.max(0, (clientY - grabY - top) / PX_PER_MIN)
    const snapped = Math.min(23 * 60 + 45, snapTo15(rawMins))
    return { hour: Math.floor(snapped / 60), minute: snapped % 60 }
  }

  function minsFromClientY(clientY: number): number {
    const top = gridRef.current?.getBoundingClientRect().top ?? 0
    return Math.min(23 * 60 + 45, snapTo15(Math.max(0, (clientY - top) / PX_PER_MIN)))
  }

  // ── Drag-over / drop ──────────────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent, targetDate: string, hour: number) {
    const hasLine  = document.body.getAttribute('data-np-dragging') === 'line' || !!getW()['__npLineDrag']
    const hasBlock = !!getW()['__npBlockDrag']
    if (!hasLine && !hasBlock) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    startEdgeScroll(e.clientY)   // ← 엣지 자동 스크롤
    const slot = hasBlock
      ? slotFromClientY(e.clientY)
      : { hour, minute: minuteFromRowEvent(e) }
    const duration = getDragDuration()
    setDragOverSlot(prev =>
      prev?.date === targetDate && prev.hour === slot.hour &&
      prev.minute === slot.minute && prev.duration === duration
        ? prev : { date: targetDate, ...slot, duration }
    )
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDragOverSlot(null)
      stopEdgeScroll()   // ← 타임라인 영역 벗어나면 정지
    }
  }

  function handleDrop(e: React.DragEvent, targetDate: string, hour: number) {
    setDragOverSlot(null)
    stopEdgeScroll()   // ← drop 시 정지

    // ── Block-move ──────────────────────────────────────────────────────────
    const movingId = getW()['__npBlockDrag'] as string | null
    if (movingId) {
      const { hour: tHour, minute: tMin } = slotFromClientY(e.clientY)
      getW()['__npBlockDrag'] = null
      getW()['__npBlockGrabY'] = null
      e.preventDefault()
      const block = useTimeBlockStore.getState().timeBlocks.find(b => b.id === movingId)
      if (!block) return
      if (block.date === targetDate && block.startHour === tHour && block.startMinute === tMin) return
      const oldLine = block.noteLineText
      updateTimeBlock(movingId, { date: targetDate, startHour: tHour, startMinute: tMin })
      if (oldLine !== undefined && block.originalContent !== undefined) {
        const prefix = block.linePrefix ?? ''
        requestUpdate(oldLine, `${prefix}${formatTimeRange(tHour, tMin, block.duration)} ${block.originalContent}`)
      }
      return
    }

    // ── Line from editor ────────────────────────────────────────────────────
    const payload = getLineDragPayload(e)
    if (!payload) return
    e.preventDefault()
    const startMinute  = minuteFromRowEvent(e)
    const rawLine      = payload.content.trim()
    const markerMatch  = rawLine.match(/^(-\s*\[.?\]\s*|-\s+|\*\s+|\+\s+)/)
    const linePrefix   = markerMatch ? markerMatch[0] : ''
    const cleanContent = rawLine.slice(linePrefix.length).trim()
    if (!cleanContent) return
    const timeRange = formatTimeRange(hour, startMinute, DEFAULT_DURATION)
    const newLine   = linePrefix
      ? `${linePrefix.trimEnd()} ${timeRange} ${cleanContent}`
      : `${timeRange} ${rawLine}`
    addTimeBlock({ date: targetDate, startHour: hour, startMinute, duration: DEFAULT_DURATION, content: cleanContent })
    requestUpdate(rawLine, newLine)
  }

  // ── Positioning ───────────────────────────────────────────────────────────

  function blockStyle(block: TimeBlock) {
    const startMins       = block.startHour * 60 + block.startMinute
    const clampedDuration = Math.min(block.duration, 24 * 60 - startMins)
    return {
      top:    block.startHour * SLOT_H + block.startMinute * PX_PER_MIN,
      height: Math.max(clampedDuration * PX_PER_MIN, 20),
    }
  }

  function formatTime(h: number, m: number) {
    return `${h}:${m.toString().padStart(2, '0')}`
  }

  function toISO(dateStr: string, h: number, m: number) {
    return `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`
  }

  // ── Resize – bottom ───────────────────────────────────────────────────────

  function onResizeDn(e: React.PointerEvent, block: TimeBlock) {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResizing({ blockId: block.id, startY: e.clientY, startDuration: block.duration })
  }
  function onResizeMv(e: React.PointerEvent, block: TimeBlock) {
    if (!resizing || resizing.blockId !== block.id) return
    const delta  = (e.clientY - resizing.startY) / PX_PER_MIN
    const maxDur = 24 * 60 - (block.startHour * 60 + block.startMinute)
    updateTimeBlock(block.id, { duration: Math.min(maxDur, Math.max(SNAP, snapTo15(resizing.startDuration + delta))) })
  }
  function onResizeUp() {
    if (resizing) {
      const b = useTimeBlockStore.getState().timeBlocks.find(b => b.id === resizing.blockId)
      if (b?.noteLineText && b.originalContent !== undefined)
        requestUpdate(b.noteLineText, `${b.linePrefix ?? ''}${formatTimeRange(b.startHour, b.startMinute, b.duration)} ${b.originalContent}`)
    }
    setResizing(null)
  }

  // ── Resize – top ──────────────────────────────────────────────────────────

  function onResizeTopDn(e: React.PointerEvent, block: TimeBlock) {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResizingTop({ blockId: block.id, originalEndMins: block.startHour * 60 + block.startMinute + block.duration })
  }
  function onResizeTopMv(e: React.PointerEvent, block: TimeBlock) {
    if (!resizingTop || resizingTop.blockId !== block.id) return
    const newStart = Math.min(resizingTop.originalEndMins - SNAP, minsFromClientY(e.clientY))
    updateTimeBlock(block.id, {
      startHour:   Math.floor(newStart / 60),
      startMinute: newStart % 60,
      duration:    resizingTop.originalEndMins - newStart,
    })
  }
  function onResizeTopUp() {
    if (resizingTop) {
      const b = useTimeBlockStore.getState().timeBlocks.find(b => b.id === resizingTop.blockId)
      if (b?.noteLineText && b.originalContent !== undefined)
        requestUpdate(b.noteLineText, `${b.linePrefix ?? ''}${formatTimeRange(b.startHour, b.startMinute, b.duration)} ${b.originalContent}`)
    }
    setResizingTop(null)
  }

  // ── Create Google Calendar event ─────────────────────────────────────────

  async function handleCreateEvent() {
    if (!newEventSlot || !newEventTitle.trim() || !googleAccessToken) return
    // If no calendar selected yet, fall back to "primary"
    const calId = newEventCalId || 'primary'
    setSavingEvent(true)
    const { date: evDate, startHour, startMinute } = newEventSlot
    const endMins = startHour * 60 + startMinute + DEFAULT_DURATION
    const endH = Math.floor(endMins / 60), endM = endMins % 60
    const cal = calendars.find(c => c.id === calId)
    console.log('[createEvent] calendarId=', calId, 'writableCalendars=', writableCalendars.map(c => `${c.summary}(${c.id})`))
    try {
      const created = await createCalendarEvent(googleAccessToken, {
        calendarId:    calId,
        summary:       newEventTitle.trim(),
        startDateTime: toISO(evDate, startHour, startMinute),
        endDateTime:   toISO(evDate, endH, endM),
      })
      // Attach calendar color
      created.calendarColor = cal?.backgroundColor ?? '#4285f4'
      addEvent(evDate, created as GoogleCalendarEvent)
    } catch (err) {
      console.error('[createCalendarEvent]', err)
    } finally {
      setSavingEvent(false)
      setNewEventSlot(null)
      setNewEventTitle('')
    }
  }

  // 종일 이벤트 생성 (Google Calendar 연동)
  async function handleCreateAllDay() {
    if (!newAllDayDate || !newAllDayTitle.trim() || !googleAccessToken) {
      setNewAllDayDate(null); setNewAllDayTitle(''); return
    }
    const calId = newEventCalId || 'primary'
    const cal = calendars.find(c => c.id === calId)
    setSavingEvent(true)
    try {
      const created = await createAllDayEvent(googleAccessToken, {
        calendarId: calId,
        summary: newAllDayTitle.trim(),
        date: newAllDayDate,
      })
      created.calendarColor = cal?.backgroundColor ?? '#4285f4'
      addEvent(newAllDayDate, created as GoogleCalendarEvent)
    } catch (err) {
      console.error('[createAllDayEvent]', err)
    } finally {
      setSavingEvent(false)
      setNewAllDayDate(null)
      setNewAllDayTitle('')
    }
  }

  // ── GCal event move (pointer drag) ───────────────────────────────────────

  function onGcalDragStart(e: React.PointerEvent, ev: GoogleCalendarEvent, date: string) {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const { startHour, startMinute, endHour, endMinute } = eventToTimeRange(ev)
    const startMins = startHour * 60 + startMinute
    const durMins   = endHour * 60 + endMinute - startMins
    const top = gridRef.current?.getBoundingClientRect().top ?? 0
    const grabOffsetMins = Math.max(0, (e.clientY - top) / PX_PER_MIN - startMins)
    setGcalDrag({ ev, date, startMins, durMins, grabOffsetMins })
    setGcalOverride({ id: ev.id, startMins, durMins })
  }

  function onGcalDragMove(e: React.PointerEvent) {
    if (!gcalDrag) return
    const top = gridRef.current?.getBoundingClientRect().top ?? 0
    const rawMins = (e.clientY - top) / PX_PER_MIN - gcalDrag.grabOffsetMins
    const snapped = Math.min(23 * 60 + 45 - gcalDrag.durMins, Math.max(0, snapTo15(rawMins)))
    setGcalOverride({ id: gcalDrag.ev.id, startMins: snapped, durMins: gcalDrag.durMins })
  }

  async function onGcalDragEnd() {
    if (!gcalDrag || !gcalOverride || !googleAccessToken) { setGcalDrag(null); setGcalOverride(null); return }
    const { ev, date } = gcalDrag
    const { startMins, durMins } = gcalOverride
    const newStartH = Math.floor(startMins / 60), newStartM = startMins % 60
    const newEndMins = startMins + durMins
    const newEndH = Math.floor(newEndMins / 60), newEndM = newEndMins % 60
    // Optimistic update in store
    const updatedStart = { dateTime: toISO(date, newStartH, newStartM), date: undefined }
    const updatedEnd   = { dateTime: toISO(date, newEndH,   newEndM),   date: undefined }
    patchEvent(date, date, ev.id, { start: updatedStart, end: updatedEnd })
    setGcalDrag(null); setGcalOverride(null)
    try {
      await updateCalendarEvent(googleAccessToken, ev.calendarId, ev.id, {
        startDateTime: toISO(date, newStartH, newStartM),
        endDateTime:   toISO(date, newEndH, newEndM),
      })
    } catch (err) { console.error('[updateCalendarEvent move]', err) }
  }

  // ── GCal event resize – bottom ────────────────────────────────────────────

  function onGcalResizeDn(e: React.PointerEvent, ev: GoogleCalendarEvent, date: string) {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const { startHour, startMinute, endHour, endMinute } = eventToTimeRange(ev)
    const startMins = startHour * 60 + startMinute
    const durMins   = endHour * 60 + endMinute - startMins
    setGcalResizing({ ev, date, startY: e.clientY, startDurMins: durMins, startStartMins: startMins })
    setGcalOverride({ id: ev.id, startMins, durMins })
  }

  function onGcalResizeMv(e: React.PointerEvent) {
    if (!gcalResizing || !gcalOverride) return
    const { startStartMins, startDurMins } = gcalResizing
    const delta = (e.clientY - gcalResizing.startY) / PX_PER_MIN
    const newDur = Math.max(SNAP, Math.min(24 * 60 - startStartMins, snapTo15(startDurMins + delta)))
    setGcalOverride({ id: gcalResizing.ev.id, startMins: startStartMins, durMins: newDur })
  }

  async function onGcalResizeUp() {
    if (!gcalResizing || !gcalOverride || !googleAccessToken) { setGcalResizing(null); setGcalOverride(null); return }
    const { ev, date } = gcalResizing
    const { startMins, durMins } = gcalOverride
    const startH = Math.floor(startMins / 60), startM = startMins % 60
    const endMins = startMins + durMins
    const endH = Math.floor(endMins / 60), endM = endMins % 60
    const updatedEnd = { dateTime: toISO(date, endH, endM), date: undefined }
    patchEvent(date, date, ev.id, { end: updatedEnd })
    setGcalResizing(null); setGcalOverride(null)
    try {
      await updateCalendarEvent(googleAccessToken, ev.calendarId, ev.id, {
        startDateTime: toISO(date, startH, startM),
        endDateTime:   toISO(date, endH, endM),
      })
    } catch (err) { console.error('[updateCalendarEvent resize]', err) }
  }

  // ── GCal event resize – top ───────────────────────────────────────────────

  function onGcalResizeTopDn(e: React.PointerEvent, ev: GoogleCalendarEvent, date: string) {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const { startHour, startMinute, endHour, endMinute } = eventToTimeRange(ev)
    const originalEndMins = endHour * 60 + endMinute
    setGcalResizingTop({ ev, date, originalEndMins })
    setGcalOverride({ id: ev.id, startMins: startHour * 60 + startMinute, durMins: endHour * 60 + endMinute - startHour * 60 - startMinute })
  }

  function onGcalResizeTopMv(e: React.PointerEvent) {
    if (!gcalResizingTop || !gcalOverride) return
    const newStart = Math.min(gcalResizingTop.originalEndMins - SNAP, minsFromClientY(e.clientY))
    setGcalOverride({ id: gcalResizingTop.ev.id, startMins: newStart, durMins: gcalResizingTop.originalEndMins - newStart })
  }

  async function onGcalResizeTopUp() {
    if (!gcalResizingTop || !gcalOverride || !googleAccessToken) { setGcalResizingTop(null); setGcalOverride(null); return }
    const { ev, date, originalEndMins } = gcalResizingTop
    const { startMins } = gcalOverride
    const startH = Math.floor(startMins / 60), startM = startMins % 60
    const endH = Math.floor(originalEndMins / 60), endM = originalEndMins % 60
    const updatedStart = { dateTime: toISO(date, startH, startM), date: undefined }
    patchEvent(date, date, ev.id, { start: updatedStart })
    setGcalResizingTop(null); setGcalOverride(null)
    try {
      await updateCalendarEvent(googleAccessToken, ev.calendarId, ev.id, {
        startDateTime: toISO(date, startH, startM),
        endDateTime:   toISO(date, endH, endM),
      })
    } catch (err) { console.error('[updateCalendarEvent resizeTop]', err) }
  }

  // ── Task status ───────────────────────────────────────────────────────────

  function getTaskStatus(lp?: string): 'done' | 'cancelled' | 'open' | null {
    if (!lp) return null
    if (/\[x\]/i.test(lp)) return 'done'
    if (/\[-\]/.test(lp))  return 'cancelled'
    if (/\[ \]/.test(lp))  return 'open'
    return null
  }

  // ── Block renderer ────────────────────────────────────────────────────────

  function renderBlock(block: TimeBlock) {
    const { top, height }   = blockStyle(block)
    const isResizingThis    = resizing?.blockId === block.id || resizingTop?.blockId === block.id
    const taskStatus        = getTaskStatus(block.linePrefix)
    const isDone            = taskStatus === 'done'
    const isCancelled       = taskStatus === 'cancelled'
    const isCompleted       = isDone || isCancelled

    return (
      <div
        key={block.id}
        draggable
        onDragStart={e => {
          e.stopPropagation()
          getW()['__npBlockDrag'] = block.id
          e.dataTransfer.effectAllowed = 'move'
          getW()['__npBlockGrabY'] = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top
        }}
        onDragEnd={() => {
          getW()['__npBlockDrag'] = null
          getW()['__npBlockGrabY'] = null
          setDragOverSlot(null)
        }}
        onDragOver={e => {
          const hasLine  = document.body.getAttribute('data-np-dragging') === 'line' || !!getW()['__npLineDrag']
          const hasBlock = !!getW()['__npBlockDrag']
          if (!hasLine && !hasBlock) return
          e.preventDefault(); e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          const slot     = slotFromClientY(e.clientY)
          const duration = getDragDuration()
          setDragOverSlot(prev =>
            prev?.date === block.date && prev.hour === slot.hour &&
            prev.minute === slot.minute && prev.duration === duration
              ? prev : { date: block.date, ...slot, duration }
          )
        }}
        onDrop={e => { e.stopPropagation(); handleDrop(e, block.date, block.startHour) }}
        className="absolute left-1 right-1 rounded px-2 py-1 text-xs text-white
                   pointer-events-auto select-none flex flex-col overflow-hidden"
        style={{
          top, height,
          backgroundColor: block.color,
          opacity:  isCompleted ? 0.45 : 0.9,
          zIndex:   isResizingThis ? 20 : 10,
          cursor:   'grab',
        }}
        title={block.content}
      >
        {/* Top resize */}
        <div
          className="absolute top-0 left-0 right-0 flex items-center justify-center"
          style={{ height: 8, cursor: 'ns-resize', zIndex: 5 }}
          onPointerDown={ev => onResizeTopDn(ev, block)}
          onPointerMove={ev => onResizeTopMv(ev, block)}
          onPointerUp={onResizeTopUp}
          onPointerCancel={onResizeTopUp}
        >
          <div className="w-8 h-[2px] rounded-full bg-white/30" />
        </div>

        {/* Content */}
        <div className="flex items-center gap-1 overflow-hidden flex-1 min-h-0 mt-1">
          {taskStatus === 'open' && (
            <svg className="w-3 h-3 flex-shrink-0 opacity-70" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
          {isDone && (
            <svg className="w-3 h-3 flex-shrink-0 opacity-80" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M3.5 6l1.8 1.8 3.2-3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {isCancelled && (
            <svg className="w-3 h-3 flex-shrink-0 opacity-80" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M4 4l4 4M8 4l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          <span
            className="truncate flex-1"
            style={isCompleted ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}
          >
            {block.content}
          </span>
          <span className="opacity-60 text-[10px] flex-shrink-0">
            {formatTime(block.startHour, block.startMinute)}
          </span>
          <button
            className="opacity-60 hover:opacity-100 flex-shrink-0 leading-none"
            onClick={ev => {
              ev.stopPropagation()
              if (block.noteLineText) {
                requestUpdate(block.noteLineText, (block.linePrefix ?? '') + (block.originalContent ?? block.content))
              }
              removeTimeBlock(block.id)
            }}
          >×</button>
        </div>

        {/* Bottom resize */}
        <div
          className="absolute bottom-0 left-0 right-0 flex items-center justify-center"
          style={{ height: 8, cursor: 'ns-resize' }}
          onPointerDown={ev => onResizeDn(ev, block)}
          onPointerMove={ev => onResizeMv(ev, block)}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        >
          <div className="w-8 h-[2px] rounded-full bg-white/30" />
        </div>
      </div>
    )
  }

  function renderCalendarEvent(ev: GoogleCalendarEvent, colDate: string) {
    const base = eventToTimeRange(ev)
    if (base.allDay) return null
    // 타임블록으로 생성한 이벤트는 로컬 타임블록이 대표 → 중복 방지 위해 스킵
    if (ev.extendedProperties?.private?.npTimeblock) return null

    // Apply optimistic override while dragging/resizing
    let startH = base.startHour, startM = base.startMinute
    let endH   = base.endHour,   endM   = base.endMinute
    if (gcalOverride?.id === ev.id) {
      const { startMins, durMins } = gcalOverride
      startH = Math.floor(startMins / 60); startM = startMins % 60
      const em = startMins + durMins
      endH = Math.floor(em / 60); endM = em % 60
    }

    const top      = startH * SLOT_H + startM * PX_PER_MIN
    const durMins  = endH * 60 + endM - startH * 60 - startM
    const height   = Math.max(durMins * PX_PER_MIN, 18)
    const color    = ev.calendarColor ?? '#4285f4'
    const startStr = `${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}`
    const endStr   = `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`
    const isActive = gcalDrag?.ev.id === ev.id || gcalResizing?.ev.id === ev.id || gcalResizingTop?.ev.id === ev.id

    return (
      <div
        key={`gcal-${ev.id}`}
        className="absolute left-1 right-1 rounded overflow-hidden pointer-events-auto select-none group"
        style={{ top, height, zIndex: isActive ? 20 : 8, cursor: 'grab' }}
        title={`${ev.summary}\n${startStr} – ${endStr}`}
        // pointer drag to move; short tap (< 5px) → open detail panel
        onPointerDown={e => {
          if ((e.target as HTMLElement).closest('[data-resize]')) return
          onGcalDragStart(e, ev, colDate)
        }}
        onPointerMove={e => {
          if (gcalDrag?.ev.id === ev.id) onGcalDragMove(e)
        }}
        onPointerUp={e => {
          const isDraggingThis   = gcalDrag?.ev.id === ev.id
          const isResizingThis   = gcalResizing?.ev.id === ev.id
          const isResizeTopThis  = gcalResizingTop?.ev.id === ev.id

          // Measure movement to distinguish tap from drag
          const moved = isDraggingThis && gcalOverride
            ? Math.abs(gcalOverride.startMins - (eventToTimeRange(ev).startHour * 60 + eventToTimeRange(ev).startMinute)) >= SNAP
            : false

          if (isDraggingThis) onGcalDragEnd()
          if (isResizingThis) onGcalResizeUp()
          if (isResizeTopThis) onGcalResizeTopUp()

          // Open panel only on tap (no real movement, no resize)
          if (!moved && !isResizingThis && !isResizeTopThis) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setEventPanel(prev =>
              prev?.ev.id === ev.id ? null  // toggle off
                : { ev, date: colDate, anchorRect: rect }
            )
          }
        }}
        onPointerCancel={() => { setGcalDrag(null); setGcalResizing(null); setGcalResizingTop(null); setGcalOverride(null) }}
      >
        {/* Top resize handle */}
        <div
          data-resize="top"
          className="absolute top-0 left-0 right-0 flex items-center justify-center"
          style={{ height: 8, cursor: 'ns-resize', zIndex: 5 }}
          onPointerDown={e => { e.stopPropagation(); onGcalResizeTopDn(e, ev, colDate) }}
          onPointerMove={e => { if (gcalResizingTop?.ev.id === ev.id) onGcalResizeTopMv(e) }}
          onPointerUp={() => onGcalResizeTopUp()}
          onPointerCancel={() => { setGcalResizingTop(null); setGcalOverride(null) }}
        >
          <div className="w-8 h-[2px] rounded-full bg-white/20 group-hover:bg-white/40 transition-opacity" />
        </div>

        {/* 반투명 배경 */}
        <div className="absolute inset-0 rounded" style={{ backgroundColor: color, opacity: 0.15 }} />
        {/* 왼쪽 컬러 바 */}
        <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l" style={{ backgroundColor: color }} />

        {/* 텍스트 */}
        <div className="relative pl-2 pr-1 py-0.5 h-full flex flex-col justify-center overflow-hidden">
          <div className="text-[11px] font-medium leading-tight truncate" style={{ color }}>
            {ev.summary}
          </div>
          {height >= 34 && (
            <div className="text-[10px] leading-tight opacity-70 truncate" style={{ color }}>
              {startStr} – {endStr}
            </div>
          )}
        </div>

        {/* Bottom resize handle */}
        <div
          data-resize="bottom"
          className="absolute bottom-0 left-0 right-0 flex items-center justify-center"
          style={{ height: 8, cursor: 'ns-resize', zIndex: 5 }}
          onPointerDown={e => { e.stopPropagation(); onGcalResizeDn(e, ev, colDate) }}
          onPointerMove={e => { if (gcalResizing?.ev.id === ev.id) onGcalResizeMv(e) }}
          onPointerUp={() => onGcalResizeUp()}
          onPointerCancel={() => { setGcalResizing(null); setGcalOverride(null) }}
        >
          <div className="w-8 h-[2px] rounded-full bg-white/20 group-hover:bg-white/40 transition-opacity" />
        </div>
      </div>
    )
  }

  // ── Event detail panel ───────────────────────────────────────────────────

  function renderEventPanel() {
    if (!eventPanel || typeof window === 'undefined') return null
    const { ev, date: evDate, anchorRect } = eventPanel
    const { startHour, startMinute, endHour, endMinute, allDay } = eventToTimeRange(ev)
    const color = ev.calendarColor ?? '#4285f4'
    const cal   = calendars.find(c => c.id === ev.calendarId)

    // Position: prefer right of block, fall back to left if near right edge
    const PANEL_W = 256
    const PANEL_MARGIN = 8
    let left = anchorRect.right + PANEL_MARGIN
    if (left + PANEL_W > window.innerWidth - 16) {
      left = anchorRect.left - PANEL_W - PANEL_MARGIN
    }
    // Vertical: align to block top, clamp to viewport
    const top = Math.min(
      Math.max(anchorRect.top, 8),
      window.innerHeight - 220
    )

    const startFmt = allDay ? 'All day' : `${String(startHour).padStart(2,'0')}:${String(startMinute).padStart(2,'0')}`
    const endFmt   = allDay ? '' : `${String(endHour).padStart(2,'0')}:${String(endMinute).padStart(2,'0')}`

    return createPortal(
      <div
        ref={panelRef}
        className="fixed z-[200] w-64 rounded-xl shadow-2xl overflow-hidden
                   border border-white/10"
        style={{ top, left, backdropFilter: 'blur(20px)', backgroundColor: 'rgba(28,28,40,0.92)' }}
      >
        {/* Color header strip */}
        <div className="h-[3px] w-full" style={{ backgroundColor: color }} />

        {/* Title (rename 모드면 입력) */}
        <div className="px-4 pt-3 pb-2">
          {renaming ? (
            <input
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmRename(ev, evDate)
                else if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={() => confirmRename(ev, evDate)}
              className="w-full text-sm font-semibold px-2 py-1 rounded bg-white/10
                         border border-blue-400/60 outline-none text-white"
            />
          ) : (
            <div className="text-sm font-semibold text-white leading-snug">{ev.summary}</div>
          )}
        </div>

        {/* Meta info */}
        <div className="px-4 pb-3 flex flex-col gap-1.5 text-xs text-white/60">
          {/* Time */}
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              {allDay ? 'All day' : `${startFmt} – ${endFmt}`}
              {' · '}
              {format(parseISO(evDate), 'MMM d, yyyy')}
            </span>
          </div>

          {/* Calendar */}
          {cal && (
            <div className="flex items-center gap-2">
              <div className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <span className="truncate">{cal.summary}</span>
            </div>
          )}

          {/* Description */}
          {ev.description && (
            <div className="flex items-start gap-2 mt-0.5">
              <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M4 6h16M4 12h16M4 18h7" />
              </svg>
              <span className="line-clamp-3 leading-relaxed">{ev.description}</span>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-white/10 mx-2" />

        {/* Actions */}
        <div className="flex flex-col py-1">
          {/* 이름 변경 */}
          <button
            onClick={() => { setRenameText(ev.summary ?? ''); setRenaming(true) }}
            className="flex items-center gap-3 px-4 py-2.5 text-sm text-white/80
                       hover:bg-white/8 transition-colors text-left"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            이름 변경
          </button>
          {ev.htmlLink && (
            <button
              onClick={() => { window.open(ev.htmlLink, '_blank'); setEventPanel(null) }}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-white/80
                         hover:bg-white/8 transition-colors text-left"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Show in Google Calendar
            </button>
          )}

          <button
            onClick={async () => {
              if (!googleAccessToken) return
              setEventPanel(null)
              removeEvent(evDate, ev.id)
              try {
                await deleteCalendarEvent(googleAccessToken, ev.calendarId, ev.id)
              } catch (err) {
                console.error('[deleteCalendarEvent]', err)
                addEvent(evDate, ev)
              }
            }}
            className="flex items-center gap-3 px-4 py-2.5 text-sm text-red-400
                       hover:bg-red-500/10 transition-colors text-left"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete Event
          </button>
        </div>
      </div>,
      document.body
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="pb-4">
      {/* Event detail panel (portal) */}
      {renderEventPanel()}

      {/* 상단 고정 헤더: 날짜/요일 + all-day (하나의 sticky 컨테이너 → 겹침 방지) */}
      <div className="sticky top-0 z-20 bg-[var(--bg-primary)]">
        {/* Multi-day column headers */}
        {days > 1 && (
          <div className="flex border-b border-[var(--border)]">
            <div className="flex-shrink-0" style={{ width: 40 }} />
            {dates.map(d => (
              <div
                key={d}
                className={`flex-1 py-1 text-center text-[11px] font-semibold border-l border-[var(--border)] ${
                  d === todayStr
                    ? 'text-blue-400'
                    : d === date
                      ? 'text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)]'
                }`}
              >
                {format(parseISO(d), 'EEE')}
                <br />
                <span className={`text-xs font-normal ${d === todayStr ? '' : 'opacity-70'}`}>
                  {format(parseISO(d), 'd')}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* All-day 행 — 항상 표시, 빈 칸 클릭 시 종일 일정 추가(Google 연동) */}
        <div className="flex border-b border-[var(--border)]">
          <div
            className="flex-shrink-0 flex items-start pt-1.5 justify-end pr-2
                       text-[10px] text-[var(--text-muted)] leading-none"
            style={{ width: 40 }}
          >
            all-day
          </div>
          {dates.map(d => {
            const allDayEvs = (eventsByDate[d] ?? []).filter(ev => eventToTimeRange(ev).allDay)
            const adding = newAllDayDate === d
            return (
              <div
                key={`allday-${d}`}
                className="flex-1 min-w-0 border-l border-[var(--border)] px-0.5 py-0.5
                           flex flex-col gap-0.5 min-h-[28px] cursor-pointer hover:bg-white/[0.03]"
                onClick={() => {
                  if (!googleAccessToken) return
                  setNewAllDayDate(d); setNewAllDayTitle('')
                  setTimeout(() => allDayInputRef.current?.focus(), 50)
                }}
                title={googleAccessToken ? '클릭해서 종일 일정 추가' : undefined}
              >
                {allDayEvs.map(ev => {
                  const color = ev.calendarColor ?? '#4285f4'
                  return (
                    <div
                      key={`ad-${ev.id}`}
                      className="text-[11px] font-medium px-1.5 py-0.5 rounded truncate
                                 cursor-pointer select-none"
                      style={{ backgroundColor: color + '30', color }}
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setEventPanel({ ev, date: d, anchorRect: rect })
                      }}
                      title={ev.summary}
                    >
                      {ev.summary}
                    </div>
                  )
                })}
                {adding && (
                  <input
                    ref={allDayInputRef}
                    value={newAllDayTitle}
                    onChange={(e) => setNewAllDayTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateAllDay()
                      else if (e.key === 'Escape') { setNewAllDayDate(null); setNewAllDayTitle('') }
                    }}
                    onBlur={() => handleCreateAllDay()}
                    placeholder="종일 일정..."
                    className="w-full text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]
                               border border-blue-400/50 outline-none text-[var(--text-primary)]"
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Grid: time gutter + day columns */}
      <div className="flex" ref={gridRef}>

        {/* Time gutter */}
        <div className="flex-shrink-0" style={{ width: 40 }}>
          {HOURS.map(hour => (
            <div key={hour} className="relative flex justify-end pr-2" style={{ height: SLOT_H }}>
              <span
                className={`text-xs absolute`}
                style={{
                  top: -8,
                  color: hour === currentHour && todayInView
                    ? 'rgb(96,165,250)'
                    : 'var(--text-muted)',
                  fontWeight: hour === currentHour && todayInView ? 500 : 400,
                }}
              >
                {hour === 0 ? '' : `${hour}:00`}
              </span>
            </div>
          ))}
        </div>

        {/* Day columns */}
        {dates.map(d => {
          const colBlocks = blocksByDate[d] ?? []

          return (
            <div
              key={d}
              className="flex-1 relative border-l border-[var(--border)]"
              style={{ height: TOTAL_H }}
            >
              {/* Hour rows — drop targets + click-to-create */}
              {HOURS.map(hour => (
                <div
                  key={hour}
                  data-tl-slot=""
                  data-tl-date={d}
                  data-tl-hour={hour}
                  className="absolute left-0 right-0 border-t border-[var(--border)]"
                  style={{ top: hour * SLOT_H, height: SLOT_H, zIndex: 1 }}
                  onDragOver={e => handleDragOver(e, d, hour)}
                  onDragLeave={handleDragLeave}
                  onDrop={e => handleDrop(e, d, hour)}
                  onClick={e => {
                    // Don't open form if a GCal drag just ended
                    if (gcalDrag || gcalResizing || gcalResizingTop) return
                    // Only open if clicking directly on the row (not a block)
                    if ((e.target as HTMLElement) !== e.currentTarget) return
                    const minute = minuteFromRowEvent(e)
                    setNewEventSlot({ date: d, startHour: hour, startMinute: minute })
                    setNewEventTitle('')
                  }}
                />
              ))}

              {/* Current-time indicator */}
              {d === todayStr && (
                <div
                  ref={nowLineRef}
                  className="absolute left-0 right-0 h-[2px] bg-blue-500 rounded pointer-events-none"
                  style={{
                    top: currentHour * SLOT_H + currentMinute * PX_PER_MIN - 1,
                    zIndex: 5,
                  }}
                />
              )}

              {/* Drag-over indicator (HTML5 dragOverSlot 또는 pointer dragPreview) */}
              {(() => {
                const over = dragOverSlot?.date === d ? dragOverSlot
                           : dragPreview?.date === d ? dragPreview : null
                if (!over) return null
                return (
                  <div
                    className="absolute left-1 right-1 rounded-md border border-dashed
                               border-blue-400/80 text-[10px] font-medium text-blue-300 px-2 pt-0.5 pointer-events-none
                               flex items-start"
                    style={{
                      top:        over.hour * SLOT_H + over.minute * PX_PER_MIN,
                      height:     over.duration * PX_PER_MIN,
                      background: 'rgba(59,130,246,0.14)',
                      boxShadow:  '0 0 0 1px rgba(59,130,246,0.25)',
                      transition: 'top 60ms ease, height 60ms ease',
                      zIndex:     30,
                    }}
                  >
                    {formatTimeRange(over.hour, over.minute, over.duration)}
                  </div>
                )
              })()}

              {/* Google Calendar 이벤트 */}
              {(eventsByDate[d] ?? []).map(ev => renderCalendarEvent(ev, d))}

              {/* New-event ghost + inline form */}
              {newEventSlot?.date === d && (() => {
                const { startHour, startMinute } = newEventSlot
                const top = startHour * SLOT_H + startMinute * PX_PER_MIN
                const primaryCal = calendars.find(c => c.id === newEventCalId)
                const formColor  = primaryCal?.backgroundColor ?? '#4285f4'
                return (
                  <div
                    ref={newEventFormRef}
                    className="absolute left-1 right-1 rounded overflow-hidden pointer-events-auto"
                    style={{ top, height: DEFAULT_DURATION * PX_PER_MIN, zIndex: 40 }}
                  >
                    {/* colored left bar */}
                    <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l" style={{ backgroundColor: formColor }} />
                    <div className="absolute inset-0 rounded" style={{ backgroundColor: formColor, opacity: 0.15 }} />
                    <div className="relative pl-2 pr-1 py-0.5 flex flex-col gap-0.5">
                      <input
                        ref={newEventInputRef}
                        value={newEventTitle}
                        onChange={e => setNewEventTitle(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleCreateEvent()
                          if (e.key === 'Escape') { setNewEventSlot(null); setNewEventTitle('') }
                        }}
                        placeholder="Event title..."
                        className="w-full bg-transparent text-[11px] font-medium outline-none placeholder-white/40"
                        style={{ color: formColor }}
                      />
                      <div className="flex items-center gap-1">
                        <select
                          value={newEventCalId}
                          onChange={e => setNewEventCalId(e.target.value)}
                          className="flex-1 text-[10px] bg-transparent outline-none truncate"
                          style={{ color: formColor + 'cc' }}
                          onPointerDown={e => e.stopPropagation()}
                        >
                          {writableCalendars.map(c => (
                            <option key={c.id} value={c.id} style={{ backgroundColor: '#1e1e2e', color: '#cdd6f4' }}>
                              {c.summary}{c.primary ? ' ★' : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          onPointerDown={e => e.stopPropagation()}
                          onClick={handleCreateEvent}
                          disabled={savingEvent || !newEventTitle.trim()}
                          className="text-[10px] px-1.5 py-0.5 rounded font-medium transition-opacity disabled:opacity-40"
                          style={{ backgroundColor: formColor + '40', color: formColor }}
                        >
                          {savingEvent ? '…' : 'Add'}
                        </button>
                        <button
                          onPointerDown={e => e.stopPropagation()}
                          onClick={() => { setNewEventSlot(null); setNewEventTitle('') }}
                          className="text-[10px] opacity-60 hover:opacity-100"
                          style={{ color: formColor }}
                        >×</button>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Time blocks */}
              {colBlocks.map(renderBlock)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
