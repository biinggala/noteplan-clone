'use client'
import { useEffect, useState } from 'react'
import type { SaveStatus } from '@/lib/hooks/useNoteDocument'

/**
 * 저장 상태 — 제목 옆의 작은 표시.
 *  · 저장 중: 점 하나가 깜빡임 (글자로 '저장 중…'을 띄웠다 지웠다 하면 눈에 걸린다)
 *  · 저장됨: 체크가 잠깐 보였다가 사라짐
 *  · 실패/오프라인: 주황색 문구 (이건 계속 보여야 한다)
 * 예전엔 오른쪽 버튼 줄에 'Saving...' 글자가 끼어들어 버튼 위치가 흔들렸다.
 */
export default function SaveStatusBadge({
  status, error, typingAuthor,
}: { status: SaveStatus; error: string | null; typingAuthor?: string | null }) {
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (status !== 'saved') { setShowSaved(false); return }
    setShowSaved(true)
    const t = setTimeout(() => setShowSaved(false), 1500)
    return () => clearTimeout(t)
  }, [status])

  return (
    <span className="inline-flex items-center gap-2 text-[11px] select-none" aria-live="polite">
      {typingAuthor && (
        <span className="flex items-center gap-1 text-[var(--accent)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          {typingAuthor} 작성 중
        </span>
      )}
      {status === 'error' ? (
        <span className="flex items-center gap-1 text-amber-500 max-w-[240px] truncate" title={error ?? undefined}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden><path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
          {error ?? '저장 안 됨 — 다시 시도 중'}
        </span>
      ) : status === 'saving' || status === 'dirty' ? (
        <span title="저장 중" aria-label="저장 중" className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)] animate-pulse" />
      ) : (
        <span
          title="저장됨" aria-label={showSaved ? '저장됨' : undefined}
          className={`flex items-center text-[var(--text-muted)] transition-opacity duration-500 ${showSaved ? 'opacity-70' : 'opacity-0'}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </span>
      )}
    </span>
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
