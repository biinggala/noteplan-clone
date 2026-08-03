'use client'
import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { useNoteStore } from '@/lib/stores/noteStore'
import { getNoteById, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks } from '@/lib/parser/noteParser'
import { useNoteRealtime } from '@/lib/hooks/useNoteRealtime'
import { usePromoteToAtom } from '@/lib/hooks/usePromoteToAtom'
import { useWikiLink } from '@/lib/hooks/useWikiLink'
import type { NoteRevision } from '@/lib/db/noteRepository'
import type { Note } from '@/types/note'
import HistoryIcon from '@/components/icons/HistoryIcon'
import BacklinksPanel from '@/components/editor/BacklinksPanel'
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
  const noteId = searchParams.get('id') ?? 'new'
  const { setActiveNote, updateNote } = useNoteStore()
  const [note, setNote] = useState<Note | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const noteRef = useRef<Note | null>(null)
  noteRef.current = note
  const { linkTargets, facets, openWikiLink } = useWikiLink()
  const { promote, dialog: promoteDialog } = usePromoteToAtom(note?.title)

  // ── 실시간 동기화: 외부(MCP 등)가 이 노트를 고치면 즉시 반영 + 작성자 표시 ──
  const handleRemoteContent = useCallback((content: string) => {
    setNote(prev => {
      if (!prev) return prev
      const tags      = extractTags(content)
      const mentions  = extractMentions(content)
      const backlinks = extractBacklinks(content)
      const updated   = { ...prev, content, tags, mentions, backlinks }
      setActiveNote(updated)
      updateNote(prev.id, { content, tags, mentions, backlinks })
      return updated
    })
  }, [setActiveNote, updateNote])

  const { typingAuthor, markSelfWrite, save } = useNoteRealtime(note?.id, handleRemoteContent)

  useEffect(() => {
    if (!noteId || noteId === 'new') {
      const newNote: Note = {
        id: crypto.randomUUID(),
        type: 'project',
        title: 'Untitled Note',
        content: '# Untitled Note\n\n',
        filePath: 'Notes/Untitled.md',
        tags: [],
        mentions: [],
        backlinks: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      setNote(newNote)
      setActiveNote(newNote)
      upsertNote(newNote).then(s => markSelfWrite(s.content, s.updatedAt)).catch(console.error)
      return
    }
    getNoteById(noteId).then(n => {
      if (n) {
        setNote(n)
        setActiveNote(n)
        markSelfWrite(n.content, n.updatedAt)  // baseline
      }
    })
  }, [noteId])

  const handleChange = useCallback((content: string) => {
    if (!note) return
    const tags = extractTags(content)
    const mentions = extractMentions(content)
    const backlinks = extractBacklinks(content)
    const updated = { ...note, content, tags, mentions, backlinks }
    setNote(updated)
    setActiveNote(updated)
    updateNote(note.id, { content, tags, mentions, backlinks })
  }, [note, setActiveNote, updateNote])

  const handleChangeRef = useRef(handleChange)
  handleChangeRef.current = handleChange

  const handleRestore = useCallback((revision: NoteRevision) => {
    handleChangeRef.current(revision.content)
    setShowHistory(false)
  }, [])

  const saveNote = useCallback(async (n: Note) => {
    const saved = await save(n)
    // 저장/충돌해결 결과의 updatedAt을 로컬에도 반영 — 안 그러면 다음 저장이
    // 매번 옛 baseline과 비교돼 매번 "충돌"로 오판한다. 그 사이 다른 노트로
    // 넘어갔다면(noteRef가 이미 다른 노트) 여기 적용하지 않음.
    if (noteRef.current?.id === n.id) {
      setNote(prev => {
        if (!prev || prev.id !== n.id) return prev
        // 저장이 서버를 왕복하는 동안 사용자가 계속 타이핑했다면 prev.content는
        // 이미 n.content(저장 시점 스냅샷)보다 최신이다. saved.content로 되돌리면
        // NoteEditor가 전체 교체 diff를 적용해 커서가 맨 위로 튕긴다 —
        // updatedAt(충돌 판정 baseline)만 갱신하고 content는 건드리지 않는다.
        if (prev.content !== n.content) {
          return { ...prev, updatedAt: saved.updatedAt }
        }
        return { ...prev, content: saved.content, tags: saved.tags, mentions: saved.mentions, backlinks: saved.backlinks, updatedAt: saved.updatedAt }
      })
    }
  }, [save])

  // 언마운트 시 즉시 저장
  useEffect(() => {
    return () => {
      if (noteRef.current) {
        saveNote(noteRef.current).catch(console.error)
      }
    }
  }, [saveNote]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save every 2s
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => {
      saveNote(note).catch(console.error)
    }, 2000)
    return () => clearTimeout(timer)
  }, [note?.content, saveNote])

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div data-tauri-drag-region className="electron-drag px-12 py-3 border-b border-[var(--border)] flex-shrink-0 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{note.title}</h1>
        <div className="flex items-center gap-2">
          {typingAuthor && (
            <span className="text-xs text-[var(--accent)] flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
              {typingAuthor} 작성 중…
            </span>
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
      <div className="flex-1 overflow-hidden">
        <NoteEditor
          content={note.content}
          onChange={handleChange}
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
