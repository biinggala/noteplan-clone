'use client'
import { useEffect, useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { getNoteRevisions, type NoteRevision } from '@/lib/db/noteRepository'

interface NoteHistoryPanelProps {
  noteId: string
  onRestore: (revision: NoteRevision) => void
  onClose: () => void
}

function snippet(content: string): string {
  const line = content.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? content.split('\n')[0] ?? ''
  return line.length > 80 ? line.slice(0, 80) + '…' : line
}

export default function NoteHistoryPanel({ noteId, onRestore, onClose }: NoteHistoryPanelProps) {
  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null)
  const [selected, setSelected] = useState<NoteRevision | null>(null)

  useEffect(() => {
    getNoteRevisions(noteId).then(setRevisions)
  }, [noteId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[720px] max-w-[90vw] h-[70vh] max-h-[640px] bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl shadow-2xl flex overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 리비전 목록 */}
        <div className="w-64 flex-shrink-0 border-r border-[var(--border)] overflow-y-auto">
          <div className="px-3 py-2.5 border-b border-[var(--border)] text-sm font-semibold text-[var(--text-primary)]">
            이전 버전
          </div>
          {revisions === null && (
            <div className="px-3 py-4 text-xs text-[var(--text-muted)]">불러오는 중...</div>
          )}
          {revisions?.length === 0 && (
            <div className="px-3 py-4 text-xs text-[var(--text-muted)]">저장된 이전 버전이 없습니다.</div>
          )}
          {revisions?.map(rev => (
            <button
              key={rev.id}
              onClick={() => setSelected(rev)}
              className={`w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-white/5 transition-colors ${selected?.id === rev.id ? 'bg-white/10' : ''}`}
            >
              <div className="text-xs text-[var(--text-primary)]">
                {format(rev.revisedAt, 'M/d HH:mm')}
                <span className="text-[var(--text-muted)] ml-1.5">
                  ({formatDistanceToNow(rev.revisedAt, { addSuffix: true })})
                </span>
              </div>
              <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">{snippet(rev.content)}</div>
            </button>
          ))}
        </div>

        {/* 미리보기 */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
            <div className="text-sm text-[var(--text-primary)]">
              {selected ? format(selected.revisedAt, 'yyyy-MM-dd HH:mm:ss') + ' 시점' : '버전을 선택하세요'}
            </div>
            <div className="flex items-center gap-2">
              {selected && (
                <button
                  onClick={() => onRestore(selected)}
                  className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-white hover:opacity-90"
                >
                  이 버전으로 복원
                </button>
              )}
              <button onClick={onClose} className="text-xs px-2 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                닫기
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {selected ? (
              <pre className="whitespace-pre-wrap text-sm text-[var(--text-primary)] font-mono leading-relaxed">{selected.content}</pre>
            ) : (
              <div className="text-sm text-[var(--text-muted)]">왼쪽에서 시점을 선택하면 그때의 내용을 볼 수 있습니다.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
