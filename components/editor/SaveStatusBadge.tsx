'use client'
import type { SaveStatus } from '@/lib/hooks/useNoteDocument'

/**
 * 저장 상태 표시 — '저장 중…' / '저장됨' / '저장 안 됨(다시 시도 중)'.
 * 예전엔 저장 실패가 콘솔에만 남거나(주간·월간) 'Saving...' 이 깜빡일 뿐이라,
 * 오프라인에서 쓴 내용이 서버에 안 갔다는 걸 알 길이 없었다.
 */
export default function SaveStatusBadge({
  status, error, typingAuthor,
}: { status: SaveStatus; error: string | null; typingAuthor?: string | null }) {
  return (
    <div className="flex items-center gap-2 text-xs select-none" aria-live="polite">
      {typingAuthor && (
        <span className="flex items-center gap-1 text-[var(--accent)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          {typingAuthor} 작성 중…
        </span>
      )}
      {status === 'error' ? (
        <span className="flex items-center gap-1 text-amber-400 max-w-[260px] truncate" title={error ?? undefined}>
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          {error ?? '저장 안 됨 — 다시 시도 중'}
        </span>
      ) : status === 'saving' || status === 'dirty' ? (
        <span className="text-[var(--text-muted)]">저장 중…</span>
      ) : status === 'saved' ? (
        <span className="text-[var(--text-muted)] opacity-70">저장됨</span>
      ) : null}
    </div>
  )
}

/** 노트 위에 잠깐 띄우는 안내 (충돌을 합쳤다 등) */
export function NoticeBar({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div role="status" className="mx-5 md:mx-12 mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-[var(--text-secondary)]">
      <span className="flex-1 leading-relaxed">{text}</span>
      <button onClick={onClose} className="opacity-70 hover:opacity-100" aria-label="닫기">×</button>
    </div>
  )
}
