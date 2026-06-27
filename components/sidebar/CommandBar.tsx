'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useUIStore } from '@/lib/stores/uiStore'
import { searchNotes, getAllNotes } from '@/lib/db/noteRepository'
import { format, addDays, subDays, parseISO, isValid } from 'date-fns'
import type { Note } from '@/types/note'

function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// 검색어가 포함된 첫 라인을 발췌 (실제 NotePlan: 매칭된 문단 표시)
function snippetFor(note: Note, query: string): string {
  const q = query.toLowerCase()
  for (const raw of (note.content ?? '').split('\n')) {
    const line = raw.trim()
    if (line && line.toLowerCase().includes(q)) return line
  }
  return ''
}

// 발췌 안의 검색어 강조
function highlightQuery(text: string, query: string): React.ReactNode[] {
  if (!query) return [text]
  const re = new RegExp(`(${escapeRegExp(query)})`, 'gi')
  const parts: React.ReactNode[] = []
  let last = 0, m: RegExpExecArray | null, i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<span key={i++} className="text-blue-400 font-medium">{m[0]}</span>)
    last = m.index + m[0].length
    if (re.lastIndex === m.index) re.lastIndex++  // 빈 매칭 방지
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length ? parts : [text]
}

function parseNaturalDate(input: string): string | null {
  const lower = input.toLowerCase().trim()
  const today = new Date()

  if (lower === 'today') return format(today, 'yyyy-MM-dd')
  if (lower === 'tomorrow') return format(addDays(today, 1), 'yyyy-MM-dd')
  if (lower === 'yesterday') return format(subDays(today, 1), 'yyyy-MM-dd')

  // YYYY-MM-DD 직접 입력
  const dateMatch = lower.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateMatch) {
    const d = parseISO(dateMatch[1])
    if (isValid(d)) return dateMatch[1]
  }

  return null
}

export default function CommandBar() {
  const router = useRouter()
  const { commandBarOpen, setCommandBarOpen } = useUIStore()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Note[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (commandBarOpen) {
      setQuery('')
      setSelectedIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
      getAllNotes().then(notes => setResults(notes.slice(0, 8)))
    }
  }, [commandBarOpen])

  useEffect(() => {
    if (!query) {
      getAllNotes().then(notes => setResults(notes.slice(0, 8)))
      return
    }
    const naturalDate = parseNaturalDate(query)
    if (naturalDate) {
      setResults([{
        id: `date-${naturalDate}`,
        type: 'daily',
        title: `Go to ${naturalDate}`,
        content: '',
        date: naturalDate,
        filePath: '',
        tags: [],
        mentions: [],
        backlinks: [],
        createdAt: 0,
        updatedAt: 0,
      }])
      return
    }
    searchNotes(query).then(notes => setResults(notes.slice(0, 8)))
  }, [query])

  const handleSelect = (note: Note) => {
    if (note.type === 'daily' && note.date) {
      router.push(`/daily?date=${note.date}`)
    } else {
      router.push(`/notes?id=${note.id}`)
    }
    setCommandBarOpen(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        setCommandBarOpen(!commandBarOpen)
      }
      if (e.key === 'Escape') setCommandBarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commandBarOpen, setCommandBarOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIdx]) {
      handleSelect(results[selectedIdx])
    }
  }

  return (
    <AnimatePresence>
      {commandBarOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
            onClick={() => setCommandBarOpen(false)}
          />

          {/* Command Bar */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="fixed top-[20%] left-1/2 -translate-x-1/2 w-[560px] max-w-[90vw]
              bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl z-50
              overflow-hidden"
          >
            {/* Input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
              <svg className="w-5 h-5 text-[var(--text-muted)] flex-shrink-0"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }}
                onKeyDown={handleKeyDown}
                placeholder='Search notes or type a date ("today", "2026-03-06")...'
                className="flex-1 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)]
                  text-sm outline-none"
              />
              <kbd className="text-xs text-[var(--text-muted)] bg-white/10 px-2 py-0.5 rounded">ESC</kbd>
            </div>

            {/* Results */}
            <div className="max-h-[360px] overflow-y-auto py-1">
              {results.map((note, idx) => {
                const snippet = query ? snippetFor(note, query) : ''
                return (
                  <button
                    key={note.id}
                    onClick={() => handleSelect(note)}
                    className={`flex items-start gap-3 w-full px-4 py-2.5 text-sm text-left transition-colors
                      ${idx === selectedIdx
                        ? 'bg-blue-500/20 text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-white/5'
                      }`}
                  >
                    <span className="flex-shrink-0 text-[var(--text-muted)] mt-0.5">
                      {note.type === 'daily' ? '📅' : '📄'}
                    </span>
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="truncate">{note.title}</span>
                      {snippet && (
                        <span className="text-xs text-[var(--text-muted)] line-clamp-2 leading-snug">
                          {highlightQuery(snippet, query)}
                        </span>
                      )}
                    </span>
                    {note.date && (
                      <span className="flex-shrink-0 text-xs text-[var(--text-muted)] mt-0.5">{note.date}</span>
                    )}
                  </button>
                )
              })}
              {results.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                  No results found
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex gap-4 px-4 py-2 border-t border-[var(--border)] text-xs text-[var(--text-muted)]">
              <span>↑↓ Navigate</span>
              <span>↵ Open</span>
              <span>ESC Close</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
