'use client'
import { useEffect } from 'react'
import { addDays, format } from 'date-fns'
import { useAuthStore } from '@/lib/stores/authStore'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { withGoogleToken } from '@/lib/google/withToken'
import {
  fetchCalendarList, fetchAllCalendarEventsForRange, CalendarFetchError, type GoogleCalendarEvent,
} from '@/lib/google/calendar'

const REFRESH_MS = 5 * 60 * 1000

/**
 * 오늘·내일 일정을 화면과 상관없이 5분마다 불러온다 (앱 레이아웃에서 한 번 마운트).
 *
 * 알림은 eventsByDate[오늘]만 보는데, 그 칸은 타임라인·미니캘린더가 오늘을
 * 보여줄 때만 채워졌다. 다른 날을 보고 있거나 모바일 레이아웃이면 알림이
 * 오지 않았고, 다른 기기에서 추가한 일정도 다시 열기 전엔 몰랐다.
 */
export function useTodayEvents() {
  const token = useAuthStore(s => s.googleAccessToken)
  const calendarCount = useCalendarEventStore(s => s.calendars.length)
  const enabled = useCalendarEventStore(s => s.enabledCalendarIds)
  const fetchGen = useCalendarEventStore(s => s.fetchGen)

  useEffect(() => {
    if (!token) return
    let cancelled = false

    async function run() {
      const st = useCalendarEventStore.getState()
      if (st.calendars.length === 0) {
        // 타임라인이 없는 화면이면 캘린더 목록도 아무도 안 불러온다
        try {
          const list = await withGoogleToken(t => fetchCalendarList(t))
          if (!cancelled) st.setCalendars(list)   // 목록이 바뀌면 이 effect 가 다시 돈다
        } catch (err) { console.warn('[today events] calendar list', err) }
        return
      }
      const gen = st.fetchGen
      const today = format(new Date(), 'yyyy-MM-dd')
      const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
      const pick = (g: Record<string, GoogleCalendarEvent[]>) => ({ [today]: g[today] ?? [], [tomorrow]: g[tomorrow] ?? [] })
      try {
        const grouped = await withGoogleToken(t =>
          fetchAllCalendarEventsForRange(t, st.calendars, st.enabledCalendarIds, today, tomorrow))
        if (!cancelled) st.mergeEvents(pick(grouped), { gen })
      } catch (err) {
        if (cancelled) return
        if (err instanceof CalendarFetchError) st.mergeEvents(pick(err.partial), { gen, incomplete: true })
        console.warn('[today events]', err)
      }
    }

    void run()
    const id = setInterval(() => { void run() }, REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [token, calendarCount, enabled, fetchGen])
}
