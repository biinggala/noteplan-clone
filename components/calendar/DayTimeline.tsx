'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useSearchParams } from 'next/navigation'
import { addDays, addMinutes, format, parseISO } from 'date-fns'
import { useTimeBlockStore, type TimeBlock } from '@/lib/stores/timeBlockStore'
import { useLineUpdateStore } from '@/lib/stores/lineUpdateStore'
import { formatTimeRange } from '@/lib/parser/timeBlockParser'
import { useAuthStore } from '@/lib/stores/authStore'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useTimelineDragStore, dailyNoteDateFrom } from '@/lib/dnd/timelineDragStore'
import { openExternal } from '@/lib/openExternal'
import {
  withGoogleToken, googleErrorMessage, reportGoogleError, refreshGoogleTokenNow,
} from '@/lib/google/withToken'
import {
  linkTimeblocks, desiredSummary, moveTimeblockEvent, syncTimeblockSummary,
  deleteTimeblockEvent, blockStartMins, createTimeblockEvent,
} from '@/lib/google/timeblockLink'
import { getOrCreateDailyNote, updateNoteContentSafely } from '@/lib/db/noteRepository'
import { insertUnderTasks, APPEND_TASK_EVENT, type AppendTaskDetail } from '@/lib/parser/insertTask'
import {
  fetchCalendarList,
  fetchAllCalendarEventsForRange,
  CalendarFetchError,
  createCalendarEvent,
  createAllDayEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  eventSegmentForDay, eventInterval, isAllDayEvent, isDeclinedBySelf,
  dateAtMinutes, eventTimeFor, toRfc3339,
  type GoogleCalendar, type GoogleCalendarEvent, type DaySegment,
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
const DAY_MINS = 24 * 60
const BLOCK_MIN_H = 20
const EVENT_MIN_H = 18
const MOVE_THRESHOLD_PX = 4

function snapTo15(m: number) { return Math.round(m / SNAP) * SNAP }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`

/** 쓰기 권한 (owner/writer). accessRole 이 없으면 예전처럼 쓸 수 있다고 본다 */
function calendarWritable(cal: GoogleCalendar | undefined) {
  const role = cal?.accessRole
  return !role || role === 'owner' || role === 'writer'
}

// ── 겹침 배치 (구글 캘린더식 lane packing) ────────────────────────────────────
// 겹치는 항목끼리 묶고, 묶음 안에서 비어 있는 가장 왼쪽 열에 넣는다.
// 폭 = 1/열 수, 왼쪽 = 열 번호 × 폭. 이벤트와 타임블록을 같이 배치한다.
interface LaneItem { key: string; start: number; end: number }
interface Lane { lane: number; lanes: number }

function packLanes(items: LaneItem[]): Map<string, Lane> {
  const sorted = [...items].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const out = new Map<string, Lane>()
  let cluster: { key: string; lane: number }[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    for (const c of cluster) out.set(c.key, { lane: c.lane, lanes: laneEnds.length })
    cluster = []; laneEnds = []; clusterEnd = -Infinity
  }
  for (const it of sorted) {
    if (cluster.length && it.start >= clusterEnd) flush()
    let lane = laneEnds.findIndex(e => e <= it.start)
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(it.end) } else laneEnds[lane] = it.end
    cluster.push({ key: it.key, lane })
    clusterEnd = Math.max(clusterEnd, it.end)
  }
  flush()
  return out
}

function laneStyle(l: Lane | undefined): React.CSSProperties {
  const lane = l?.lane ?? 0, lanes = l?.lanes ?? 1
  return { left: `calc(${(lane * 100) / lanes}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }
}

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

  // 지금 열려 있는 일간 노트 날짜 — 타임블록(그 노트의 줄)은 이 날짜 것만 고칠 수 있다
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const openDaily = dailyNoteDateFrom(pathname, searchParams?.get('date') ?? null)

  // ── Stores ────────────────────────────────────────────────────────────────
  const { timeBlocks, removeTimeBlock, updateTimeBlock } = useTimeBlockStore()
  const { requestUpdate } = useLineUpdateStore()
  const { googleAccessToken, setGoogleAuthError } = useAuthStore()
  const {
    calendars, enabledCalendarIds, fetchGen,
    setCalendars, eventsByDate, setFetching,
    mergeEvents, addEvent, removeEvent, restoreEvent, updateEvent,
    notice, setNotice,
  } = useCalendarEventStore()

  // pointer 드래그 미리보기 (pointerLineDrag → 슬롯 위 점선 블록)
  const dragPreview = useTimelineDragStore(s => s.preview)

  // 알림은 잠깐만
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(t)
  }, [notice, setNotice])

  // ── Local state ───────────────────────────────────────────────────────────
  // ev = 이 블록에 연결된 Google 이벤트. 시작시각이 바뀌는 조작 중에는 연결이
  // 잠깐 끊기므로 시작할 때 잡아둔다.
  const [resizing, setResizing] = useState<{
    blockId: string; startY: number; startDuration: number
    ev: GoogleCalendarEvent | null
  } | null>(null)

  const [resizingTop, setResizingTop] = useState<{
    blockId: string; originalEndMins: number; origStartMins: number
    ev: GoogleCalendarEvent | null
  } | null>(null)

  // 타임블록 이동 (pointer — HTML5 draggable 은 WKWebView 에서 동작하지 않는다)
  const [blockDrag, setBlockDrag] = useState<{
    blockId: string; date: string; startY: number; grabOffsetMins: number
    origMins: number; mins: number; duration: number; moved: boolean
    ev: GoogleCalendarEvent | null
  } | null>(null)

  // ── New-event inline form ─────────────────────────────────────────────────
  const [newEventSlot, setNewEventSlot] = useState<{
    date: string; startHour: number; startMinute: number
  } | null>(null)
  const [newEventTitle, setNewEventTitle] = useState('')
  // 빈 칸을 눌러 만드는 것: 'event' = 구글 일정, 'task' = 노트의 할 일(타임블록).
  // 할 일은 그 날 데일리 노트의 ## Tasks 에 시간과 함께 들어간다 — 줄을 끌어다 놓을 수
  // 없는 모바일에서도 타임블록을 만들 수 있게 (마지막 선택을 기억)
  const [newEventKind, setNewEventKindState] = useState<'event' | 'task'>(() => {
    try { return localStorage.getItem('np-new-slot-kind') === 'task' ? 'task' : 'event' } catch { return 'event' }
  })
  const setNewEventKind = (k: 'event' | 'task') => {
    setNewEventKindState(k)
    try { localStorage.setItem('np-new-slot-kind', k) } catch { /* 무시 */ }
  }
  // 종일(all-day) 새 이벤트 입력 (date + 제목)
  const [newAllDayDate, setNewAllDayDate] = useState<string | null>(null)
  const [newAllDayTitle, setNewAllDayTitle] = useState('')
  // Default to "primary" literal — always resolves to the user's main calendar.
  // Updated to a real ID once calendars load (prefers writable owner/writer calendars).
  const [newEventCalId, setNewEventCalId] = useState<string>('primary')
  const [savingEvent, setSavingEvent] = useState(false)
  // 저장 실패 사유 — 예전엔 콘솔에만 찍고 폼을 닫아서 '추가가 안 된다'로만 보였다
  const [createError, setCreateError] = useState<string | null>(null)
  // 중복 생성 방지용 동기 락. savingEvent(React state)는 반영이 한 박자 늦어서
  // Enter 두 번이나 Enter+블러가 같은 틱에 겹치면 둘 다 통과해버린다.
  const creatingRef = useRef(false)
  const newEventInputRef = useRef<HTMLInputElement>(null)
  const newEventFormRef  = useRef<HTMLDivElement>(null)
  const allDayInputRef   = useRef<HTMLInputElement>(null)

  function closeNewEventForm() {
    setNewEventSlot(null)
    setNewEventTitle('')
    setCreateError(null)
  }

  // Close new-event form on outside click
  useEffect(() => {
    if (!newEventSlot) return
    function onDown(e: MouseEvent) {
      if (newEventFormRef.current && !newEventFormRef.current.contains(e.target as Node)) closeNewEventForm()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [newEventSlot])

  // Writable calendars: owner or writer access only
  const writableCalendars = useMemo(() => calendars.filter(calendarWritable), [calendars])

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
  const [gcalOp, setGcalOp] = useState<{
    kind: 'move' | 'resize' | 'resizeTop'
    ev: GoogleCalendarEvent
    date: string
    seg: DaySegment        // 이 칸에서의 원래 구간
    startY: number
    grabOffsetMins: number
    moved: boolean
  } | null>(null)

  // Optimistic override while dragging/resizing a GCal event (그 칸 기준 분)
  const [gcalOverride, setGcalOverride] = useState<{
    id: string; date: string; startMins: number; endMins: number
  } | null>(null)

  // ── Event detail panel ────────────────────────────────────────────────────
  const [eventPanel, setEventPanel] = useState<{
    ev: GoogleCalendarEvent
    date: string
    anchorRect: DOMRect
    returnFocus?: HTMLElement | null
  } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 이벤트 패널 내 이름 변경
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const renamingRef = useRef(false)   // Enter 후 blur 로 한 번 더 들어오는 것 막기

  function closePanel() {
    const back = eventPanel?.returnFocus
    setEventPanel(null)
    back?.focus?.()
  }

  // Close panel on outside click / Escape
  useEffect(() => {
    if (!eventPanel) return
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setEventPanel(null)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !renamingRef.current) closePanel()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventPanel])

  // 다른 이벤트 패널 열면 rename 모드 초기화
  useEffect(() => { setRenaming(false); renamingRef.current = false }, [eventPanel?.ev.id])

  // 이벤트 쓰기 권한: 캘린더 owner/writer + (남이 만든 초대 일정이면 손님 수정 허용일 때만)
  function canDeleteEvent(ev: GoogleCalendarEvent) {
    return calendarWritable(calendars.find(c => c.id === ev.calendarId))
  }
  function canEditEvent(ev: GoogleCalendarEvent) {
    if (!canDeleteEvent(ev) || ev.locked) return false
    if (ev.organizer && !ev.organizer.self && !ev.guestsCanModify) return false
    return true
  }

  // 이벤트 이름 변경 (Google 연동)
  async function confirmRename(ev: GoogleCalendarEvent) {
    if (!renamingRef.current) return
    renamingRef.current = false
    const title = renameText.trim()
    setRenaming(false)
    if (!title || title === ev.summary || !googleAccessToken || !canEditEvent(ev)) return
    const prev = ev.summary
    updateEvent(ev.id, { summary: title })
    try {
      await withGoogleToken(token => updateCalendarEvent(token, ev.calendarId, ev.id, { summary: title }))
    } catch (err) {
      updateEvent(ev.id, { summary: prev })
      reportGoogleError(err, 'rename event')
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

  // 타임블록 ↔ 이벤트 연결. 연결된 이벤트는 블록이 대표하므로 따로 그리지 않는다.
  // 블록이 없는(노트에서 줄을 지웠거나 아직 그 날 노트를 안 연) 타임블록 이벤트는
  // 일반 이벤트로 보인다 — 예전엔 항상 숨겨서 보이지 않는 고아가 생겼다.
  const linkMap = useMemo(() => linkTimeblocks(timeBlocks, eventsByDate), [timeBlocks, eventsByDate])
  const hiddenEventIds = useMemo(() => {
    const s = new Set([...linkMap.values()].map(e => e.id))
    // 블록을 끌거나 늘리는 동안은 연결이 잠깐 끊긴다 — 그 사이 이벤트가 튀어나오지 않게
    for (const ev of [resizing?.ev, resizingTop?.ev, blockDrag?.ev]) if (ev) s.add(ev.id)
    return s
  }, [linkMap, resizing?.ev, resizingTop?.ev, blockDrag?.ev])

  const blockEditable = (b: TimeBlock) =>
    b.date === openDaily && !!b.noteLineText && b.originalContent !== undefined
  // 노트 줄이 없는 블록(주간·일반 노트에서 끌어와 이번 세션에만 있는 것)은 지우기만
  const blockDeletable = (b: TimeBlock) => blockEditable(b) || !b.noteLineText

  // ── Google Calendar: 캘린더 목록 fetch ───────────────────────────────────
  // accessToken 변경마다 항상 re-fetch (캐시 무효화 + accessRole 최신화)
  useEffect(() => {
    if (!googleAccessToken) return
    fetchCalendarList(googleAccessToken)
      .then(list => {
        setCalendars(list)
        // 성공했으면 이전 배너는 반드시 치운다.
        // 지금까지 배너를 지우는 곳이 토큰 갱신 성공 한 군데뿐이라,
        // 한 번 뜬 배너가 캘린더가 멀쩡히 돌아와도 계속 남아 있었다.
        setGoogleAuthError(
          list.length === 0
            ? '연결된 구글 계정에 읽을 수 있는 캘린더가 없습니다.'
            : null,
        )
      })
      .catch(err => {
        // 여기가 조용히 죽으면 calendars가 빈 배열로 남고, MiniCalendar는
        // calendars.length===0 에서 조기 리턴해 이벤트 fetch조차 안 한다.
        // 결과: "연결은 했는데 일정이 아무것도 안 뜨고 에러도 없음".
        console.error('[CalendarList]', err)
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'GOOGLE_TOKEN_EXPIRED') { void refreshGoogleTokenNow(); return }
        setGoogleAuthError(
          msg === 'GOOGLE_CALENDAR_SCOPE_MISSING'
            ? '이 토큰에는 캘린더 권한이 없습니다. 톱니 → Google 캘린더 연결을 다시 해주세요.'
            : `캘린더 목록을 불러오지 못했습니다: ${msg}`,
        )
      })
  }, [googleAccessToken, setCalendars, setGoogleAuthError])

  // ── Google Calendar: 날짜 범위 이벤트 fetch (한 번에) ───────────────────
  const fetchedTokenRef = useRef<string | null>(null)
  useEffect(() => {
    if (!googleAccessToken || calendars.length === 0 || dates.length === 0) return
    const st = useCalendarEventStore.getState()
    // 토큰이 바뀌었으면(재연결/자동갱신) 캐시 무시하고 전체 재fetch
    const tokenChanged = fetchedTokenRef.current !== googleAccessToken
    const unfetched = tokenChanged
      ? [...dates]
      : dates.filter(d => st.needsFetch(d) && !st.fetchingDates.has(d))
    if (unfetched.length === 0) return
    fetchedTokenRef.current = googleAccessToken
    // 출발 시점의 세대 — 그 사이 캘린더를 켜고 끄면 이 결과는 버린다
    const gen = st.fetchGen

    const startDate = unfetched[0]
    const endDate   = unfetched[unfetched.length - 1]
    unfetched.forEach(d => setFetching(d, true))

    const fill = (grouped: Record<string, GoogleCalendarEvent[]>) => {
      // 이벤트 없는 날도 빈 배열로 표시해 중복 fetch 방지
      const full: Record<string, GoogleCalendarEvent[]> = {}
      unfetched.forEach(d => { full[d] = grouped[d] ?? [] })
      return full
    }
    fetchAllCalendarEventsForRange(googleAccessToken, calendars, st.enabledCalendarIds, startDate, endDate)
      .then(grouped => { mergeEvents(fill(grouped), { gen }) })
      .catch(err => {
        if (err instanceof CalendarFetchError) {
          // 받은 만큼은 보여주되 '불러옴'으로 치지 않는다 → 다음에 다시 불러온다
          mergeEvents(fill(err.partial), { gen, incomplete: true })
          console.error('[Timeline fetch]', err)
          setNotice(err.message)
        } else if (err instanceof Error && err.message === 'GOOGLE_TOKEN_EXPIRED') {
          // 갱신되면 토큰이 바뀌어 이 effect 가 다시 돈다. 갱신 실패는 배너로.
          void refreshGoogleTokenNow()
        } else {
          console.error('[Timeline fetch]', err)
        }
      })
      .finally(() => {
        if (useCalendarEventStore.getState().fetchGen === gen) unfetched.forEach(d => setFetching(d, false))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleAccessToken, calendars, enabledCalendarIds, dates, fetchGen])

  // ── 타임블록 → 이벤트 제목 동기화 (완료 ✓ + 줄 내용 변경) ───────────────
  // 원하는 제목과 실제 제목이 다를 때만 PATCH 한다. 예전엔 마운트할 때마다 완료된
  // 블록마다 PATCH 를 다시 보냈고, 줄 내용을 고쳐도 이벤트 제목은 그대로였다.
  // 열려 있는 일간 노트의 블록만 본다 (그게 막 읽은 '정답'이다 — 다른 날 블록은
  // 예전에 읽어둔 것이라 다른 기기에서 고친 걸 되돌릴 수 있다).
  const summaryTriedRef = useRef(new Map<string, string>())
  useEffect(() => {
    if (!googleAccessToken || !openDaily) return
    const t = setTimeout(() => {
      const dayBlocks = useTimeBlockStore.getState().timeBlocks.filter(b => b.date === openDaily)
      const links = linkTimeblocks(dayBlocks, useCalendarEventStore.getState().eventsByDate)
      for (const b of dayBlocks) {
        const ev = links.get(b.id)
        if (!ev || !canEditEvent(ev)) continue
        const want = desiredSummary(b)
        if (ev.summary === want && ev.extendedProperties?.private?.npContent === b.content) continue
        // 같은 목표로는 한 번만 시도 (실패해도 렌더마다 다시 두드리지 않게)
        const key = `${want}\u0000${b.content}`
        if (summaryTriedRef.current.get(ev.id) === key) continue
        summaryTriedRef.current.set(ev.id, key)
        void syncTimeblockSummary(ev, want, b.content)
      }
    }, 800)  // 타이핑 중엔 기다렸다가 한 번
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeBlocks, eventsByDate, googleAccessToken, openDaily, calendars])

  // gridRef is on the flex container (gutter + columns) — used for Y calculation
  const gridRef = useRef<HTMLDivElement>(null)
  const gridTop = () => gridRef.current?.getBoundingClientRect().top ?? 0

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

  /** Snap minute from Y position within an hour-row div. */
  function minuteFromRowEvent(e: { clientY: number; currentTarget: EventTarget }): number {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const offsetY = Math.max(0, Math.min(e.clientY - rect.top, SLOT_H - 1))
    return snapTo15((offsetY / SLOT_H) * 60) % 60
  }

  function minsFromClientY(clientY: number): number {
    return Math.min(23 * 60 + 45, snapTo15(Math.max(0, (clientY - gridTop()) / PX_PER_MIN)))
  }

  /** 블록의 원래 노트 줄을 고쳐 달라는 요청 (그 날짜 일간 노트에만 적용된다) */
  function requestBlockLine(b: TimeBlock, replace: string) {
    if (!b.noteLineText) return
    requestUpdate({ date: b.date, find: b.noteLineText, replace, lineIndex: b.lineIndex })
  }
  const blockLineText = (b: TimeBlock, startMins: number, duration: number) =>
    `${b.linePrefix ?? ''}${formatTimeRange(Math.floor(startMins / 60), startMins % 60, duration)} ${b.originalContent ?? b.content}`

  // ── Resize – bottom ───────────────────────────────────────────────────────

  function onResizeDn(e: React.PointerEvent, block: TimeBlock) {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResizing({
      blockId: block.id, startY: e.clientY, startDuration: block.duration,
      ev: linkMap.get(block.id) ?? null,
    })
  }
  function onResizeMv(e: React.PointerEvent, block: TimeBlock) {
    if (!resizing || resizing.blockId !== block.id) return
    const delta  = (e.clientY - resizing.startY) / PX_PER_MIN
    const maxDur = DAY_MINS - blockStartMins(block)
    updateTimeBlock(block.id, { duration: Math.min(maxDur, Math.max(SNAP, snapTo15(resizing.startDuration + delta))) })
  }
  function onResizeUp(commit = true) {
    if (resizing) {
      const b = useTimeBlockStore.getState().timeBlocks.find(b => b.id === resizing.blockId)
      if (b && !commit) updateTimeBlock(b.id, { duration: resizing.startDuration })
      else if (b && b.duration !== resizing.startDuration) {
        requestBlockLine(b, blockLineText(b, blockStartMins(b), b.duration))
        void moveTimeblockEvent(resizing.ev, b.date, blockStartMins(b), b.duration)
      }
    }
    setResizing(null)
  }

  // ── Resize – top ──────────────────────────────────────────────────────────

  function onResizeTopDn(e: React.PointerEvent, block: TimeBlock) {
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResizingTop({
      blockId: block.id,
      originalEndMins: blockStartMins(block) + block.duration,
      origStartMins: blockStartMins(block),
      ev: linkMap.get(block.id) ?? null,
    })
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
  function onResizeTopUp(commit = true) {
    if (resizingTop) {
      const b = useTimeBlockStore.getState().timeBlocks.find(b => b.id === resizingTop.blockId)
      if (b && !commit) {
        // 취소: 원래대로 (끝은 그대로였다)
        const s0 = resizingTop.origStartMins
        updateTimeBlock(b.id, { startHour: Math.floor(s0 / 60), startMinute: s0 % 60, duration: resizingTop.originalEndMins - s0 })
      } else if (b && blockStartMins(b) !== resizingTop.origStartMins) {
        requestBlockLine(b, blockLineText(b, blockStartMins(b), b.duration))
        void moveTimeblockEvent(resizingTop.ev, b.date, blockStartMins(b), b.duration)
      }
    }
    setResizingTop(null)
  }

  // ── Block move (pointer) ──────────────────────────────────────────────────

  function onBlockDown(e: React.PointerEvent, block: TimeBlock) {
    if (!blockEditable(block) || e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-resize],button')) return
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const start = blockStartMins(block)
    setBlockDrag({
      blockId: block.id, date: block.date, startY: e.clientY,
      grabOffsetMins: (e.clientY - gridTop()) / PX_PER_MIN - start,
      origMins: start, mins: start, duration: block.duration, moved: false,
      ev: linkMap.get(block.id) ?? null,
    })
  }
  function onBlockMove(e: React.PointerEvent, block: TimeBlock) {
    if (blockDrag?.blockId !== block.id) return
    const moved = blockDrag.moved || Math.abs(e.clientY - blockDrag.startY) >= MOVE_THRESHOLD_PX
    const raw = (e.clientY - gridTop()) / PX_PER_MIN - blockDrag.grabOffsetMins
    const mins = clamp(snapTo15(raw), 0, DAY_MINS - SNAP)
    if (moved) startEdgeScroll(e.clientY)
    if (moved !== blockDrag.moved || mins !== blockDrag.mins) setBlockDrag({ ...blockDrag, moved, mins })
  }
  function finishBlockDrag(commit: boolean) {
    const d = blockDrag
    setBlockDrag(null)
    stopEdgeScroll()
    if (!d || !commit || !d.moved || d.mins === d.origMins) return
    const b = useTimeBlockStore.getState().timeBlocks.find(x => x.id === d.blockId)
    if (!b) return
    // 같은 날짜 안에서만 옮긴다 — 블록은 그 날짜 일간 노트의 줄이라 다른 날로 옮기려면
    // 줄을 다른 노트로 옮겨야 한다 (지원하지 않음)
    updateTimeBlock(b.id, { startHour: Math.floor(d.mins / 60), startMinute: d.mins % 60 })
    requestBlockLine(b, blockLineText(b, d.mins, b.duration))
    void moveTimeblockEvent(d.ev, b.date, d.mins, b.duration)
  }

  function deleteBlock(block: TimeBlock) {
    if (block.noteLineText) {
      requestBlockLine(block, (block.linePrefix ?? '') + (block.originalContent ?? block.content))
    }
    const linked = linkMap.get(block.id)
    removeTimeBlock(block.id)
    // 연결된 Google Calendar 이벤트도 삭제 (실패하면 되돌리고 알림)
    void deleteTimeblockEvent(linked)
  }

  // ── Create Google Calendar event ─────────────────────────────────────────

  /** 할 일(타임블록) 만들기 — 노트에 '- [ ] 9:00 AM - 9:30 AM 제목' 줄을 넣는다 */
  async function handleCreateTask() {
    if (creatingRef.current || !newEventSlot || !newEventTitle.trim()) return
    creatingRef.current = true
    setSavingEvent(true)
    setCreateError(null)
    const { date: d, startHour, startMinute } = newEventSlot
    const title = newEventTitle.trim()
    const line = `- [ ] ${formatTimeRange(startHour, startMinute, DEFAULT_DURATION)} ${title}`
    try {
      // 그 날 노트가 지금 열려 있으면 편집 세션으로 (편집 중인 내용과 충돌하지 않게)
      const detail: AppendTaskDetail = { date: d, line, handled: false }
      window.dispatchEvent(new CustomEvent(APPEND_TASK_EVENT, { detail }))
      if (!detail.handled) {
        const day = await getOrCreateDailyNote(d)
        await updateNoteContentSafely(day.id, c => insertUnderTasks(c, line))
        // 열려 있지 않은 날이라도 지금 타임라인에 바로 보이게
        useTimeBlockStore.getState().addTimeBlock({
          date: d, startHour, startMinute, duration: DEFAULT_DURATION, content: title,
        })
      }
      void createTimeblockEvent(d, startHour * 60 + startMinute, DEFAULT_DURATION, title)
      closeNewEventForm()
    } catch (err) {
      console.error('[createTask]', err)
      setCreateError(`할 일을 넣지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      creatingRef.current = false
      setSavingEvent(false)
    }
  }

  async function handleCreateEvent() {
    if (newEventKind === 'task') return handleCreateTask()
    if (creatingRef.current) return
    if (!newEventSlot || !newEventTitle.trim()) return
    creatingRef.current = true
    // If no calendar selected yet, fall back to "primary"
    const calId = newEventCalId || 'primary'
    setSavingEvent(true)
    setCreateError(null)
    const { date: evDate, startHour, startMinute } = newEventSlot
    // 끝은 Date 로 계산 — 23:30 에 만들면 다음날 00:00 (예전엔 "T24:00:00" 으로 거절됐다)
    const start = dateAtMinutes(evDate, startHour * 60 + startMinute)
    const end = addMinutes(start, DEFAULT_DURATION)
    const cal = calendars.find(c => c.id === calId)
    try {
      const created = await withGoogleToken(token => createCalendarEvent(token, {
        calendarId:    calId,
        summary:       newEventTitle.trim(),
        startDateTime: toRfc3339(start),
        endDateTime:   toRfc3339(end),
      }))
      // Attach calendar color
      created.calendarColor = cal?.backgroundColor ?? '#4285f4'
      addEvent(evDate, created as GoogleCalendarEvent)
      closeNewEventForm()
    } catch (err) {
      // 폼은 열어 둔다 — 적은 제목이 날아가지 않고, 왜 안 됐는지 보인다
      console.error('[createCalendarEvent]', err)
      setCreateError(googleErrorMessage(err))
    } finally {
      creatingRef.current = false
      setSavingEvent(false)
    }
  }

  // 종일 이벤트 생성 (Google Calendar 연동)
  async function handleCreateAllDay() {
    // Enter로 만든 뒤 입력창이 사라지며 blur가 또 들어온다 — 락으로 막는다
    if (creatingRef.current) return
    if (!newAllDayDate || !newAllDayTitle.trim()) {
      setNewAllDayDate(null); setNewAllDayTitle(''); return
    }
    creatingRef.current = true
    const calId = newEventCalId || 'primary'
    const cal = calendars.find(c => c.id === calId)
    const date = newAllDayDate
    setSavingEvent(true)
    try {
      const created = await withGoogleToken(token => createAllDayEvent(token, {
        calendarId: calId,
        summary: newAllDayTitle.trim(),
        date,
      }))
      created.calendarColor = cal?.backgroundColor ?? '#4285f4'
      addEvent(date, created as GoogleCalendarEvent)
    } catch (err) {
      reportGoogleError(err, 'createAllDayEvent')
    } finally {
      creatingRef.current = false
      setSavingEvent(false)
      setNewAllDayDate(null)
      setNewAllDayTitle('')
    }
  }

  // ── GCal event move / resize (pointer) ───────────────────────────────────
  // 칸(날짜) 기준 구간으로 끌고, 놓을 때 실제 Date 로 계산한다 — 여러 날에 걸친
  // 일정도 시작·끝을 같은 만큼 옮기거나, 그 칸에 있는 쪽 끝만 늘인다.

  function onGcalDown(e: React.PointerEvent, ev: GoogleCalendarEvent, colDate: string, kind: 'move' | 'resize' | 'resizeTop') {
    if (e.button !== 0) return
    const seg = eventSegmentForDay(ev, colDate)
    if (!seg) return
    e.preventDefault(); e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setGcalOp({
      kind, ev, date: colDate, seg, startY: e.clientY,
      grabOffsetMins: (e.clientY - gridTop()) / PX_PER_MIN - seg.startMins, moved: false,
    })
    setGcalOverride({ id: ev.id, date: colDate, startMins: seg.startMins, endMins: seg.endMins })
  }

  function onGcalMove(e: React.PointerEvent) {
    if (!gcalOp) return
    const { kind, seg } = gcalOp
    const moved = gcalOp.moved || Math.abs(e.clientY - gcalOp.startY) >= MOVE_THRESHOLD_PX
    if (moved !== gcalOp.moved) setGcalOp({ ...gcalOp, moved })
    if (!moved) return
    let s = seg.startMins, en = seg.endMins
    if (kind === 'move') {
      const len = en - s
      s = clamp(snapTo15((e.clientY - gridTop()) / PX_PER_MIN - gcalOp.grabOffsetMins), 0, DAY_MINS - SNAP)
      en = s + len
    } else if (kind === 'resize') {
      const delta = (e.clientY - gcalOp.startY) / PX_PER_MIN
      en = clamp(snapTo15(seg.endMins + delta), s + SNAP, DAY_MINS)
    } else {
      s = clamp(minsFromClientY(e.clientY), 0, en - SNAP)
    }
    startEdgeScroll(e.clientY)
    if (gcalOverride?.startMins !== s || gcalOverride?.endMins !== en) {
      setGcalOverride({ id: gcalOp.ev.id, date: gcalOp.date, startMins: s, endMins: en })
    }
  }

  async function commitEventTimes(ev: GoogleCalendarEvent, start: Date, end: Date) {
    const prev = { start: ev.start, end: ev.end }
    updateEvent(ev.id, { start: eventTimeFor(start, ev.start.timeZone), end: eventTimeFor(end, ev.end.timeZone) })
    try {
      await withGoogleToken(token => updateCalendarEvent(token, ev.calendarId, ev.id, {
        start, end, startTimeZone: ev.start.timeZone, endTimeZone: ev.end.timeZone,
      }))
    } catch (err) {
      // 옮긴 자리에 그대로 남아 '된 것처럼' 보이지 않게 되돌린다
      updateEvent(ev.id, prev)
      reportGoogleError(err, 'updateCalendarEvent')
    }
  }

  function onGcalUp(e: React.PointerEvent) {
    const op = gcalOp, ov = gcalOverride
    setGcalOp(null); setGcalOverride(null); stopEdgeScroll()
    if (!op) return
    if (!op.moved) {
      // 짧은 탭 → 상세 패널
      if (op.kind === 'move') togglePanel(op.ev, op.date, e.currentTarget as HTMLElement)
      return
    }
    const iv = eventInterval(op.ev)
    if (!ov || !iv) return
    let start = iv.start, end = iv.end
    if (op.kind === 'move') {
      const delta = ov.startMins - op.seg.startMins
      if (delta === 0) return
      start = addMinutes(iv.start, delta); end = addMinutes(iv.end, delta)
    } else if (op.kind === 'resize') {
      if (ov.endMins === op.seg.endMins) return
      end = dateAtMinutes(op.date, ov.endMins)
    } else {
      if (ov.startMins === op.seg.startMins) return
      start = dateAtMinutes(op.date, ov.startMins)
    }
    void commitEventTimes(op.ev, start, end)
  }

  function onGcalCancel() {
    setGcalOp(null); setGcalOverride(null); stopEdgeScroll()
  }

  function togglePanel(ev: GoogleCalendarEvent, colDate: string, el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    setEventPanel(prev =>
      prev?.ev.id === ev.id ? null  // toggle off
        : { ev, date: colDate, anchorRect: rect, returnFocus: el }
    )
  }

  // ── Task status ───────────────────────────────────────────────────────────

  function getTaskStatus(lp?: string): 'done' | 'cancelled' | 'open' | null {
    if (!lp) return null
    if (/\[x\]/i.test(lp)) return 'done'
    if (/\[-\]/.test(lp))  return 'cancelled'
    if (/\[ \]/.test(lp))  return 'open'
    return null
  }

  // ── Column layout (overlap lanes) ─────────────────────────────────────────

  interface ColEvent { ev: GoogleCalendarEvent; seg: DaySegment; start: number; end: number }

  function columnItems(d: string) {
    const evs: ColEvent[] = []
    for (const ev of eventsByDate[d] ?? []) {
      if (isAllDayEvent(ev) || hiddenEventIds.has(ev.id)) continue
      const seg = eventSegmentForDay(ev, d)
      if (!seg) continue
      let start = seg.startMins, end = seg.endMins
      if (gcalOverride?.id === ev.id && gcalOverride.date === d) { start = gcalOverride.startMins; end = gcalOverride.endMins }
      evs.push({ ev, seg, start, end: Math.min(end, DAY_MINS) })
    }
    const blocks = blocksByDate[d] ?? []
    const items: LaneItem[] = [
      ...evs.map(c => ({ key: `e:${c.ev.id}`, start: c.start, end: Math.max(c.end, c.start + EVENT_MIN_H / PX_PER_MIN) })),
      ...blocks.map(b => {
        const s = blockStartMins(b)
        return { key: `b:${b.id}`, start: s, end: Math.max(Math.min(s + b.duration, DAY_MINS), s + BLOCK_MIN_H / PX_PER_MIN) }
      }),
    ]
    return { evs, blocks, lanes: packLanes(items) }
  }

  // ── Block renderer ────────────────────────────────────────────────────────

  function renderBlock(block: TimeBlock, lane: Lane | undefined) {
    const startMins       = blockStartMins(block)
    const clampedDuration = Math.min(block.duration, DAY_MINS - startMins)
    const top             = startMins * PX_PER_MIN
    const height          = Math.max(clampedDuration * PX_PER_MIN, BLOCK_MIN_H)
    const isResizingThis  = resizing?.blockId === block.id || resizingTop?.blockId === block.id
    const isDraggingThis  = blockDrag?.blockId === block.id && blockDrag.moved
    const taskStatus      = getTaskStatus(block.linePrefix)
    const isDone          = taskStatus === 'done'
    const isCancelled     = taskStatus === 'cancelled'
    const isCompleted     = isDone || isCancelled
    const editable        = blockEditable(block)
    const deletable       = blockDeletable(block)

    return (
      <div
        key={block.id}
        data-tl-block={block.id}
        onPointerDown={e => onBlockDown(e, block)}
        onPointerMove={e => onBlockMove(e, block)}
        onPointerUp={() => finishBlockDrag(true)}
        onPointerCancel={() => finishBlockDrag(false)}
        className="group absolute rounded-md px-2 py-1 text-xs text-white shadow-sm
                   pointer-events-auto select-none flex flex-col overflow-hidden"
        style={{
          top, height, ...laneStyle(lane),
          backgroundColor: block.color,
          opacity:  isDraggingThis ? 0.4 : isCompleted ? 0.45 : 0.9,
          zIndex:   isResizingThis || isDraggingThis ? 20 : 10,
          cursor:   editable ? (isDraggingThis ? 'grabbing' : 'grab') : 'default',
          touchAction: editable ? 'none' : undefined,
        }}
        title={editable ? block.content : `${block.content}\n(이 날짜의 일간 노트를 열면 옮기거나 늘릴 수 있습니다)`}
      >
        {/* Top resize */}
        {editable && (
          <div
            data-resize="top"
            className="absolute top-0 left-0 right-0 flex items-center justify-center"
            style={{ height: 8, cursor: 'ns-resize', zIndex: 5 }}
            onPointerDown={ev => onResizeTopDn(ev, block)}
            onPointerMove={ev => onResizeTopMv(ev, block)}
            onPointerUp={() => onResizeTopUp(true)}
            onPointerCancel={() => onResizeTopUp(false)}
          >
            <div className="w-8 h-[2px] rounded-full bg-current opacity-0 group-hover:opacity-50 transition-opacity" />
          </div>
        )}

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
            {`${block.startHour}:${String(block.startMinute).padStart(2, '0')}`}
          </span>
          {deletable && (
            <button
              className="opacity-60 hover:opacity-100 flex-shrink-0 leading-none"
              aria-label={`${block.content} 타임블록 삭제`}
              onClick={ev => { ev.stopPropagation(); deleteBlock(block) }}
            >×</button>
          )}
        </div>

        {/* Bottom resize */}
        {editable && (
          <div
            data-resize="bottom"
            className="absolute bottom-0 left-0 right-0 flex items-center justify-center"
            style={{ height: 8, cursor: 'ns-resize' }}
            onPointerDown={ev => onResizeDn(ev, block)}
            onPointerMove={ev => onResizeMv(ev, block)}
            onPointerUp={() => onResizeUp(true)}
            onPointerCancel={() => onResizeUp(false)}
          >
            <div className="w-8 h-[2px] rounded-full bg-current opacity-0 group-hover:opacity-50 transition-opacity" />
          </div>
        )}
      </div>
    )
  }

  function renderCalendarEvent(item: ColEvent, colDate: string, lane: Lane | undefined) {
    const { ev, seg } = item
    const startM   = item.start, endM = item.end
    const top      = startM * PX_PER_MIN
    const height   = Math.max((endM - startM) * PX_PER_MIN, EVENT_MIN_H)
    const color    = ev.calendarColor ?? '#4285f4'
    const iv       = eventInterval(ev)
    const isActive = gcalOp?.ev.id === ev.id
    const editable = !!googleAccessToken && canEditEvent(ev)
    const declined = isDeclinedBySelf(ev)
    // 표시 시각: 끌고 있으면 칸 기준, 아니면 실제 시작/끝 (전날·다음날로 이어지면 날짜 표시)
    const startStr = isActive || !iv ? hhmm(startM) : format(iv.start, seg.startsBefore ? 'M/d HH:mm' : 'HH:mm')
    const endStr   = isActive || !iv ? hhmm(endM) : format(iv.end, seg.endsAfter ? 'M/d HH:mm' : 'HH:mm')

    return (
      <div
        key={`gcal-${ev.id}`}
        data-tl-event={ev.id}
        role="button"
        tabIndex={0}
        aria-label={`${ev.summary ?? '일정'} ${startStr}–${endStr}${declined ? ' (거절함)' : ''}${editable ? '' : ' (읽기 전용)'}`}
        className="absolute rounded overflow-hidden pointer-events-auto select-none group
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        style={{
          top, height, ...laneStyle(lane),
          zIndex: isActive ? 20 : 8,
          cursor: editable ? 'grab' : 'pointer',
          opacity: declined ? 0.5 : 1,
          touchAction: editable ? 'none' : undefined,
        }}
        title={`${ev.summary}\n${startStr} – ${endStr}${declined ? '\n(거절함)' : ''}${editable ? '' : '\n(읽기 전용)'}`}
        // pointer drag to move; short tap (< 4px) → open detail panel
        onPointerDown={editable ? (e => {
          if ((e.target as HTMLElement).closest('[data-resize]')) return
          onGcalDown(e, ev, colDate, 'move')
        }) : undefined}
        onPointerMove={editable ? onGcalMove : undefined}
        onPointerUp={editable ? onGcalUp : undefined}
        onPointerCancel={editable ? onGcalCancel : undefined}
        onClick={editable ? undefined : (e => togglePanel(ev, colDate, e.currentTarget as HTMLElement))}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            togglePanel(ev, colDate, e.currentTarget as HTMLElement)
          }
        }}
      >
        {/* Top resize handle — 이 칸에서 시작하는 일정만 */}
        {editable && !seg.startsBefore && (
          <div
            data-resize="top"
            className="absolute top-0 left-0 right-0 flex items-center justify-center"
            style={{ height: 8, cursor: 'ns-resize', zIndex: 5 }}
            onPointerDown={e => onGcalDown(e, ev, colDate, 'resizeTop')}
          >
            <div className="w-8 h-[2px] rounded-full bg-current opacity-0 group-hover:opacity-40 transition-opacity" />
          </div>
        )}

        {/* 반투명 배경 */}
        <div className="absolute inset-0 rounded" style={{ backgroundColor: color, opacity: 0.15 }} />
        {/* 왼쪽 컬러 바 */}
        <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l" style={{ backgroundColor: color, opacity: declined ? 0.5 : 1 }} />

        {/* 텍스트 */}
        <div className="relative pl-2 pr-1 py-0.5 h-full flex flex-col justify-center overflow-hidden">
          <div
            className="text-[11px] font-medium leading-tight truncate"
            style={{ color, textDecoration: declined ? 'line-through' : undefined }}
          >
            {ev.summary}
          </div>
          {height >= 34 && (
            <div className="text-[10px] leading-tight opacity-70 truncate" style={{ color }}>
              {startStr} – {endStr}
            </div>
          )}
        </div>

        {/* Bottom resize handle — 이 칸에서 끝나는 일정만 */}
        {editable && !seg.endsAfter && (
          <div
            data-resize="bottom"
            className="absolute bottom-0 left-0 right-0 flex items-center justify-center"
            style={{ height: 8, cursor: 'ns-resize', zIndex: 5 }}
            onPointerDown={e => onGcalDown(e, ev, colDate, 'resize')}
          >
            <div className="w-8 h-[2px] rounded-full bg-current opacity-0 group-hover:opacity-40 transition-opacity" />
          </div>
        )}
      </div>
    )
  }

  // ── Event detail panel ───────────────────────────────────────────────────

  function renderEventPanel() {
    if (!eventPanel || typeof window === 'undefined') return null
    const { date: evDate, anchorRect } = eventPanel
    // 이름을 바꾸는 등 스토어가 바뀌면 최신 값으로 보여준다
    const ev = useCalendarEventStore.getState().findEvent(eventPanel.ev.id) ?? eventPanel.ev
    const iv    = eventInterval(ev)
    const color = ev.calendarColor ?? '#4285f4'
    const cal   = calendars.find(c => c.id === ev.calendarId)
    const editable  = !!googleAccessToken && canEditEvent(ev)
    const deletable = !!googleAccessToken && canDeleteEvent(ev)
    const declined  = isDeclinedBySelf(ev)

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

    let timeLabel = 'All day'
    if (iv) {
      const sameDay = format(iv.start, 'yyyy-MM-dd') === format(iv.end, 'yyyy-MM-dd')
        || (iv.end.getHours() === 0 && iv.end.getMinutes() === 0 && iv.end.getTime() - iv.start.getTime() <= DAY_MINS * 60_000
            && format(addMinutes(iv.end, -1), 'yyyy-MM-dd') === format(iv.start, 'yyyy-MM-dd'))
      timeLabel = sameDay
        ? `${format(iv.start, 'HH:mm')} – ${format(iv.end, 'HH:mm')} · ${format(iv.start, 'MMM d, yyyy')}`
        : `${format(iv.start, 'MMM d HH:mm')} – ${format(iv.end, 'MMM d HH:mm')}`
    } else {
      timeLabel = `All day · ${format(parseISO(evDate), 'MMM d, yyyy')}`
    }

    return createPortal(
      <div
        ref={panelRef}
        role="dialog"
        aria-label={ev.summary ?? '일정'}
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
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter') confirmRename(ev)
                else if (e.key === 'Escape') { e.stopPropagation(); renamingRef.current = false; setRenaming(false) }
              }}
              onBlur={() => confirmRename(ev)}
              className="w-full text-sm font-semibold px-2 py-1 rounded bg-white/10
                         border border-blue-400/60 outline-none text-white"
            />
          ) : (
            <div
              className="text-sm font-semibold text-white leading-snug"
              style={declined ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}
            >
              {ev.summary}
            </div>
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
            <span>{timeLabel}</span>
          </div>

          {/* Calendar */}
          {cal && (
            <div className="flex items-center gap-2">
              <div className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <span className="truncate">{cal.summary}{editable ? '' : ' · 읽기 전용'}</span>
            </div>
          )}
          {declined && <div className="text-white/50">거절한 일정</div>}

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
          {editable && (
            <button
              onClick={() => { setRenameText(ev.summary ?? ''); renamingRef.current = true; setRenaming(true) }}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-white/80
                         hover:bg-white/8 transition-colors text-left"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              이름 변경
            </button>
          )}
          {ev.htmlLink && (
            <button
              onClick={() => { void openExternal(ev.htmlLink); setEventPanel(null) }}
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

          {deletable && (
            <button
              onClick={async () => {
                setEventPanel(null)
                removeEvent(evDate, ev.id)
                try {
                  await withGoogleToken(token => deleteCalendarEvent(token, ev.calendarId, ev.id))
                } catch (err) {
                  // 되돌리기 — addEvent 는 '방금 만든 일정'으로 등록해 2분간 재조회를 이겨버린다
                  restoreEvent(ev)
                  reportGoogleError(err, 'deleteCalendarEvent')
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
          )}
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
        {/* 쓰기 실패 알림 (권한 없음 등) */}
        {notice && (
          <div
            role="alert"
            data-tl-notice=""
            className="mx-1 mb-1 flex items-start gap-2 rounded-md bg-red-500/15 border border-red-500/30
                       px-2 py-1.5 text-[11px] leading-snug text-red-300"
          >
            <span className="flex-1 break-words">{notice}</span>
            <button
              onClick={() => setNotice(null)}
              aria-label="알림 닫기"
              className="opacity-70 hover:opacity-100 leading-none"
            >×</button>
          </div>
        )}

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
            const allDayEvs = (eventsByDate[d] ?? []).filter(isAllDayEvent)
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
                  const declined = isDeclinedBySelf(ev)
                  return (
                    <div
                      key={`ad-${ev.id}`}
                      role="button"
                      tabIndex={0}
                      className="text-[11px] font-medium px-1.5 py-0.5 rounded truncate
                                 cursor-pointer select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                      style={{
                        backgroundColor: color + '30', color,
                        opacity: declined ? 0.5 : 1,
                        textDecoration: declined ? 'line-through' : undefined,
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        togglePanel(ev, d, e.currentTarget as HTMLElement)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault(); e.stopPropagation()
                          togglePanel(ev, d, e.currentTarget as HTMLElement)
                        }
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
                      // 한글 IME는 조합 확정 Enter와 실제 Enter가 각각 들어온다
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
          const { evs, blocks, lanes } = columnItems(d)

          return (
            <div
              key={d}
              data-tl-col={d}
              className="flex-1 relative border-l border-[var(--border)]"
              style={{ height: TOTAL_H }}
            >
              {/* Hour rows — drop targets + click/Enter-to-create */}
              {HOURS.map(hour => (
                <div
                  key={hour}
                  data-tl-slot=""
                  data-tl-date={d}
                  data-tl-hour={hour}
                  tabIndex={0}
                  role="button"
                  aria-label={`${d} ${hour}:00 새 일정`}
                  className="absolute left-0 right-0 border-t border-[var(--border)]
                             focus:outline-none focus-visible:bg-blue-500/10"
                  style={{ top: hour * SLOT_H, height: SLOT_H, zIndex: 1 }}
                  onClick={e => {
                    // Don't open form if a GCal drag just ended
                    if (gcalOp || blockDrag) return
                    // Only open if clicking directly on the row (not a block)
                    if ((e.target as HTMLElement) !== e.currentTarget) return
                    const minute = minuteFromRowEvent(e)
                    setNewEventSlot({ date: d, startHour: hour, startMinute: minute })
                    setNewEventTitle('')
                    setCreateError(null)
                  }}
                  onKeyDown={e => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setNewEventSlot({ date: d, startHour: hour, startMinute: 0 })
                      setNewEventTitle('')
                      setCreateError(null)
                    } else if (e.key === 'Escape' && newEventSlot) {
                      closeNewEventForm()
                    }
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

              {/* Drag-over indicator (줄 드래그 미리보기 또는 블록 이동 미리보기) */}
              {(() => {
                const over = blockDrag?.moved && blockDrag.date === d
                  ? { hour: Math.floor(blockDrag.mins / 60), minute: blockDrag.mins % 60, duration: blockDrag.duration, disabled: false, reason: undefined }
                  : dragPreview?.date === d ? dragPreview : null
                if (!over) return null
                const dis = !!over.disabled
                return (
                  <div
                    data-tl-preview={dis ? 'disabled' : 'ok'}
                    className={`absolute left-1 right-1 rounded-md border border-dashed text-[10px] font-medium px-2 pt-0.5
                               pointer-events-none flex items-start gap-1 ${dis ? 'border-red-400/80 text-red-300' : 'border-blue-400/80 text-blue-300'}`}
                    style={{
                      top:        (over.hour * 60 + over.minute) * PX_PER_MIN,
                      height:     Math.min(over.duration, DAY_MINS - over.hour * 60 - over.minute) * PX_PER_MIN,
                      background: dis ? 'rgba(239,68,68,0.12)' : 'rgba(59,130,246,0.14)',
                      boxShadow:  dis ? '0 0 0 1px rgba(239,68,68,0.25)' : '0 0 0 1px rgba(59,130,246,0.25)',
                      transition: 'top 60ms ease, height 60ms ease',
                      zIndex:     30,
                    }}
                  >
                    {dis ? `⊘ ${over.reason ?? '여기에 놓을 수 없음'}` : formatTimeRange(over.hour, over.minute, over.duration)}
                  </div>
                )
              })()}

              {/* Google Calendar 이벤트 */}
              {evs.map(item => renderCalendarEvent(item, d, lanes.get(`e:${item.ev.id}`)))}

              {/* New-event ghost + 입력 카드 */}
              {newEventSlot?.date === d && (() => {
                const { startHour, startMinute } = newEventSlot
                const top = startHour * SLOT_H + startMinute * PX_PER_MIN
                const ghostH = DEFAULT_DURATION * PX_PER_MIN
                const primaryCal = calendars.find(c => c.id === newEventCalId)
                const calColor = primaryCal?.backgroundColor ?? '#4285f4'
                // 예전엔 30분 칸(30px) 안에 입력창·캘린더 선택·버튼을 다 우겨 넣어 잘렸다.
                // 이제 칸에는 자리 표시만 두고, 입력은 그 아래(밤 시간대면 위)에 뜨는 카드에서.
                const below = startHour < 19
                return (
                  <>
                    <div
                      className="absolute left-1 right-1 rounded-md border border-dashed pointer-events-none px-2 pt-0.5 text-[10px] font-medium tabular"
                      style={{ top, height: ghostH, zIndex: 39, borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)' }}
                    >
                      {formatTimeRange(startHour, startMinute, DEFAULT_DURATION)}
                    </div>
                    <div
                      ref={newEventFormRef}
                      role="dialog"
                      aria-label="새 항목"
                      className="absolute left-1 right-1 pointer-events-auto rounded-lg border border-[var(--border)] p-2.5 flex flex-col gap-2"
                      style={{
                        ...(below ? { top: top + ghostH + 4 } : { top: top - 4, transform: 'translateY(-100%)' }),
                        zIndex: 50, background: 'var(--bg-secondary)', boxShadow: 'var(--shadow-pop)',
                      }}
                      onKeyDown={e => { if (e.key === 'Escape') closeNewEventForm() }}
                    >
                      {/* 일정 / 할 일 */}
                      <div role="radiogroup" aria-label="만들 종류" className="grid grid-cols-2 p-0.5 rounded-md bg-[var(--hover-bg)]">
                        {(['event', 'task'] as const).map(k => (
                          <button key={k} role="radio" aria-checked={newEventKind === k}
                            onPointerDown={e => e.stopPropagation()}
                            onClick={() => { setNewEventKind(k); newEventInputRef.current?.focus() }}
                            className={`h-6 rounded text-[11px] font-medium transition-colors ${newEventKind === k
                              ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                          >
                            {k === 'event' ? '구글 일정' : '할 일 (노트)'}
                          </button>
                        ))}
                      </div>
                      <input
                        ref={newEventInputRef}
                        value={newEventTitle}
                        onChange={e => setNewEventTitle(e.target.value)}
                        onKeyDown={e => {
                          // 한글 IME는 조합 확정 Enter와 실제 Enter가 각각 들어온다
                          if (e.nativeEvent.isComposing || e.keyCode === 229) return
                          if (e.key === 'Enter') handleCreateEvent()
                        }}
                        placeholder={newEventKind === 'task' ? '할 일' : '일정 제목'}
                        aria-label={newEventKind === 'task' ? '새 할 일' : '새 일정 제목'}
                        className="w-full h-8 px-2 rounded-md text-[13px] outline-none bg-[var(--hover-bg)]
                          text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
                          border border-transparent focus:border-[var(--accent)]"
                      />
                      {newEventKind === 'event' ? (
                        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: calColor }} />
                          <select
                            value={newEventCalId}
                            onChange={e => setNewEventCalId(e.target.value)}
                            aria-label="캘린더"
                            className="flex-1 min-w-0 h-6 bg-transparent outline-none truncate text-[var(--text-secondary)]"
                            onPointerDown={e => e.stopPropagation()}
                          >
                            {writableCalendars.length === 0 && <option value="primary">기본 캘린더</option>}
                            {writableCalendars.map(c => (
                              <option key={c.id} value={c.id}>{c.summary}{c.primary ? ' ★' : ''}</option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                          이 날 노트의 Tasks 에 시간과 함께 들어갑니다
                        </p>
                      )}
                      {createError && (
                        <div className="text-[11px] leading-snug text-red-400 break-words">{createError}</div>
                      )}
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onPointerDown={e => e.stopPropagation()}
                          onClick={closeNewEventForm}
                          className="h-7 px-2.5 rounded-md text-xs text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-primary)]"
                        >
                          취소
                        </button>
                        <button
                          onPointerDown={e => e.stopPropagation()}
                          onClick={handleCreateEvent}
                          disabled={savingEvent || !newEventTitle.trim()}
                          className="h-7 px-3 rounded-md text-xs font-medium text-white transition-opacity disabled:opacity-40"
                          style={{ backgroundColor: 'var(--accent)' }}
                        >
                          {savingEvent ? '추가 중…' : '추가'}
                        </button>
                      </div>
                    </div>
                  </>
                )
              })()}

              {/* Time blocks */}
              {blocks.map(b => renderBlock(b, lanes.get(`b:${b.id}`)))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
