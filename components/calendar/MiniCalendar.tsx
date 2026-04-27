'use client'
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek, isSameMonth, isSameDay, isToday,
  addMonths, subMonths, parseISO,
  getISOWeek, getISOWeekYear,
} from 'date-fns'
import { useState, useEffect } from 'react'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useAuthStore } from '@/lib/stores/authStore'
import { useTaskDotStore, hasOpenTask } from '@/lib/stores/taskDotStore'
import { fetchAllCalendarEventsForRange } from '@/lib/google/calendar'
import { getNoteSummariesByDateRange } from '@/lib/db/noteRepository'
import { useRouter } from 'next/navigation'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

export default function MiniCalendar() {
  const router = useRouter()
  const { selectedDate, setSelectedDate, today } = useCalendarStore()
  const [viewDate, setViewDate] = useState<Date>(new Date(0))
  useEffect(() => { setViewDate(new Date()) }, [])

  const { googleAccessToken } = useAuthStore()
  const {
    calendars, enabledCalendarIds,
    eventsByDate, mergeEvents,
    fetchingMonths, setFetchingMonth,
  } = useCalendarEventStore()
  const { taskDates, setTaskDates } = useTaskDotStore()

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
    if (!googleAccessToken || calendars.length === 0 || viewDate.getTime() === 0) return
    const monthKey = format(viewDate, 'yyyy-MM')
    if (fetchingMonths.has(monthKey)) return

    // 이미 이 월의 날짜 중 하나라도 fetch된 게 있으면 skip (toggleCalendar 후 재fetch는 캐시 삭제로 처리)
    const startStr = format(calStart, 'yyyy-MM-dd')
    const endStr   = format(calEnd,   'yyyy-MM-dd')
    const allFetched = allDays.every(d => eventsByDate[format(d, 'yyyy-MM-dd')] !== undefined)
    if (allFetched) return

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
      .catch(err => console.error('[MiniCalendar fetch]', err))
      .finally(() => setFetchingMonth(monthKey, false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleAccessToken, calendars, enabledCalendarIds, viewDate])

  // ── 월 단위 노트 fetch → 태스크 점 계산 ─────────────────────────────────
  useEffect(() => {
    if (viewDate.getTime() === 0) return
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
    router.push(`/daily/${dateStr}`)
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
        <button
          onClick={() => setViewDate(new Date())}
          className="text-sm font-medium text-[var(--text-primary)] hover:text-blue-400 transition-colors"
        >
          {format(viewDate, 'MMMM yyyy')}
        </button>
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
                onClick={() => router.push(`/weekly/${wk}`)}
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
