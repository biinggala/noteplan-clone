'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { useUIStore } from '@/lib/stores/uiStore'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import MobileMonthCalendar from './MobileMonthCalendar'
import MobileDrawer from './MobileDrawer'
import TimelineSheet from './TimelineSheet'

/** Phone shell: top bar + month calendar + note + bottom actions, à la NotePlan mobile. */
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { setCommandBarOpen } = useUIStore()
  const { today } = useCalendarStore()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [calCollapsed, setCalCollapsed] = useState(false)

  return (
    <div
      className="flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden"
      style={{ height: '100dvh' }}
    >
      {/* Top bar */}
      <header
        className="flex items-center gap-3 px-3 flex-shrink-0"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 6px)', paddingBottom: 6 }}
      >
        <button
          onClick={() => setDrawerOpen(true)}
          className="p-1.5 text-[var(--text-primary)] active:opacity-60"
          aria-label="메뉴 열기"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          onClick={() => router.push(`/daily/${today}`)}
          className="w-7 h-7 rounded-full bg-orange-500 active:opacity-70 flex-shrink-0"
          aria-label="오늘로 이동"
        />
        <div className="flex-1" />
        <button
          onClick={() => setCalCollapsed(v => !v)}
          className="p-1.5 text-[var(--text-muted)] active:opacity-60"
          aria-label={calCollapsed ? '달력 펼치기' : '달력 접기'}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {calCollapsed ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7l-4 5 4 5M16 7l4 5-4 5" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 8l5-4 5 4M7 16l5 4 5-4" />
            )}
          </svg>
        </button>
      </header>

      {/* Month calendar */}
      <div className="flex-shrink-0 border-b border-[var(--border)] pb-1">
        <MobileMonthCalendar collapsed={calCollapsed} />
      </div>

      {/* Note (route content) */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {children}
      </main>

      {/* Bottom floating actions */}
      <div
        className="pointer-events-none fixed right-4 z-[100] flex flex-col items-end gap-3"
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
      >
        <button
          onClick={() => setCommandBarOpen(true)}
          className="pointer-events-auto w-11 h-11 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)]
                     shadow-lg flex items-center justify-center text-[var(--accent)] active:scale-95 transition-transform"
          aria-label="검색"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
        <button
          onClick={() => setTimelineOpen(true)}
          className="pointer-events-auto w-11 h-11 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)]
                     shadow-lg flex items-center justify-center text-[var(--accent)] active:scale-95 transition-transform"
          aria-label="타임라인"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="18" rx="2" strokeWidth={1.8} />
            <path strokeLinecap="round" strokeWidth={1.8} d="M3 9h18M12 13v3.5l2 1" />
          </svg>
        </button>
      </div>

      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <TimelineSheet open={timelineOpen} onClose={() => setTimelineOpen(false)} />
    </div>
  )
}
