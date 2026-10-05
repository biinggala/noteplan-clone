'use client'
import { Suspense, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { format, getDaysInMonth } from 'date-fns'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { getOrCreateMonthlyNote } from '@/lib/db/noteRepository'
import { useNoteDocument } from '@/lib/hooks/useNoteDocument'
import SaveStatusBadge, { NoticeBar } from '@/components/editor/SaveStatusBadge'
import { usePromoteToAtom } from '@/lib/hooks/usePromoteToAtom'
import { useWikiLink } from '@/lib/hooks/useWikiLink'
import BacklinksPanel from '@/components/editor/BacklinksPanel'
import SupersededBanner from '@/components/editor/SupersededBanner'
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
  const { setSelectedDate } = useCalendarStore()
  const { linkTargets, facets, openWikiLink, openFacet } = useWikiLink()

  // 월 파싱
  const [yearStr, monthStr] = month.split('-')
  const year  = parseInt(yearStr)
  const monthNum = parseInt(monthStr)  // 1-based
  const firstDay = new Date(year, monthNum - 1, 1)
  const monthLabel = format(firstDay, 'MMMM yyyy')
  const daysLabel  = `${getDaysInMonth(firstDay)} days`

  // 미니 캘린더를 해당 월 1일로 이동
  useEffect(() => { setSelectedDate(`${yearStr}-${monthStr}-01`) }, [yearStr, monthStr, setSelectedDate])

  const loadMonthly = useCallback(async (m: string) => ({ note: await getOrCreateMonthlyNote(m) }), [])
  const doc = useNoteDocument(month, loadMonthly)
  const note = doc.note
  const { promote, dialog: promoteDialog } = usePromoteToAtom(note?.title)

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        {doc.error ?? 'Loading...'}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div data-tauri-drag-region className="electron-drag flex items-center justify-between px-5 md:px-12 py-3 border-b border-[var(--border)] flex-shrink-0">
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
          <SaveStatusBadge status={doc.status} error={doc.error} typingAuthor={doc.typingAuthor} />
        </div>
      </div>

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
    </div>
  )
}
