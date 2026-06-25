'use client'
import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { format, parseISO } from 'date-fns'
import DayTimeline from '@/components/calendar/DayTimeline'
import CalendarSettings from '@/components/calendar/CalendarSettings'
import { useCalendarStore } from '@/lib/stores/calendarStore'

interface Props {
  open: boolean
  onClose: () => void
}

/** Bottom-sheet wrapper around the day timeline, mirroring NotePlan's mobile Timeline panel. */
export default function TimelineSheet({ open, onClose }: Props) {
  const { selectedDate } = useCalendarStore()

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[140] bg-black/40"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed left-0 right-0 bottom-0 z-[150] h-[80vh] rounded-t-2xl
                       bg-[var(--bg-primary)] border-t border-[var(--border)]
                       flex flex-col overflow-hidden shadow-2xl"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'tween', duration: 0.25, ease: 'easeOut' }}
          >
            {/* Grab handle */}
            <div className="flex justify-center pt-2 pb-1" onClick={onClose}>
              <div className="w-10 h-1 rounded-full bg-[var(--text-muted)]/40" />
            </div>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--text-primary)]">Timeline</span>
                <span className="text-xs text-[var(--text-muted)]">
                  {format(parseISO(selectedDate), 'EEE, MMM d')}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <CalendarSettings />
                <button onClick={onClose} className="p-1.5 text-[var(--text-muted)] active:opacity-60" aria-label="닫기">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            {/* Timeline */}
            <div className="flex-1 overflow-y-auto px-1">
              <DayTimeline date={selectedDate} days={1} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
