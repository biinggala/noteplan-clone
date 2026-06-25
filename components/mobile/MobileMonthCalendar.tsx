'use client'
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek, isSameMonth, isSameDay, isToday,
  addMonths, subMonths, parseISO, getISOWeek,
} from 'date-fns'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useAuthStore } from '@/lib/stores/authStore'
import { useTaskDotStore, hasOpenTask } from '@/lib/stores/taskDotStore'
import { fetchAllCalendarEventsForRange } from '@/lib/google/calendar'
import { getNoteSummariesByDateRange } from '@/lib/db/noteRepository'

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

interface Props {
  collapsed: boolean
}

/** Full-width month grid styled after the NotePlan mobile calendar. */
export default function MobileMonthCalendar({ collapsed }: Props) {
  const router = useRouter()
  const { selectedDate, setSelectedDate } = useCalendarStore()
  const [viewDate, setViewDate] = useState<Date>(new Date(0))
  useEffect(() => { setViewDate(parseISO(selectedDate)) }, [selectedDate])

  const { googleAccessToken } = useAuthStore()
  const {
    calendars, enabledCalendarIds, eventsByDate, mergeEvents,
    fetchingMonths, setFetchingMonth,
  } = useCalendarEventStore()
  const { taskDates, setTaskDates } = useTaskDotStore()

  const monthStart = startOfMonth(viewDate)
  const monthEnd = endOfMonth(viewDate)
  const calStart = startOfWeek(monthStart)
  const calEnd = endOfWeek(monthEnd)
  const allDays = useMemo(() => eachDayOfInterval({ start: calStart, end: calEnd }), [calStart, calEnd])

  const weeks = useMemo(() => {
    const rows: Date[][] = []
    for (let i = 0; i < allDays.length; i += 7) rows.push(allDays.slice(i, i + 7))
    return rows
  }, [allDays])

  const selectedObj = parseISO(selectedDate)
  const visibleWeeks = collapsed
    ? weeks.filter(w => w.some(d => isSameDay(d, selectedObj)))
    : weeks

  // Google Calendar events for the visible month
  useEffect(() => {
    if (!googleAccessToken || calendars.length === 0 || viewDate.getTime() === 0) return
    const monthKey = format(viewDate, 'yyyy-MM')
    if (fetchingMonths.has(monthKey)) return
    const allFetched = allDays.every(d => eventsByDate[format(d, 'yyyy-MM-dd')] !== undefined)
    if (allFetched) return
    setFetchingMonth(monthKey, true)
    fetchAllCalendarEventsForRange(
      googleAccessToken, calendars, enabledCalendarIds,
      format(calStart, 'yyyy-MM-dd'), format(calEnd, 'yyyy-MM-dd'),
    )
      .then(grouped => {
        const full: Record<string, typeof grouped[string]> = {}
        allDays.forEach(d => { const ds = format(d, 'yyyy-MM-dd'); full[ds] = grouped[ds] ?? [] })
        mergeEvents(full)
      })
      .catch(err => console.error('[MobileCalendar fetch]', err))
      .finally(() => setFetchingMonth(monthKey, false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleAccessToken, calendars, enabledCalendarIds, viewDate])

  // Note task dots for the visible month
  useEffect(() => {
    if (viewDate.getTime() === 0) return
    getNoteSummariesByDateRange(format(calStart, 'yyyy-MM-dd'), format(calEnd, 'yyyy-MM-dd'))
      .then(notes => {
        const entries: Record<string, boolean> = {}
        allDays.forEach(d => { entries[format(d, 'yyyy-MM-dd')] = false })
        notes.forEach(n => { if (n.date) entries[n.date] = hasOpenTask(n.content) })
        setTaskDates(entries)
      })
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDate])

  const handleDayClick = (day: Date) => {
    const ds = format(day, 'yyyy-MM-dd')
    setSelectedDate(ds)
    router.push(`/daily/${ds}`)
  }

  if (viewDate.getTime() === 0) {
    return <div className="h-40" />
  }

  return (
    <div className="select-none">
      {/* Month title row */}
      <div className="flex items-center justify-center gap-6 px-4 pt-1 pb-2">
        <button
          onClick={() => setViewDate(subMonths(viewDate, 1))}
          className="p-1.5 text-[var(--text-muted)] active:opacity-60"
          aria-label="이전 달"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={() => { const t = new Date(); setViewDate(t); handleDayClick(t) }}
          className="text-lg font-semibold text-[var(--text-primary)] min-w-[140px] text-center active:opacity-60"
        >
          {format(viewDate, 'MMMM yyyy')}
        </button>
        <button
          onClick={() => setViewDate(addMonths(viewDate, 1))}
          className="p-1.5 text-[var(--text-muted)] active:opacity-60"
          aria-label="다음 달"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid px-1" style={{ gridTemplateColumns: '28px repeat(7, 1fr)' }}>
        <div className="text-center text-[10px] font-semibold text-amber-500/80 py-1">CW</div>
        {WEEKDAYS.map(d => (
          <div key={d} className="text-center text-[10px] font-medium text-[var(--text-muted)] py-1 tracking-wide">
            {d}
          </div>
        ))}
      </div>

      {/* Weeks */}
      <div className="px-1">
        {visibleWeeks.map(week => {
          const cwNum = getISOWeek(week[0]).toString().padStart(2, '0')
          return (
            <div key={cwNum + format(week[0], 'yyyyMMdd')} className="grid items-stretch"
              style={{ gridTemplateColumns: '28px repeat(7, 1fr)' }}>
              <button
                onClick={() => router.push(`/weekly/${format(week[0], 'yyyy')}-W${cwNum}`)}
                className="flex items-center justify-center text-[10px] font-semibold text-amber-500/70 active:opacity-60"
              >
                {cwNum}
              </button>
              {week.map(day => {
                const ds = format(day, 'yyyy-MM-dd')
                const inMonth = isSameMonth(day, viewDate)
                const selected = isSameDay(day, selectedObj)
                const todayDay = isToday(day)
                const events = eventsByDate[ds] ?? []
                const hasEvents = events.length > 0
                const hasTasks = taskDates[ds] === true
                const dotColor = events[0]?.calendarColor ?? '#ec4899'
                return (
                  <button
                    key={ds}
                    onClick={() => handleDayClick(day)}
                    className={`relative flex flex-col items-center pt-1.5 pb-2 ${selected ? 'bg-blue-500/10 rounded-lg' : ''}`}
                  >
                    <span
                      className={`flex items-center justify-center w-8 h-8 rounded-full text-[15px] font-medium
                        ${selected
                          ? 'bg-[var(--accent)] text-white'
                          : todayDay
                            ? 'text-[var(--accent)] font-bold'
                            : inMonth
                              ? 'text-[var(--text-primary)]'
                              : 'text-[var(--text-muted)] opacity-40'}`}
                    >
                      {format(day, 'd')}
                    </span>
                    <span className="flex items-center gap-[3px] h-2 mt-[1px]">
                      {hasTasks && inMonth && (
                        <span className="w-[6px] h-[6px] rounded-full" style={{ backgroundColor: '#ec4899' }} />
                      )}
                      {hasEvents && inMonth && (
                        <span className="w-[6px] h-[6px] rounded-full" style={{ backgroundColor: dotColor }} />
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
