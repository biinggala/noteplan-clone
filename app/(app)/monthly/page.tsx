'use client'
import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { format, getDaysInMonth } from 'date-fns'
import { useNoteStore } from '@/lib/stores/noteStore'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { getOrCreateMonthlyNote, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks } from '@/lib/parser/noteParser'
import type { Note } from '@/types/note'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })

export default function MonthlyNotePage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-[var(--text-muted)]">Loading...</div>}>
      <MonthlyNoteInner />
    </Suspense>
  )
}

function MonthlyNoteInner() {
  const searchParams = useSearchParams()
  const month = searchParams.get('month') ?? format(new Date(), 'yyyy-MM')
  const { setActiveNote, updateNote } = useNoteStore()
  const { setSelectedDate } = useCalendarStore()
  const [note, setNote]       = useState<Note | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const noteRef = useRef<Note | null>(null)
  noteRef.current = note

  // 월 파싱
  const [yearStr, monthStr] = month.split('-')
  const year  = parseInt(yearStr)
  const monthNum = parseInt(monthStr)  // 1-based
  const firstDay = new Date(year, monthNum - 1, 1)
  const monthLabel = format(firstDay, 'MMMM yyyy')
  const daysLabel  = `${getDaysInMonth(firstDay)} days`

  useEffect(() => {
    // 미니 캘린더를 해당 월 1일로 이동
    setSelectedDate(`${yearStr}-${monthStr}-01`)
    getOrCreateMonthlyNote(month).then(n => {
      setNote(n)
      setActiveNote(n)
    })
  }, [month, setSelectedDate, setActiveNote])

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
      if (noteRef.current) upsertNote(noteRef.current).catch(console.error)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save 2초
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
            <span className="text-xs font-semibold text-emerald-500/80 tracking-wider uppercase">
              Monthly
            </span>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">
              {monthLabel}
            </h1>
          </div>
          <div className="text-sm text-[var(--text-muted)]">{daysLabel}</div>
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
