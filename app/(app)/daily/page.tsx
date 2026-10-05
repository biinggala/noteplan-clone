'use client'
import { Suspense, useEffect, useState, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { format, parseISO, isValid, getWeek, getWeekYear, addDays, differenceInCalendarDays } from 'date-fns'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { getOrCreateDailyNote, getOrCreateWeeklyNote, updateNoteContentSafely } from '@/lib/db/noteRepository'
import { parseTimeBlockLines } from '@/lib/parser/timeBlockParser'
import { toggleTaskLine, type TaskOutlineTask } from '@/lib/parser/taskOutline'
import { useTimeBlockStore } from '@/lib/stores/timeBlockStore'
import { useLineUpdateStore } from '@/lib/stores/lineUpdateStore'
import { useTaskDotStore, hasOpenTask } from '@/lib/stores/taskDotStore'
import { useNoteDocument } from '@/lib/hooks/useNoteDocument'
import { usePromoteToAtom } from '@/lib/hooks/usePromoteToAtom'
import { useWikiLink } from '@/lib/hooks/useWikiLink'
import type { NoteRevision } from '@/lib/db/noteRepository'
import type { Note } from '@/types/note'
import HistoryIcon from '@/components/icons/HistoryIcon'
import TaskOutlinePanel from '@/components/editor/TaskOutlinePanel'
import BacklinksPanel from '@/components/editor/BacklinksPanel'
import SupersededBanner from '@/components/editor/SupersededBanner'
import SaveStatusBadge, { NoticeBar } from '@/components/editor/SaveStatusBadge'
import PageHeader, { IconButton } from '@/components/layout/PageHeader'
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
  const router = useRouter()
  const { setSelectedDate, today } = useCalendarStore()
  const { syncTimeBlocks, timeBlocks, updateTimeBlock } = useTimeBlockStore()
  const { pending: pendingUpdates, clearUpdates } = useLineUpdateStore()
  const { setTaskDate } = useTaskDotStore()

  const [showHistory, setShowHistory] = useState(false)
  const { linkTargets, facets, openWikiLink, openFacet } = useWikiLink()

  const dateObj   = parseISO(date)
  const validDate = isValid(dateObj) ? dateObj : new Date()
  const dateStr   = format(validDate, 'yyyy-MM-dd')

  const weekNum = getWeek(validDate, WK)
  const weekKey = `${getWeekYear(validDate, WK)}-W${weekNum.toString().padStart(2, '0')}`

  useEffect(() => { setSelectedDate(dateStr) }, [dateStr, setSelectedDate])

  const offset = differenceInCalendarDays(validDate, parseISO(today))
  const relativeDay = offset === 0 ? 'Today' : offset === -1 ? 'Yesterday' : offset === 1 ? 'Tomorrow' : undefined

  // ── 노트 편집 세션 (불러오기·저장·충돌 합치기·실시간 반영) ─────────────────
  const loadDaily = useCallback(async (d: string) => ({ note: await getOrCreateDailyNote(d) }), [])
  const doc = useNoteDocument(dateStr, loadDaily)
  const note = doc.note
  const { promote, dialog: promoteDialog } = usePromoteToAtom(note?.title)

  // 본문이 바뀔 때마다 타임라인 블록·캘린더 점 갱신 (어디서 바뀌었든)
  // date 가 다른 노트가 잠깐 남아 있는 동안엔 반영하지 않는다
  const content = note?.date === dateStr ? note.content : null
  useEffect(() => {
    if (content == null) return
    syncTimeBlocks(dateStr, parseTimeBlockLines(content))
    setTaskDate(dateStr, hasOpenTask(content))
  }, [content, dateStr, syncTimeBlocks, setTaskDate])

  // ── 이 주의 주간 노트에 있는 task를 상단 요약박스에 표시 ──────────────────
  const [weeklyNote, setWeeklyNote] = useState<Note | null>(null)
  useEffect(() => {
    let cancelled = false
    getOrCreateWeeklyNote(weekKey).then(n => { if (!cancelled) setWeeklyNote(n) }).catch(console.error)
    return () => { cancelled = true }
  }, [weekKey])

  // 요약박스에서 task 체크 → 주간 노트의 '최신본'에 반영 (화면에 들고 있던 옛 사본을
  // 통째로 저장하면 그 사이 다른 곳에서 고친 주간 노트 내용이 사라졌다)
  const handleToggleWeeklyTask = useCallback(async (task: TaskOutlineTask) => {
    const wn = weeklyNote
    if (!wn) return
    const newLine = toggleTaskLine(task.raw, task.type)
    if (newLine == null) return
    const toggleIn = (content: string) => {
      const lines = content.split('\n')
      const sameLines = lines.map((l, i) => (l === task.raw ? i : -1)).filter(i => i >= 0)
      if (sameLines.length === 0) return null
      const idx = sameLines[0]
      lines[idx] = newLine
      return lines.join('\n')
    }
    // 화면엔 바로 반영
    const optimistic = toggleIn(wn.content)
    if (optimistic != null) setWeeklyNote({ ...wn, content: optimistic })
    try {
      const saved = await updateNoteContentSafely(wn.id, toggleIn)
      if (saved) setWeeklyNote(saved)
    } catch (err) {
      console.error('[주간 task 토글 저장 실패]', err)
      setWeeklyNote(wn)
    }

    // 이 task 라인이 타임블록으로도 잡혀 있으면 타임라인/구글 캘린더에도 완료 상태 반영
    const match = timeBlocks.find(b => b.noteLineText === task.raw)
    if (match) {
      const newPrefix = newLine.match(/^\s*(?:- \[[ x>-]\]\s|\+(?: \[x\])?\s)/i)?.[0] ?? match.linePrefix
      updateTimeBlock(match.id, { linePrefix: newPrefix, noteLineText: newLine })
      if (match.date === dateStr && note) {
        // 지금 열려 있는 이 데일리 노트 — 편집 세션을 통해 바꾼다
        // (DB 에 직접 쓰면 편집 중인 내용과 충돌한다)
        const lines = note.content.split('\n')
        const i = lines.findIndex(l => l === task.raw)
        if (i >= 0) { lines[i] = newLine; doc.setContent(lines.join('\n')) }
      } else {
        const day = await getOrCreateDailyNote(match.date).catch(() => null)
        if (day) await updateNoteContentSafely(day.id, c => {
          const lines = c.split('\n')
          const i = lines.findIndex(l => l === task.raw)
          if (i < 0) return null
          lines[i] = newLine
          return lines.join('\n')
        }).catch(err => console.error('[타임블록 연결 노트 저장 실패]', err))
      }
    }
  }, [weeklyNote, timeBlocks, updateTimeBlock, dateStr, note, doc])

  const handleRestore = useCallback((revision: NoteRevision) => {
    doc.setContent(revision.content)
    setShowHistory(false)
  }, [doc])

  // ── Timeline → Note 라인 업데이트 ─────────────────────────────────────────
  const setDocContent = doc.setContent   // useCallback 으로 고정된 함수
  useEffect(() => {
    if (pendingUpdates.length === 0 || !note) return
    clearUpdates()
    // 여러 건을 한 번에 적용한다 — 한 건씩 처리하면 여러 줄을 동시에 떨어뜨렸을 때
    // 뒤엣것이 앞엣것을 덮어써서 마지막 줄만 반영됐다.
    const lines = note.content.split('\n')
    const used = new Set<number>()
    let changed = false
    for (const up of pendingUpdates) {
      // 다른 날짜 노트를 향한 요청(날짜를 옮기는 사이 쌓인 것 등)은 버린다
      if (up.date !== dateStr) continue
      // 같은 내용의 줄이 여러 개일 수 있으므로 이미 쓴 줄은 건너뛰고, 줄 번호를 알면 그 줄 우선
      const fits = (i: number) => !used.has(i) && lines[i] !== undefined && lines[i].trim() === up.find.trim()
      const idx = up.lineIndex !== undefined && fits(up.lineIndex) ? up.lineIndex : lines.findIndex((_, i) => fits(i))
      if (idx < 0) continue
      used.add(idx)
      lines[idx] = (lines[idx].match(/^\s*/)?.[0] ?? '') + up.replace.trimStart()  // 들여쓰기 유지
      changed = true
    }
    if (changed) setDocContent(lines.join('\n'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUpdates, note?.id])

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        {doc.error ?? 'Loading...'}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        kicker={relativeDay}
        title={format(validDate, 'EEEE')}
        subtitle={`CW ${weekNum.toString().padStart(2, '0')}`}
        nav={{
          onPrev: () => router.push(`/daily?date=${format(addDays(validDate, -1), 'yyyy-MM-dd')}`),
          onNext: () => router.push(`/daily?date=${format(addDays(validDate, 1), 'yyyy-MM-dd')}`),
          onToday: () => router.push(`/daily?date=${today}`),
          isCurrent: dateStr === today,
          prevLabel: '전날 (⌥⌘←)', nextLabel: '다음 날 (⌥⌘→)', todayLabel: 'Today',
        }}
        actions={<>
          <SaveStatusBadge status={doc.status} error={doc.error} typingAuthor={doc.typingAuthor} />
          <IconButton label="이전 버전 보기" onClick={() => setShowHistory(true)}>
            <HistoryIcon className="w-4 h-4" />
          </IconButton>
        </>}
      />

      {doc.notice && <NoticeBar text={doc.notice} onClose={doc.dismissNotice} />}

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
          onChange={doc.setContent}
          onSave={doc.saveNow}
          onOpenWikiLink={openWikiLink}
          onOpenFacet={openFacet}
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
