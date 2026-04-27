'use client'
import { useState } from 'react'
import MiniCalendar from '@/components/calendar/MiniCalendar'
import DayTimeline from '@/components/calendar/DayTimeline'
import CalendarSettings from '@/components/calendar/CalendarSettings'
import { useCalendarStore } from '@/lib/stores/calendarStore'

const DAY_OPTIONS = [1, 2, 3, 4, 5, 7]

export default function RightSidebar() {
  const { selectedDate } = useCalendarStore()
  const [days, setDays] = useState(1)

  return (
    <div className="flex flex-col h-full">
      {/* Mini Calendar */}
      <MiniCalendar />

      {/* Divider */}
      <div className="border-t border-[var(--border)] mx-3" />

      {/* Timeline header */}
      <div className="px-3 py-2 flex items-center justify-between">
        {/* 캘린더 설정 */}
        <CalendarSettings />

        {/* Days selector */}
        <div className="flex items-center gap-0.5">
          {DAY_OPTIONS.map(n => (
            <button
              key={n}
              onClick={() => setDays(n)}
              className={`text-[10px] w-6 h-5 rounded transition-colors ${
                days === n
                  ? 'bg-blue-500/20 text-blue-400 font-semibold'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              {n}d
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto">
        <DayTimeline date={selectedDate} days={days} />
      </div>
    </div>
  )
}
