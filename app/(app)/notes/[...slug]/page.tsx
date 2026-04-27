'use client'
import { use, useEffect, useRef, useState, useCallback } from 'react'
import { useNoteStore } from '@/lib/stores/noteStore'
import { getNoteById, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks } from '@/lib/parser/noteParser'
import type { Note } from '@/types/note'
import dynamic from 'next/dynamic'

const NoteEditor = dynamic(() => import('@/components/editor/NoteEditor'), { ssr: false })

interface Props {
  params: Promise<{ slug: string[] }>
}

export default function NotePage({ params }: Props) {
  const { slug } = use(params)
  const noteId = slug[0]
  const { setActiveNote, updateNote } = useNoteStore()
  const [note, setNote] = useState<Note | null>(null)
  const noteRef = useRef<Note | null>(null)
  noteRef.current = note

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
      upsertNote(newNote)
      return
    }
    getNoteById(noteId).then(n => {
      if (n) {
        setNote(n)
        setActiveNote(n)
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
        upsertNote(noteRef.current).catch(console.error)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save every 2s
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => upsertNote(note).catch(console.error), 2000)
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
      <div className="px-12 py-3 border-b border-[var(--border)] flex-shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">{note.title}</h1>
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
