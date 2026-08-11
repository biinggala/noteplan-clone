'use client'

/**
 * 노트 상단의 위치 표시 — Finder 경로처럼 "Areas › 보러 갈 전시 목록".
 *
 * 제목만 보여주면 이 노트가 어디 들어있는지 알 수 없어서, 확인하려면 사이드바를
 * 뒤져야 했다.
 *
 * 폴더 부분은 클릭 대상이 아니다. 사이드바의 펼침 상태는 폴더 path가 아니라
 * id(uuid)로 관리돼서, 여기서 path만 가지고는 정확히 펼칠 수 없다. 눌리는데
 * 엉뚱한 데로 가느니 표시만 하는 게 낫다.
 */
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
  const segments = folder ? folder.split('/').filter(Boolean) : [fallback]

  return (
    <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-baseline gap-1.5 min-w-0">
      {segments.map((seg, i) => (
        <span key={i} className="flex items-baseline gap-1.5 min-w-0 flex-shrink-0">
          <span
            className="text-sm font-normal text-[var(--text-muted)] truncate max-w-[150px]"
            title={segments.slice(0, i + 1).join('/')}
          >
            {seg}
          </span>
          <span aria-hidden className="text-sm text-[var(--text-muted)] opacity-50">›</span>
        </span>
      ))}
      <span className="truncate">{title}</span>
    </h1>
  )
}
