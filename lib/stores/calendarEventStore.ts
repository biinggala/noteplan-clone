import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GoogleCalendar, GoogleCalendarEvent } from '@/lib/google/calendar'

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
  setEvents: (date: string, events: GoogleCalendarEvent[]) => void
  mergeEvents: (map: Record<string, GoogleCalendarEvent[]>) => void  // 여러 날짜 한번에
  setFetching: (date: string, v: boolean) => void
  setFetchingMonth: (month: string, v: boolean) => void
  invalidateDate: (date: string) => void
  /** 이벤트 추가 (optimistic create) */
  addEvent: (date: string, event: GoogleCalendarEvent) => void
  /** 이벤트 삭제 (optimistic delete) */
  removeEvent: (date: string, eventId: string) => void
  /** 이벤트 필드 업데이트 (optimistic update) */
  patchEvent: (oldDate: string, newDate: string, eventId: string, patch: Partial<GoogleCalendarEvent>) => void
}

// 방금 만든 이벤트. 만드는 도중 토큰이 갱신되면 전체 재fetch가 같이 출발하는데,
// 그 응답은 생성 '전' 목록이라 도착하는 순간 새 이벤트를 덮어써 화면에서 지웠다.
// 잠깐 동안은 fetch 결과에 없어도 살려둔다 (다음 fetch부터는 구글 목록에 들어 있다).
const RECENT_ADD_TTL = 2 * 60 * 1000
const recentAdds = new Map<string, { date: string; event: GoogleCalendarEvent; at: number }>()

function keepRecentAdds(map: Record<string, GoogleCalendarEvent[]>) {
  const now = Date.now()
  const out = { ...map }
  for (const [id, r] of recentAdds) {
    if (now - r.at > RECENT_ADD_TTL) { recentAdds.delete(id); continue }
    const list = out[r.date]
    if (list && !list.some(e => e.id === id)) out[r.date] = [...list, r.event]
  }
  return out
}

export const useCalendarEventStore = create<CalendarEventStore>()(
  persist(
    (set, get) => ({
      calendars: [],
      enabledCalendarIds: new Set<string>(),
      eventsByDate: {},
      fetchingDates: new Set<string>(),
      fetchingMonths: new Set<string>(),

      setCalendars: (calendars) => set(state => {
        // 새 캘린더는 기본으로 활성화
        const enabled = new Set(state.enabledCalendarIds)
        calendars.forEach(c => { if (!enabled.has(c.id)) enabled.add(c.id) })
        return { calendars, enabledCalendarIds: enabled }
      }),

      toggleCalendar: (id) => set(state => {
        const next = new Set(state.enabledCalendarIds)
        next.has(id) ? next.delete(id) : next.add(id)
        return { enabledCalendarIds: next, eventsByDate: {} } // 캐시 초기화
      }),

      isCalendarEnabled: (id) => get().enabledCalendarIds.has(id),

      setEvents: (date, events) =>
        set(state => ({ eventsByDate: { ...state.eventsByDate, [date]: events } })),

      mergeEvents: (map) =>
        set(state => ({ eventsByDate: { ...state.eventsByDate, ...keepRecentAdds(map) } })),

      setFetching: (date, v) => set(state => {
        const next = new Set(state.fetchingDates)
        v ? next.add(date) : next.delete(date)
        return { fetchingDates: next }
      }),

      setFetchingMonth: (month, v) => set(state => {
        const next = new Set(state.fetchingMonths)
        v ? next.add(month) : next.delete(month)
        return { fetchingMonths: next }
      }),

      invalidateDate: (date) => set(state => {
        const { [date]: _, ...rest } = state.eventsByDate
        return { eventsByDate: rest }
      }),

      addEvent: (date, event) => set(state => {
        recentAdds.set(event.id, { date, event, at: Date.now() })
        return {
          eventsByDate: {
            ...state.eventsByDate,
            [date]: [...(state.eventsByDate[date] ?? []), event],
          },
        }
      }),

      removeEvent: (date, eventId) => set(state => {
        recentAdds.delete(eventId)
        return {
          eventsByDate: {
            ...state.eventsByDate,
            [date]: (state.eventsByDate[date] ?? []).filter(e => e.id !== eventId),
          },
        }
      }),

      patchEvent: (oldDate, newDate, eventId, patch) => set(state => {
        // Remove from old date bucket
        const oldBucket = (state.eventsByDate[oldDate] ?? []).filter(e => e.id !== eventId)
        const existing  = (state.eventsByDate[oldDate] ?? []).find(e => e.id === eventId)
        if (!existing) return {}
        const updated = { ...existing, ...patch }
        const recent = recentAdds.get(eventId)
        if (recent) recentAdds.set(eventId, { ...recent, date: newDate, event: updated })
        // Insert into new date bucket (may be same date)
        const newBucket = [...(oldDate === newDate ? oldBucket : (state.eventsByDate[newDate] ?? [])), updated]
        return {
          eventsByDate: {
            ...state.eventsByDate,
            [oldDate]: oldBucket,
            ...(oldDate !== newDate ? { [newDate]: newBucket } : { [oldDate]: newBucket }),
          },
        }
      }),
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
