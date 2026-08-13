'use client'
import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { format, parseISO, isValid, getWeek, getWeekYear } from 'date-fns'
import { useNoteStore } from '@/lib/stores/noteStore'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { getOrCreateDailyNote, getOrCreateWeeklyNote, getNoteByDate, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks, extractSupersedes } from '@/lib/parser/noteParser'
import { parseTimeBlockLines } from '@/lib/parser/timeBlockParser'
import { toggleTaskLine, type TaskOutlineTask } from '@/lib/parser/taskOutline'
import { useTimeBlockStore } from '@/lib/stores/timeBlockStore'
import { useLineUpdateStore } from '@/lib/stores/lineUpdateStore'
import { useTaskDotStore, hasOpenTask } from '@/lib/stores/taskDotStore'
import { useNoteRealtime } from '@/lib/hooks/useNoteRealtime'
import { usePromoteToAtom } from '@/lib/hooks/usePromoteToAtom'
import { useWikiLink } from '@/lib/hooks/useWikiLink'
import type { NoteRevision } from '@/lib/db/noteRepository'
import type { Note } from '@/types/note'
import HistoryIcon from '@/components/icons/HistoryIcon'
import TaskOutlinePanel from '@/components/editor/TaskOutlinePanel'
import BacklinksPanel from '@/components/editor/BacklinksPanel'
import SupersededBanner from '@/components/editor/SupersededBanner'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })
const NoteHistoryPanel = dynamic(() => import('@/components/editor/NoteHistoryPanel'), { ssr: false })

// 미니 캘린더/주간 노트와 동일한 CW 규칙 (일요일 시작 + firstWeekContainsDate:4)
const WK = { weekStartsOn: 0 as const, firstWeekContainsDate: 4 as const }

export default function DailyNotePage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-[var(--text-muted)]">Loading...</div>}>
      <DailyNoteInner />
    </Suspense>
  )
}

function DailyNoteInner() {
  const searchParams = useSearchParams()
  const date = searchParams.get('date') ?? format(new Date(), 'yyyy-MM-dd')
  const { setActiveNote, updateNote } = useNoteStore()
  const { setSelectedDate } = useCalendarStore()
  const { syncTimeBlocks, timeBlocks, updateTimeBlock } = useTimeBlockStore()
  const { pendingUpdate, clearUpdate } = useLineUpdateStore()
  const { setTaskDate } = useTaskDotStore()

  const [note, setNote]           = useState<Note | null>(null)
  const [isSaving, setIsSaving]   = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const { linkTargets, facets, openWikiLink } = useWikiLink()
  const { promote, dialog: promoteDialog } = usePromoteToAtom(note?.title)

  // 항상 최신 note를 가리키는 ref — effect cleanup에서 사용
  const noteRef = useRef<Note | null>(null)
  noteRef.current = note

  const dateObj   = parseISO(date)
  const validDate = isValid(dateObj) ? dateObj : new Date()
  const dateStr   = format(validDate, 'yyyy-MM-dd')

  const weekNum = getWeek(validDate, WK)
  const weekKey = `${getWeekYear(validDate, WK)}-W${weekNum.toString().padStart(2, '0')}`

  // ── 이 주의 주간 노트에 있는 task를 상단 요약박스에 표시 ──────────────────
  const [weeklyNote, setWeeklyNote] = useState<Note | null>(null)
  useEffect(() => {
    getOrCreateWeeklyNote(weekKey).then(setWeeklyNote).catch(console.error)
  }, [weekKey])

  const weeklyNoteRef = useRef<Note | null>(null)
  weeklyNoteRef.current = weeklyNote

  // 요약박스에서 task 체크 클릭 → 주간 노트에 저장 + (혹시 그 라인이 오늘 타임라인의
  // 타임블록으로도 잡혀있으면) 타임블록/구글캘린더 완료 표시까지 같이 동기화
  const handleToggleWeeklyTask = useCallback(async (task: TaskOutlineTask) => {
    const wn = weeklyNoteRef.current
    if (!wn) return
    const newLine = toggleTaskLine(task.raw, task.type)
    if (newLine == null) return
    const lines = wn.content.split('\n')
    const idx = lines.findIndex(l => l === task.raw)
    if (idx < 0) return
    lines[idx] = newLine
    const updatedContent = lines.join('\n')
    const updated: Note = {
      ...wn, content: updatedContent,
      tags: extractTags(updatedContent), mentions: extractMentions(updatedContent), backlinks: extractBacklinks(updatedContent), supersedes: extractSupersedes(updatedContent),
    }
    setWeeklyNote(updated)
    try {
      const saved = await upsertNote(updated)
      setWeeklyNote(saved)
    } catch (err) {
      console.error('[주간 task 토글 저장 실패]', err)
    }

    // 이 task 라인이 (오늘이든 다른 날이든) 이번 세션에 이미 로드된 타임블록과
    // 정확히 일치하면 타임라인/구글캘린더에도 완료 상태 반영 (DayTimeline의
    // 기존 googleSync useEffect가 timeBlocks 변경을 감지해 자동으로 처리함)
    const match = timeBlocks.find(b => b.noteLineText === task.raw)
    if (match) {
      const newPrefix = newLine.match(/^\s*(?:- \[[ x>-]\]\s|\+(?: \[x\])?\s)/i)?.[0] ?? match.linePrefix
      updateTimeBlock(match.id, { linePrefix: newPrefix, noteLineText: newLine })
      // 그 날짜의 실제 노트에도 반영해야 재방문/새로고침 시에도 유지됨
      const dayNote = await getNoteByDate(match.date)
      if (dayNote) {
        const dLines = dayNote.content.split('\n')
        const dIdx = dLines.findIndex(l => l === task.raw)
        if (dIdx >= 0) {
          dLines[dIdx] = newLine
          await upsertNote({ ...dayNote, content: dLines.join('\n') }).catch(err =>
            console.error('[타임블록 연결 노트 저장 실패]', err))
        }
      }
    }
  }, [timeBlocks, updateTimeBlock])

  // ── 실시간 동기화: 외부(MCP 등)가 이 노트를 고치면 즉시 반영 + 작성자 표시 ──
  const handleRemoteContent = useCallback((content: string) => {
    setNote(prev => {
      if (!prev) return prev
      const tags      = extractTags(content)
      const mentions  = extractMentions(content)
      const backlinks = extractBacklinks(content)
      const supersedes = extractSupersedes(content)
      const updated   = { ...prev, content, tags, mentions, backlinks, supersedes }
      setActiveNote(updated)
      updateNote(prev.id, { content, tags, mentions, backlinks, supersedes })
      syncTimeBlocks(dateStr, parseTimeBlockLines(content))
      setTaskDate(dateStr, hasOpenTask(content))
      return updated
    })
  }, [setActiveNote, updateNote, syncTimeBlocks, dateStr, setTaskDate])

  const { typingAuthor, markSelfWrite, save } = useNoteRealtime(note?.id, handleRemoteContent)

  const saveNote = useCallback(async (n: Note) => {
    try {
      const saved = await save(n)
      // 저장/충돌해결 결과의 updatedAt을 로컬에도 반영 — 안 그러면 다음 저장이
      // 매번 옛 baseline과 비교돼 매번 "충돌"로 오판한다. 그 사이 다른 날짜로
      // 넘어갔다면(noteRef가 이미 다른 노트) 여기 적용하지 않음.
      if (noteRef.current?.id === n.id) {
        setNote(prev => {
          if (!prev || prev.id !== n.id) return prev
          // 저장이 서버를 왕복하는 동안(2초+네트워크) 사용자가 계속 타이핑했다면
          // prev.content는 이미 n.content(저장 시점 스냅샷)보다 최신이다. 이때
          // saved.content로 되돌리면 NoteEditor가 "완전히 다른 문서"로 보고
          // 전체 교체 diff를 적용해 커서가 맨 위로 튕긴다 — updatedAt(충돌 판정
          // baseline)만 갱신하고 content는 건드리지 않는다.
          if (prev.content !== n.content) {
            return { ...prev, updatedAt: saved.updatedAt }
          }
          return { ...prev, content: saved.content, tags: saved.tags, mentions: saved.mentions, backlinks: saved.backlinks, supersedes: saved.supersedes, updatedAt: saved.updatedAt }
        })
      }
      console.log('[Save] ✅', n.date, 'len=', saved.content.length)
    } catch (err) {
      console.error('[Save] ❌', err)
      throw err
    }
  }, [save])

  const saveNoteRef = useRef(saveNote)
  saveNoteRef.current = saveNote

  // ── 날짜 변경 시: 이전 노트 저장 후 새 노트 로드 ──────────────────────────
  useEffect(() => {
    // cleanup: date 변경 직전에 현재 노트 저장
    // (component unmount 시에도 동일하게 동작)
    return () => {
      if (noteRef.current) {
        saveNoteRef.current(noteRef.current).catch(() => {})
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
        // 로드된 내용을 realtime baseline으로 등록 → 리로드 직후 echo 방어
        markSelfWrite(n.content, n.updatedAt)
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
    const supersedes = extractSupersedes(content)
    const updated   = { ...note, content, tags, mentions, backlinks, supersedes }
    setNote(updated)
    setActiveNote(updated)
    updateNote(note.id, { content, tags, mentions, backlinks, supersedes })
    syncTimeBlocks(dateStr, parseTimeBlockLines(content))
    setTaskDate(dateStr, hasOpenTask(content))
  }, [note, setActiveNote, updateNote, syncTimeBlocks, dateStr])

  handleChangeRef.current = handleChange

  const handleRestore = useCallback((revision: NoteRevision) => {
    handleChangeRef.current(revision.content)
    setShowHistory(false)
  }, [])

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
  }, [note, saveNote])

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
  }, [note?.content, saveNote])

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
      <div data-tauri-drag-region className="electron-drag flex items-center justify-between px-12 py-3 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            {format(validDate, 'EEEE')}
          </h1>
          <div className="text-sm text-[var(--text-muted)]">
            {format(validDate, 'MMMM d, yyyy')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {typingAuthor && (
            <span className="text-xs text-[var(--accent)] flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
              {typingAuthor} 작성 중…
            </span>
          )}
          {saveError && (
            <span className="text-xs text-red-400 max-w-[200px] truncate" title={saveError}>
              ⚠ {saveError}
            </span>
          )}
          {isSaving && !saveError && (
            <span className="text-xs text-[var(--text-muted)]">Saving...</span>
          )}
          <button
            onClick={() => setShowHistory(true)}
            title="이전 버전 보기"
            className="p-1.5 rounded text-[var(--accent)] hover:bg-white/5 transition-colors"
          >
            <HistoryIcon className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      <TaskOutlinePanel
        content={weeklyNote?.content ?? ''}
        title={`CW ${weekNum.toString().padStart(2, '0')} 할 일`}
        onToggleTask={handleToggleWeeklyTask}
      />

      {/* Editor */}
      <SupersededBanner title={note.title} onOpen={openWikiLink} />
      <div className="flex-1 overflow-hidden">
        <NoteEditor
          // 노트가 바뀌면 에디터를 새로 마운트한다. key 없이 인스턴스를
          // 재사용하면 날짜를 옮겨도 이전 노트 본문이 그대로 남는 경우가 있다
          // (8/12 페이지에 8/14 본문이 떠 있던 문제).
          key={note.id}
          content={note.content}
          onChange={handleChange}
          onSave={handleSave}
          onOpenWikiLink={openWikiLink}
          linkTargets={linkTargets}
          facets={facets}
          onPromote={promote}
        />
      </div>
      {promoteDialog}

      <BacklinksPanel title={note.title} noteId={note.id} />

      {showHistory && (
        <NoteHistoryPanel
          noteId={note.id}
          onRestore={handleRestore}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  )
}
