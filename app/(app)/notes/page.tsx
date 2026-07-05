'use client'
import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { useNoteStore } from '@/lib/stores/noteStore'
import { getNoteById, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks } from '@/lib/parser/noteParser'
import { useNoteRealtime } from '@/lib/hooks/useNoteRealtime'
import type { Note } from '@/types/note'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })

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
  const noteRef = useRef<Note | null>(null)
  noteRef.current = note

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

  const { typingAuthor, markSelfWrite } = useNoteRealtime(note?.id, handleRemoteContent)

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

  // 언마운트 시 즉시 저장
  useEffect(() => {
    return () => {
      if (noteRef.current) {
        upsertNote(noteRef.current).then(s => markSelfWrite(s.content, s.updatedAt)).catch(console.error)
      }
    }
  }, [markSelfWrite]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save every 2s
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => {
      upsertNote(note).then(s => markSelfWrite(s.content, s.updatedAt)).catch(console.error)
    }, 2000)
    return () => clearTimeout(timer)
  }, [note?.content, markSelfWrite])

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
        {typingAuthor && (
          <span className="text-xs text-[var(--accent)] flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
            {typingAuthor} 작성 중…
          </span>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        <NoteEditor
          content={note.content}
          onChange={handleChange}
        />
      </div>
    </div>
  )
}
