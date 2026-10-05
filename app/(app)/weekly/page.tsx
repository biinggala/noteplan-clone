'use client'
import { Suspense, useEffect, useRef, useCallback, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { format, addDays, startOfWeek, endOfWeek, getWeek, getWeekYear } from 'date-fns'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { getOrCreateWeeklyNote } from '@/lib/db/noteRepository'
import { useNoteDocument } from '@/lib/hooks/useNoteDocument'
import SaveStatusBadge, { NoticeBar } from '@/components/editor/SaveStatusBadge'
import { usePromoteToAtom } from '@/lib/hooks/usePromoteToAtom'
import { useWikiLink } from '@/lib/hooks/useWikiLink'
import BacklinksPanel from '@/components/editor/BacklinksPanel'
import SupersededBanner from '@/components/editor/SupersededBanner'
import PageHeader, { IconButton } from '@/components/layout/PageHeader'
import HistoryIcon from '@/components/icons/HistoryIcon'
import type { NoteRevision } from '@/lib/db/noteRepository'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })
const NoteHistoryPanel = dynamic(() => import('@/components/editor/NoteHistoryPanel'), { ssr: false })

// 미니 캘린더와 동일: 일요일 시작 주 + CW 규칙 (firstWeekContainsDate:4)
const WK = { weekStartsOn: 0 as const, firstWeekContainsDate: 4 as const }

const weekKeyOf = (d: Date) => `${getWeekYear(d, WK)}-W${getWeek(d, WK).toString().padStart(2, '0')}`

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
  const router = useRouter()
  const { setSelectedWeek } = useCalendarStore()
  const { linkTargets, facets, openWikiLink, openFacet } = useWikiLink()

  // Compute week range (일요일 시작)
  const weekStart = weekKeyToWeekStart(week)   // 일요일
  const weekEnd   = endOfWeek(weekStart, WK)   // 토요일
  const weekNum = parseInt(week.split('-W')[1])
  const year = week.split('-W')[0]

  const rangeLabel = weekStart.getFullYear() === weekEnd.getFullYear()
    ? `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'MMM d, yyyy')}`
    : `${format(weekStart, 'MMM d, yyyy')} – ${format(weekEnd, 'MMM d, yyyy')}`

  useEffect(() => {
    // 미니 캘린더에서 이 주 '행 전체'를 강조 (예전엔 시작일 하루만 찍혀 헷갈렸음)
    setSelectedWeek(week, weekKeyToWeekStart(week))
  }, [week, setSelectedWeek])

  // 예전 규칙(월~일)으로 자동 생성된 본문의 날짜 범위 줄을 교정.
  // "# Week N, YYYY" 바로 아래의 날짜 범위 형식 줄만 교체 (사용자 텍스트는 보존)
  const loadWeekly = useCallback(async (w: string) => {
    const n = await getOrCreateWeeklyNote(w)
    return { note: n }
  }, [])
  const doc = useNoteDocument(week, loadWeekly)
  const note = doc.note
  const { promote, dialog: promoteDialog } = usePromoteToAtom(note?.title)

  // 버전 기록 (데일리·노트와 같은 '타임머신')
  const [showHistory, setShowHistory] = useState(false)
  const handleRestore = useCallback((revision: NoteRevision) => {
    doc.setContent(revision.content)
    setShowHistory(false)
  }, [doc])

  const fixedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!note || note.date !== week || fixedFor.current === note.id) return
    fixedFor.current = note.id
    const lines = note.content.split('\n')
    const DATE_RANGE = /^[A-Za-z]{3} \d{1,2}(, \d{4})? [–—-] [A-Za-z]{3} \d{1,2}, \d{4}\s*$/
    if (lines[0]?.startsWith('# Week ') && DATE_RANGE.test(lines[1] ?? '') && lines[1] !== rangeLabel) {
      lines[1] = rangeLabel
      doc.setContent(lines.join('\n'))
    }
  }, [note, week, rangeLabel, doc])

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
        kicker={`CW ${weekNum.toString().padStart(2, '0')}`}
        title={rangeLabel}
        nav={{
          onPrev: () => router.push(`/weekly?week=${weekKeyOf(addDays(weekStart, -7))}`),
          onNext: () => router.push(`/weekly?week=${weekKeyOf(addDays(weekStart, 7))}`),
          onToday: () => router.push(`/weekly?week=${weekKeyOf(new Date())}`),
          isCurrent: week === weekKeyOf(new Date()),
          prevLabel: '지난주 (⌥⌘←)', nextLabel: '다음 주 (⌥⌘→)', todayLabel: 'This week',
        }}
        status={<SaveStatusBadge status={doc.status} error={doc.error} typingAuthor={doc.typingAuthor} />}
        actions={<IconButton label="이전 버전 보기" onClick={() => setShowHistory(true)}>
            <HistoryIcon className="w-4 h-4" />
          </IconButton>}
      />

      {doc.notice && <NoticeBar text={doc.notice} onClose={doc.dismissNotice} />}

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
