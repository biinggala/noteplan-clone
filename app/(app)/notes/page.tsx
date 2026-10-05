'use client'
import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { getNoteById, upsertNote } from '@/lib/db/noteRepository'
import { useNoteDocument } from '@/lib/hooks/useNoteDocument'
import SaveStatusBadge, { NoticeBar } from '@/components/editor/SaveStatusBadge'
import { usePromoteToAtom } from '@/lib/hooks/usePromoteToAtom'
import { useWikiLink } from '@/lib/hooks/useWikiLink'
import type { NoteRevision } from '@/lib/db/noteRepository'
import type { Note } from '@/types/note'
import HistoryIcon from '@/components/icons/HistoryIcon'
import BacklinksPanel from '@/components/editor/BacklinksPanel'
import SupersededBanner from '@/components/editor/SupersededBanner'
import NoteBreadcrumb from '@/components/editor/NoteBreadcrumb'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })
const NoteHistoryPanel = dynamic(() => import('@/components/editor/NoteHistoryPanel'), { ssr: false })

export default function NotePage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-[var(--text-muted)]">Loading...</div>}>
      <NoteInner />
    </Suspense>
  )
}

function NoteInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const noteId = searchParams.get('id') ?? 'new'
  const [showHistory, setShowHistory] = useState(false)
  const { linkTargets, facets, openWikiLink, openFacet } = useWikiLink()

  // /notes?id=new — 새 노트를 만들어 그 id 로 주소를 바꾼다 (뒤로 가기·새로 고침에도 같은 노트)
  const creatingRef = useRef(false)
  useEffect(() => {
    if (noteId !== 'new') { creatingRef.current = false; return }
    if (creatingRef.current) return   // 개발 모드 이중 실행·빠른 재렌더에 두 개 만들지 않게
    creatingRef.current = true
    const fresh: Note = {
      id: crypto.randomUUID(),
      type: 'project',
      title: 'Untitled Note',
      content: '# Untitled Note\n\n',
      filePath: 'Notes/Untitled.md',
      tags: [], mentions: [], backlinks: [], supersedes: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    }
    upsertNote(fresh)
      .then(saved => router.replace(`/notes?id=${saved.id}`))
      .catch(err => console.error('[new note]', err))
  }, [noteId, router])

  const loadNote = useCallback(async (id: string) => {
    const n = await getNoteById(id)
    return n ? { note: n } : null
  }, [])
  const doc = useNoteDocument(noteId === 'new' ? null : noteId, loadNote)
  const note = doc.note
  const { promote, dialog: promoteDialog } = usePromoteToAtom(note?.title)

  // 노트가 없다(삭제됐거나 링크가 죽었다) → 오늘 데일리로
  useEffect(() => {
    if (doc.notFound) router.replace(`/daily?date=${format(new Date(), 'yyyy-MM-dd')}`)
  }, [doc.notFound, router])

  const handleRestore = useCallback((revision: NoteRevision) => {
    doc.setContent(revision.content)
    setShowHistory(false)
  }, [doc])

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        {doc.error ?? 'Loading...'}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div data-tauri-drag-region className="electron-drag px-5 md:px-12 py-3 border-b border-[var(--border)] flex-shrink-0 flex items-center justify-between">
        <NoteBreadcrumb title={note.title} folder={note.folder} />
        <div className="flex items-center gap-2">
          <SaveStatusBadge status={doc.status} error={doc.error} typingAuthor={doc.typingAuthor} />
          <button
            onClick={() => setShowHistory(true)}
            title="이전 버전 보기"
            className="p-1.5 rounded text-[var(--accent)] hover:bg-white/5 transition-colors"
          >
            <HistoryIcon className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
      {doc.notice && <NoticeBar text={doc.notice} onClose={doc.dismissNotice} />}
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
