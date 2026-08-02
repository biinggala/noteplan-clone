'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBacklinks } from '@/lib/db/noteRepository'
import { routeForNote } from '@/lib/hooks/useWikiLink'
import type { Note } from '@/types/note'

interface BacklinksPanelProps {
  /** 이 노트의 제목 — 이걸 [[링크]]한 노트들을 찾는다 */
  title: string
  /** 자기 자신 제외용 */
  noteId: string
}

interface Ref { note: Note; lines: string[] }

/** 노트 표시용 이름 (데일리는 날짜, 그 외 제목) */
function refLabel(n: Note): string {
  if (n.type === 'daily' && n.date) return n.date
  if (n.type === 'weekly' && n.date) return n.date
  return n.title
}

/** [[title]]이 포함된 라인만 발췌 */
function excerpt(content: string, title: string): string[] {
  const needle = `[[${title}]]`.toLowerCase()
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l.toLowerCase().includes(needle))
    .slice(0, 3)
}

/** 발췌 라인에서 [[링크]]와 헤딩 마커를 읽기 좋게 다듬어 렌더 */
function renderLine(line: string, title: string) {
  const h = line.match(/^(#{1,6})\s+(.*)$/)
  const text = h ? h[2] : line
  const parts = text.split(/(\[\[[^\]]+\]\])/g)
  return (
    <span className={h ? 'font-semibold' : ''}>
      {parts.map((p, i) =>
        /^\[\[[^\]]+\]\]$/.test(p)
          ? <span key={i} style={{ color: 'var(--accent)' }}>{p.slice(2, -2)}</span>
          : <span key={i}>{p}</span>
      )}
    </span>
  )
}

export default function BacklinksPanel({ title, noteId }: BacklinksPanelProps) {
  const router = useRouter()
  const [refs, setRefs] = useState<Ref[] | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!title) { setRefs([]); return }
    getBacklinks(title)
      .then(notes => {
        if (cancelled) return
        setRefs(notes
          .filter(n => n.id !== noteId)
          .map(n => ({ note: n, lines: excerpt(n.content, title) }))
          .filter(r => r.lines.length > 0))
      })
      .catch(err => { console.error('[backlinks]', err); if (!cancelled) setRefs([]) })
    return () => { cancelled = true }
  }, [title, noteId])

  // 참조가 없으면 화면을 어지럽히지 않도록 숨김
  if (!refs || refs.length === 0) return null

  const total = refs.reduce((n, r) => n + r.lines.length, 0)

  return (
    <div
      className="mx-12 mb-4 rounded-lg border border-[var(--border)] overflow-hidden flex-shrink-0"
      style={{ backgroundColor: 'var(--bg-tertiary)' }}
    >
      <button
        onClick={() => setCollapsed(v => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold
                   text-[var(--text-muted)] hover:text-[var(--text-primary)]
                   hover:bg-[var(--hover-bg)] transition-colors"
      >
        <span className={`inline-block transition-transform ${collapsed ? '-rotate-90' : ''}`}>⌄</span>
        이 노트를 참조한 곳
        <span className="font-normal">({total})</span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-2.5 space-y-2">
          {refs.map(({ note, lines }) => (
            <div key={note.id}>
              <button
                onClick={() => router.push(routeForNote(note))}
                className="text-sm font-semibold hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                {refLabel(note)}
              </button>
              <div className="pl-3 mt-0.5 space-y-0.5 border-l-2 border-[var(--border)]">
                {lines.map((l, i) => (
                  <div key={i} className="text-sm text-[var(--text-secondary)] break-words">
                    {renderLine(l, title)}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
