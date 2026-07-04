'use client'
import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { format, addDays, startOfWeek, endOfWeek, getWeek, getWeekYear } from 'date-fns'
import { useNoteStore } from '@/lib/stores/noteStore'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { getOrCreateWeeklyNote, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks } from '@/lib/parser/noteParser'
import type { Note } from '@/types/note'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })

// 미니 캘린더와 동일: 일요일 시작 주 + CW 규칙 (firstWeekContainsDate:4)
const WK = { weekStartsOn: 0 as const, firstWeekContainsDate: 4 as const }

/** Parse "YYYY-WNN" → 그 주의 시작(일요일) */
function weekKeyToWeekStart(weekKey: string): Date {
  const [yearStr, weekPart] = weekKey.split('-W')
  const year = parseInt(yearStr)
  const week = parseInt(weekPart)
  const startW1 = startOfWeek(new Date(year, 0, 4), WK)
  return addDays(startW1, (week - 1) * 7)
}

export default function WeeklyNotePage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-[var(--text-muted)]">Loading...</div>}>
      <WeeklyNoteInner />
    </Suspense>
  )
}

function WeeklyNoteInner() {
  const searchParams = useSearchParams()
  const week = searchParams.get('week')
    ?? `${getWeekYear(new Date(), WK)}-W${getWeek(new Date(), WK).toString().padStart(2, '0')}`
  const { setActiveNote, updateNote } = useNoteStore()
  const { setSelectedDate } = useCalendarStore()
  const [note, setNote] = useState<Note | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const noteRef = useRef<Note | null>(null)
  noteRef.current = note

  // Compute week range (일요일 시작)
  const weekStart = weekKeyToWeekStart(week)   // 일요일
  const weekEnd   = endOfWeek(weekStart, WK)   // 토요일
  const weekNum = parseInt(week.split('-W')[1])
  const year = week.split('-W')[0]

  const rangeLabel = weekStart.getFullYear() === weekEnd.getFullYear()
    ? `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'MMM d, yyyy')}`
    : `${format(weekStart, 'MMM d, yyyy')} – ${format(weekEnd, 'MMM d, yyyy')}`

  useEffect(() => {
    // Highlight the week's start (Sunday) in the mini-calendar when viewing a weekly note
    setSelectedDate(format(weekStart, 'yyyy-MM-dd'))
    getOrCreateWeeklyNote(week).then(n => {
      setNote(n)
      setActiveNote(n)
    })
  }, [week, setSelectedDate, setActiveNote])

  const handleChange = useCallback((content: string) => {
    if (!note) return
    const tags      = extractTags(content)
    const mentions  = extractMentions(content)
    const backlinks = extractBacklinks(content)
    const updated   = { ...note, content, tags, mentions, backlinks }
    setNote(updated)
    setActiveNote(updated)
    updateNote(note.id, { content, tags, mentions, backlinks })
  }, [note, setActiveNote, updateNote])

  const handleSave = useCallback(async () => {
    if (!note) return
    setIsSaving(true)
    await upsertNote(note)
    setTimeout(() => setIsSaving(false), 800)
  }, [note])

  // 언마운트 시 즉시 저장
  useEffect(() => {
    return () => {
      if (noteRef.current) {
        upsertNote(noteRef.current).catch(console.error)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save every 2s
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => {
      setIsSaving(true)
      upsertNote(note)
        .then(() => setTimeout(() => setIsSaving(false), 600))
        .catch(console.error)
    }, 2000)
    return () => clearTimeout(timer)
  }, [note?.content])

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div data-tauri-drag-region className="electron-drag flex items-center justify-between px-12 py-3 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-amber-500/80 tracking-wider uppercase">
              CW {weekNum.toString().padStart(2, '0')}
            </span>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">
              Week {weekNum}, {year}
            </h1>
          </div>
          <div className="text-sm text-[var(--text-muted)]">{rangeLabel}</div>
        </div>
        <div className="flex items-center gap-2">
          {isSaving && (
            <span className="text-xs text-[var(--text-muted)]">Saving...</span>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <NoteEditor
          content={note.content}
          onChange={handleChange}
          onSave={handleSave}
        />
      </div>
    </div>
  )
}
