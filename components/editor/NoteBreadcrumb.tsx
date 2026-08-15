'use client'

/**
 * 노트 상단의 위치 표시 — Finder 경로처럼 "Areas › 보러 갈 전시 목록".
 *
 * 제목만 보여주면 이 노트가 어디 들어있는지 알 수 없어서, 확인하려면 사이드바를
 * 뒤져야 했다.
 *
 * 폴더 세그먼트를 누르면 그 폴더(+하위)의 노트 목록이 메인 영역에 뜬다(/search).
 * 예전엔 클릭을 막아뒀는데, 사이드바 펼침이 폴더 id(uuid) 기준이라 path만으로는
 * 정확히 펼칠 수 없어서였다. 이제 사이드바를 건드릴 필요 없이 결과 페이지로 간다.
 */
import { useRouter } from 'next/navigation'

export default function NoteBreadcrumb({
  title,
  folder,
  fallback = '미분류',
}: {
  title: string
  /** 'Areas' 또는 'Archive/2025/등대' 같은 경로 */
  folder?: string
  /** 캘린더 노트처럼 폴더가 없는 경우의 라벨 */
  fallback?: string
}) {
  const router = useRouter()
  const segments = folder ? folder.split('/').filter(Boolean) : []

  return (
    <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-baseline gap-1.5 min-w-0">
      {segments.length === 0 && (
        <span className="flex items-baseline gap-1.5 min-w-0 flex-shrink-0">
          <span className="text-sm font-normal text-[var(--text-muted)] truncate max-w-[150px]">
            {fallback}
          </span>
          <span aria-hidden className="text-sm text-[var(--text-muted)] opacity-50">›</span>
        </span>
      )}
      {segments.map((seg, i) => {
        const path = segments.slice(0, i + 1).join('/')
        return (
          <span key={i} className="flex items-baseline gap-1.5 min-w-0 flex-shrink-0">
            <button
              onClick={() => router.push(`/search?folder=${encodeURIComponent(path)}`)}
              title={`${path} 폴더의 노트 보기`}
              className="text-sm font-normal text-[var(--text-muted)] truncate max-w-[150px]
                         hover:text-[var(--accent)] hover:underline transition-colors"
            >
              {seg}
            </button>
            <span aria-hidden className="text-sm text-[var(--text-muted)] opacity-50">›</span>
          </span>
        )
      })}
      <span className="truncate">{title}</span>
    </h1>
  )
}
