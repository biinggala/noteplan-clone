import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { eventCoveredDates, type GoogleCalendar, type GoogleCalendarEvent } from '@/lib/google/calendar'

interface MergeOptions {
  /** fetch 를 시작할 때의 fetchGen. 그 사이 캘린더를 켜고 끄면 결과를 버린다 */
  gen?: number
  /** 일부 캘린더가 실패한 결과 — 보여주되 '불러옴'으로 치지 않는다 (다음에 다시 fetch) */
  incomplete?: boolean
}

interface CalendarEventStore {
  // 캘린더 목록 (로컬 persist — 자주 안 바뀜)
  calendars: GoogleCalendar[]
  enabledCalendarIds: Set<string>
  setCalendars: (calendars: GoogleCalendar[]) => void
  toggleCalendar: (id: string) => void
  isCalendarEnabled: (id: string) => boolean

  // 날짜별 이벤트 캐시 (세션 중만 유지)
  eventsByDate: Record<string, GoogleCalendarEvent[]>
  fetchingDates: Set<string>
  fetchingMonths: Set<string>          // 'YYYY-MM' 단위 중복 fetch 방지
  /** 캘린더 on/off 때마다 증가 — 그 전에 출발한 fetch 결과는 버린다 */
  fetchGen: number
  /** 일부 캘린더가 실패해서 다시 불러와야 하는 날짜 */
  incompleteDates: Set<string>
  /** 타임라인에 잠깐 띄우는 오류 문구 (권한 없음 등 — 재연결 배너와 별개) */
  notice: string | null
  setNotice: (msg: string | null) => void
  /** 다시 fetch 해야 하는 날짜인가 (없음 또는 불완전) */
  needsFetch: (date: string) => boolean
  setEvents: (date: string, events: GoogleCalendarEvent[]) => void
  /** 여러 날짜 한번에. gen 이 낡았으면 무시하고 false */
  mergeEvents: (map: Record<string, GoogleCalendarEvent[]>, opts?: MergeOptions) => boolean
  setFetching: (date: string, v: boolean) => void
  setFetchingMonth: (month: string, v: boolean) => void
  invalidateDate: (date: string) => void
  /** 이벤트 추가 (optimistic create) — 잠깐 동안 재fetch 결과에 없어도 유지 */
  addEvent: (date: string, event: GoogleCalendarEvent) => void
  /** 지웠던 이벤트를 되돌림 (실패 롤백용 — recentAdds 에 넣지 않는다) */
  restoreEvent: (event: GoogleCalendarEvent) => void
  /** 이벤트 삭제 (optimistic delete) — 걸쳐 있는 모든 날짜에서 */
  removeEvent: (date: string, eventId: string) => void
  /** 이벤트 필드 업데이트 (optimistic update). 시각이 바뀌면 날짜 칸도 다시 나눈다 */
  updateEvent: (eventId: string, patch: Partial<GoogleCalendarEvent>) => void
  /** id 로 이벤트 찾기 (어느 날짜 칸이든) */
  findEvent: (eventId: string) => GoogleCalendarEvent | undefined
}

// 방금 만든 이벤트. 만드는 도중 토큰이 갱신되면 전체 재fetch가 같이 출발하는데,
// 그 응답은 생성 '전' 목록이라 도착하는 순간 새 이벤트를 덮어써 화면에서 지웠다.
// 잠깐 동안은 fetch 결과에 없어도 살려둔다 (다음 fetch부터는 구글 목록에 들어 있다).
const RECENT_ADD_TTL = 2 * 60 * 1000
const recentAdds = new Map<string, { event: GoogleCalendarEvent; at: number }>()

function keepRecentAdds(map: Record<string, GoogleCalendarEvent[]>) {
  const now = Date.now()
  const out = { ...map }
  for (const [id, r] of recentAdds) {
    if (now - r.at > RECENT_ADD_TTL) { recentAdds.delete(id); continue }
    for (const d of eventCoveredDates(r.event)) {
      const list = out[d]
      if (list && !list.some(e => e.id === id)) out[d] = [...list, r.event]
    }
  }
  return out
}

/** id 를 모든 날짜 칸에서 빼고, 이벤트가 걸친 날짜 중 이미 불러온 칸에 다시 넣는다 */
function placeEvent(
  byDate: Record<string, GoogleCalendarEvent[]>,
  ev: GoogleCalendarEvent,
  forceDate?: string,
): Record<string, GoogleCalendarEvent[]> {
  const out: Record<string, GoogleCalendarEvent[]> = {}
  for (const [d, list] of Object.entries(byDate)) {
    out[d] = list.some(e => e.id === ev.id) ? list.filter(e => e.id !== ev.id) : list
  }
  const covered = new Set(eventCoveredDates(ev))
  if (forceDate && covered.has(forceDate) && !out[forceDate]) out[forceDate] = []
  for (const d of covered) if (out[d]) out[d] = [...out[d], ev]
  return out
}

function findIn(byDate: Record<string, GoogleCalendarEvent[]>, id: string) {
  for (const list of Object.values(byDate)) {
    const ev = list.find(e => e.id === id)
    if (ev) return ev
  }
  return undefined
}

export const useCalendarEventStore = create<CalendarEventStore>()(
  persist(
    (set, get) => ({
      calendars: [],
      enabledCalendarIds: new Set<string>(),
      eventsByDate: {},
      fetchingDates: new Set<string>(),
      fetchingMonths: new Set<string>(),
      fetchGen: 0,
      incompleteDates: new Set<string>(),
      notice: null,

      setNotice: (msg) => set({ notice: msg }),

      setCalendars: (calendars) => set(state => {
        // 새 캘린더는 기본으로 활성화
        const enabled = new Set(state.enabledCalendarIds)
        let added = false
        calendars.forEach(c => { if (!enabled.has(c.id)) { enabled.add(c.id); added = true } })
        if (!added) return { calendars }
        // 새로 켜진 캘린더 일정은 이미 불러온 날짜에도 없다 → 캐시를 비워 다시 불러오게
        return {
          calendars, enabledCalendarIds: enabled,
          eventsByDate: {}, fetchGen: state.fetchGen + 1,
          fetchingDates: new Set<string>(), fetchingMonths: new Set<string>(),
          incompleteDates: new Set<string>(),
        }
      }),

      toggleCalendar: (id) => set(state => {
        const next = new Set(state.enabledCalendarIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        // 캐시 초기화 + 진행 중이던 fetch 무효화. fetching 표시도 비워야 새 fetch 가 바로 출발한다
        // (예전엔 진행 중이던 fetch 가 끝 calendar 집합으로 도착해 꺼진 캘린더 일정이 남았다)
        return {
          enabledCalendarIds: next,
          eventsByDate: {},
          fetchGen: state.fetchGen + 1,
          fetchingDates: new Set<string>(),
          fetchingMonths: new Set<string>(),
          incompleteDates: new Set<string>(),
        }
      }),

      isCalendarEnabled: (id) => get().enabledCalendarIds.has(id),

      needsFetch: (date) => {
        const st = get()
        return st.eventsByDate[date] === undefined || st.incompleteDates.has(date)
      },

      setEvents: (date, events) =>
        set(state => ({ eventsByDate: { ...state.eventsByDate, [date]: events } })),

      mergeEvents: (map, opts) => {
        if (opts?.gen !== undefined && opts.gen !== get().fetchGen) return false
        set(state => {
          const incomplete = new Set(state.incompleteDates)
          for (const d of Object.keys(map)) {
            if (opts?.incomplete) incomplete.add(d)
            else incomplete.delete(d)
          }
          return {
            eventsByDate: { ...state.eventsByDate, ...keepRecentAdds(map) },
            incompleteDates: incomplete,
          }
        })
        return true
      },

      setFetching: (date, v) => set(state => {
        const next = new Set(state.fetchingDates)
        if (v) next.add(date)
        else next.delete(date)
        return { fetchingDates: next }
      }),

      setFetchingMonth: (month, v) => set(state => {
        const next = new Set(state.fetchingMonths)
        if (v) next.add(month)
        else next.delete(month)
        return { fetchingMonths: next }
      }),

      invalidateDate: (date) => set(state => {
        const rest = { ...state.eventsByDate }
        delete rest[date]
        return { eventsByDate: rest }
      }),

      addEvent: (date, event) => set(state => {
        recentAdds.set(event.id, { event, at: Date.now() })
        // 아직 불러오지 않은 날짜에 칸을 새로 만들면 '불러옴'으로 보이므로 불완전 표시
        const incomplete = state.eventsByDate[date] === undefined
          ? new Set([...state.incompleteDates, date])
          : state.incompleteDates
        return { eventsByDate: placeEvent(state.eventsByDate, event, date), incompleteDates: incomplete }
      }),

      restoreEvent: (event) => set(state => ({ eventsByDate: placeEvent(state.eventsByDate, event) })),

      removeEvent: (_date, eventId) => set(state => {
        recentAdds.delete(eventId)
        const out: Record<string, GoogleCalendarEvent[]> = {}
        for (const [d, list] of Object.entries(state.eventsByDate)) {
          out[d] = list.some(e => e.id === eventId) ? list.filter(e => e.id !== eventId) : list
        }
        return { eventsByDate: out }
      }),

      updateEvent: (eventId, patch) => set(state => {
        const existing = findIn(state.eventsByDate, eventId)
        if (!existing) return {}
        const updated = { ...existing, ...patch }
        const recent = recentAdds.get(eventId)
        if (recent) recentAdds.set(eventId, { ...recent, event: updated })
        return { eventsByDate: placeEvent(state.eventsByDate, updated) }
      }),

      findEvent: (eventId) => findIn(get().eventsByDate, eventId),
    }),
    {
      name: 'calendar-event-store',
      // Set은 JSON 직렬화 불가 → 배열로 변환
      partialize: (state) => ({
        calendars: state.calendars,
        enabledCalendarIds: [...state.enabledCalendarIds],
      }),
      merge: (persisted: unknown, current) => {
        const p = persisted as { calendars?: GoogleCalendar[]; enabledCalendarIds?: string[] }
        return {
          ...current,
          calendars: p?.calendars ?? [],
          enabledCalendarIds: new Set<string>(p?.enabledCalendarIds ?? []),
        }
      },
    }
  )
)
