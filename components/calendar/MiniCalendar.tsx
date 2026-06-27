'use client'
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek, isSameMonth, isSameDay, isToday,
  addMonths, subMonths, parseISO,
  getISOWeek, getISOWeekYear,
} from 'date-fns'
import { useEffect, useRef } from 'react'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useAuthStore } from '@/lib/stores/authStore'
import { useTaskDotStore, hasOpenTask } from '@/lib/stores/taskDotStore'
import { fetchAllCalendarEventsForRange } from '@/lib/google/calendar'
import { getNoteSummariesByDateRange } from '@/lib/db/noteRepository'
import { useRouter } from 'next/navigation'
import { startGoogleOAuth } from '@/lib/auth/googleOAuth'
import { createClient } from '@/lib/supabase/client'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

export default function MiniCalendar() {
  const router = useRouter()
  const { selectedDate, setSelectedDate, today, viewMonthDate: viewDate, setViewMonthDate: setViewDate } = useCalendarStore()

  const { googleAccessToken, googleAuthError, googleRefreshToken, setGoogleAuthError } = useAuthStore()
  const {
    calendars, enabledCalendarIds,
    eventsByDate, mergeEvents,
    fetchingMonths, setFetchingMonth,
  } = useCalendarEventStore()
  const { taskDates, setTaskDates } = useTaskDotStore()

  // 토큰이 바뀌면(재연결/자동갱신) 캐시를 무시하고 강제 재fetch
  const fetchedTokenRef = useRef<string | null>(null)

  const monthStart = startOfMonth(viewDate)
  const monthEnd   = endOfMonth(viewDate)
  const calStart   = startOfWeek(monthStart)
  const calEnd     = endOfWeek(monthEnd)
  const allDays    = eachDayOfInterval({ start: calStart, end: calEnd })

  // Week rows
  const weeks: Date[][] = []
  for (let i = 0; i < allDays.length; i += 7) weeks.push(allDays.slice(i, i + 7))

  // ── 미니 캘린더 뷰 월 단위 이벤트 fetch ────────────────────────────────────
  useEffect(() => {
    if (!googleAccessToken || calendars.length === 0) return
    const monthKey = format(viewDate, 'yyyy-MM')

    // 토큰이 바뀌었으면 캐시 무시하고 재fetch (재연결/자동갱신 즉시 반영)
    const tokenChanged = fetchedTokenRef.current !== googleAccessToken
    // 토큰 변경 시 진행 중인 fetch가 있어도 무시 (race condition 방지)
    if (fetchingMonths.has(monthKey) && !tokenChanged) return
    const startStr = format(calStart, 'yyyy-MM-dd')
    const endStr   = format(calEnd,   'yyyy-MM-dd')
    const allFetched = !tokenChanged &&
      allDays.every(d => eventsByDate[format(d, 'yyyy-MM-dd')] !== undefined)
    if (allFetched) return
    fetchedTokenRef.current = googleAccessToken

    setFetchingMonth(monthKey, true)
    fetchAllCalendarEventsForRange(googleAccessToken, calendars, enabledCalendarIds, startStr, endStr)
      .then(grouped => {
        // 이벤트 없는 날도 빈 배열로 채워서 "이미 fetch됨" 표시
        const full: Record<string, typeof grouped[string]> = {}
        allDays.forEach(d => {
          const ds = format(d, 'yyyy-MM-dd')
          full[ds] = grouped[ds] ?? []
        })
        mergeEvents(full)
      })
      .catch(err => {
        console.error('[MiniCalendar fetch]', err)
        // 토큰 만료인데 refresh token이 없으면(구버전 로그인) 갱신으로 못 살림 → 재연결 배너
        if (err instanceof Error && err.message === 'GOOGLE_TOKEN_EXPIRED' && !googleRefreshToken) {
          setGoogleAuthError('구글 토큰이 만료됐습니다. 재연결이 필요합니다.')
        }
      })
      .finally(() => setFetchingMonth(monthKey, false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleAccessToken, calendars, enabledCalendarIds, viewDate])

  // ── 월 단위 노트 fetch → 태스크 점 계산 ─────────────────────────────────
  useEffect(() => {
    const startStr = format(calStart, 'yyyy-MM-dd')
    const endStr   = format(calEnd,   'yyyy-MM-dd')

    getNoteSummariesByDateRange(startStr, endStr)
      .then(notes => {
        const entries: Record<string, boolean> = {}
        // 기본값: false (태스크 없음 or 노트 없음)
        allDays.forEach(d => { entries[format(d, 'yyyy-MM-dd')] = false })
        notes.forEach(n => {
          if (n.date) entries[n.date] = hasOpenTask(n.content)
        })
        setTaskDates(entries)
      })
      .catch(console.error)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDate])

  const handleDayClick = (day: Date) => {
    const dateStr = format(day, 'yyyy-MM-dd')
    setSelectedDate(dateStr)
    router.push(`/daily?date=${dateStr}`)
  }

  const cwKey = (sunday: Date) => {
    const n = getISOWeek(sunday)
    const y = getISOWeekYear(sunday)
    return `${y}-W${n.toString().padStart(2, '0')}`
  }

  const todayDate       = parseISO(today)
  const selectedDateObj = parseISO(selectedDate)

  return (
    <div className="p-3">
      {/* 토큰 갱신 실패 배너 — 재연결 유도 */}
      {googleAuthError && (
        <div className="mb-2 rounded-md bg-red-500/15 border border-red-500/30 px-2.5 py-2 text-[11px] text-red-300">
          <div className="font-semibold mb-1">캘린더 연결 만료</div>
          <div className="text-red-300/70 mb-1.5 break-words leading-snug">{googleAuthError}</div>
          <button
            onClick={() => startGoogleOAuth(createClient())}
            className="px-2 py-0.5 rounded bg-red-500/30 hover:bg-red-500/50 text-red-100 transition-colors"
          >
            재연결
          </button>
        </div>
      )}

      {/* Month navigation */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setViewDate(subMonths(viewDate, 1))}
          className="p-1 rounded hover:bg-white/10 text-[var(--text-muted)] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex items-center gap-1">
          {/* 월 클릭 → 해당 월 Monthly Note */}
          <button
            onClick={() => router.push(`/monthly?month=${format(viewDate, 'yyyy-MM')}`)}
            className="text-sm font-medium text-[var(--text-primary)] hover:text-emerald-400 transition-colors"
            title="Open monthly note"
          >
            {format(viewDate, 'MMMM yyyy')}
          </button>
          {/* 오늘로 복귀 (현재 월이 아닐 때만 표시) */}
          {format(viewDate, 'yyyy-MM') !== format(new Date(), 'yyyy-MM') && (
            <button
              onClick={() => setViewDate(new Date())}
              className="text-[10px] px-1 py-0.5 rounded bg-white/10 text-[var(--text-muted)]
                hover:bg-white/20 hover:text-[var(--text-primary)] transition-colors"
              title="Go to today"
            >
              today
            </button>
          )}
        </div>
        <button
          onClick={() => setViewDate(addMonths(viewDate, 1))}
          className="p-1 rounded hover:bg-white/10 text-[var(--text-muted)] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Column headers: CW + weekdays */}
      <div className="grid grid-cols-8 mb-1">
        <div className="text-center text-[10px] font-semibold text-amber-500/70 py-1 tracking-wide">
          CW
        </div>
        {WEEKDAYS.map(d => (
          <div key={d} className="text-center text-xs text-[var(--text-muted)] py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Week rows */}
      <div className="flex flex-col gap-0.5">
        {weeks.map(week => {
          const sunday = week[0]
          const wk     = cwKey(sunday)
          const cwNum  = getISOWeek(sunday).toString().padStart(2, '0')

          return (
            <div key={wk} className="grid grid-cols-8">
              {/* CW week number */}
              <button
                onClick={() => router.push(`/weekly?week=${wk}`)}
                className="flex items-center justify-center text-[10px] font-semibold
                           text-amber-500/60 hover:text-amber-400 hover:bg-amber-500/10
                           rounded transition-colors"
                title={`Open weekly note ${wk}`}
              >
                {cwNum}
              </button>

              {/* 7 day cells */}
              {week.map(day => {
                const dateStr        = format(day, 'yyyy-MM-dd')
                const isCurrentMonth = isSameMonth(day, viewDate)
                const isSelected     = isSameDay(day, selectedDateObj)
                const isTodayDay     = isToday(day)
                const dayEvents = eventsByDate[dateStr] ?? []
                const hasEvents = dayEvents.length > 0
                const hasTasks  = taskDates[dateStr] === true

                // 이벤트 점 색상: 첫 번째 이벤트의 캘린더 색상
                const dotColor = dayEvents[0]?.calendarColor ?? '#f472b6'

                return (
                  <div key={dateStr} className="flex flex-col items-center">
                    <button
                      onClick={() => handleDayClick(day)}
                      className={`
                        w-full aspect-square flex items-center justify-center rounded-full text-xs
                        transition-colors font-medium
                        ${!isSelected ? 'hover:bg-[var(--bg-tertiary)]' : ''}
                        ${isSelected
                          ? ''
                          : isTodayDay
                            ? 'text-blue-400 font-bold'
                            : !isCurrentMonth
                              ? 'text-[var(--text-muted)] opacity-30'
                              : 'text-[var(--text-primary)]'}
                      `}
                      style={isSelected ? {
                        backgroundColor: 'var(--accent)',
                        color: '#ffffff',
                      } : undefined}
                    >
                      {format(day, 'd')}
                    </button>

                    {/* 태스크·이벤트 점 */}
                    <div className="h-1.5 flex items-center justify-center gap-[3px] -mt-[1px]">
                      {/* 주황 빈 원 = 미완료 태스크 */}
                      {hasTasks && isCurrentMonth && (
                        <div
                          className="w-[5px] h-[5px] rounded-full"
                          style={{
                            border: '1.5px solid rgb(251 146 60 / 0.85)',
                            backgroundColor: 'transparent',
                          }}
                        />
                      )}
                      {/* 컬러 채워진 원 = 캘린더 이벤트 */}
                      {hasEvents && isCurrentMonth && (
                        <div
                          className="w-[5px] h-[5px] rounded-full"
                          style={{ backgroundColor: dotColor, opacity: 0.85 }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
