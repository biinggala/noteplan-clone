'use client'
import { use, useEffect, useRef, useState, useCallback } from 'react'
import { format, parseISO, isValid } from 'date-fns'
import { useNoteStore } from '@/lib/stores/noteStore'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { getOrCreateDailyNote, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks } from '@/lib/parser/noteParser'
import { parseTimeBlockLines } from '@/lib/parser/timeBlockParser'
import { useTimeBlockStore } from '@/lib/stores/timeBlockStore'
import { useLineUpdateStore } from '@/lib/stores/lineUpdateStore'
import { useTaskDotStore, hasOpenTask } from '@/lib/stores/taskDotStore'
import type { Note } from '@/types/note'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })

interface Props {
  params: Promise<{ date: string }>
}

async function saveNote(note: Note): Promise<void> {
  try {
    await upsertNote(note)
    console.log('[Save] ✅', note.date, 'len=', note.content.length)
  } catch (err) {
    console.error('[Save] ❌', err)
    throw err
  }
}

export default function DailyNotePage({ params }: Props) {
  const { date } = use(params)
  const { setActiveNote, updateNote } = useNoteStore()
  const { setSelectedDate } = useCalendarStore()
  const { syncTimeBlocks } = useTimeBlockStore()
  const { pendingUpdate, clearUpdate } = useLineUpdateStore()
  const { setTaskDate } = useTaskDotStore()

  const [note, setNote]           = useState<Note | null>(null)
  const [isSaving, setIsSaving]   = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // 항상 최신 note를 가리키는 ref — effect cleanup에서 사용
  const noteRef = useRef<Note | null>(null)
  noteRef.current = note

  const dateObj   = parseISO(date)
  const validDate = isValid(dateObj) ? dateObj : new Date()
  const dateStr   = format(validDate, 'yyyy-MM-dd')

  // ── 날짜 변경 시: 이전 노트 저장 후 새 노트 로드 ──────────────────────────
  useEffect(() => {
    // cleanup: date 변경 직전에 현재 노트 저장
    // (component unmount 시에도 동일하게 동작)
    return () => {
      if (noteRef.current) {
        saveNote(noteRef.current).catch(() => {})
      }
    }
  }, [date])  // date가 바뀔 때마다 cleanup 실행

  useEffect(() => {
    setNote(null)  // 로딩 중 표시
    setSelectedDate(dateStr)
    getOrCreateDailyNote(dateStr)
      .then(n => {
        setNote(n)
        setActiveNote(n)
        syncTimeBlocks(dateStr, parseTimeBlockLines(n.content))
        setTaskDate(dateStr, hasOpenTask(n.content))
      })
      .catch(err => {
        console.error('[DailyNote] 로드 실패:', err)
        setSaveError(`노트 로드 실패: ${err.message}`)
      })
  }, [date])

  // Ref always holds the latest handleChange
  const handleChangeRef = useRef<(c: string) => void>(() => {})

  const handleChange = useCallback((content: string) => {
    if (!note) return
    const tags      = extractTags(content)
    const mentions  = extractMentions(content)
    const backlinks = extractBacklinks(content)
    const updated   = { ...note, content, tags, mentions, backlinks }
    setNote(updated)
    setActiveNote(updated)
    updateNote(note.id, { content, tags, mentions, backlinks })
    syncTimeBlocks(dateStr, parseTimeBlockLines(content))
    setTaskDate(dateStr, hasOpenTask(content))
  }, [note, setActiveNote, updateNote, syncTimeBlocks, dateStr])

  handleChangeRef.current = handleChange

  // ── 수동 저장 (⌘S / 버튼) ─────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!note) return
    setIsSaving(true)
    setSaveError(null)
    try {
      await saveNote(note)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg)
    } finally {
      setTimeout(() => setIsSaving(false), 600)
    }
  }, [note])

  // ── Auto-save: 마지막 타이핑 후 2초 ───────────────────────────────────────
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => {
      setIsSaving(true)
      setSaveError(null)
      saveNote(note)
        .catch(err => setSaveError(err instanceof Error ? err.message : String(err)))
        .finally(() => setTimeout(() => setIsSaving(false), 600))
    }, 2000)
    return () => clearTimeout(timer)
  }, [note?.content])

  // ── Timeline → Note 라인 업데이트 ─────────────────────────────────────────
  useEffect(() => {
    if (!pendingUpdate || !note) return
    clearUpdate()
    const lines = note.content.split('\n')
    const idx   = lines.findIndex(l => l.trim() === pendingUpdate.find.trim())
    if (idx < 0) return
    const newLines = [...lines]
    newLines[idx] = pendingUpdate.replace
    handleChangeRef.current(newLines.join('\n'))
  }, [pendingUpdate])

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
      <div className="flex items-center justify-between px-4 md:px-12 py-3 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            {format(validDate, 'EEEE')}
          </h1>
          <div className="text-sm text-[var(--text-muted)]">
            {format(validDate, 'MMMM d, yyyy')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saveError && (
            <span className="text-xs text-red-400 max-w-[200px] truncate" title={saveError}>
              ⚠ {saveError}
            </span>
          )}
          {isSaving && !saveError && (
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
