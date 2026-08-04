'use client'
import { useEffect, useState } from 'react'
import { getSupersededBy } from '@/lib/db/noteRepository'
import type { Note } from '@/types/note'

/**
 * "이 노트는 [[X]]로 대체되었습니다" 배너.
 *
 * 노트의 시효성을 눈에 보이게 만드는 장치. 옛 노트를 열었을 때 그게 이미
 * 갈아치워졌다는 걸 모르면, 지난 판단을 현재 근거로 쓰게 된다.
 */
export default function SupersededBanner({
  title,
  onOpen,
}: {
  title?: string
  /** 대체한 노트로 이동 */
  onOpen: (title: string) => void
}) {
  const [by, setBy] = useState<Note[]>([])

  useEffect(() => {
    if (!title) { setBy([]); return }
    let alive = true
    getSupersededBy(title)
      .then(rows => { if (alive) setBy(rows) })
      .catch(console.error)
    return () => { alive = false }
  }, [title])

  if (!by.length) return null

  return (
    <div className="mx-auto max-w-[780px] px-6 pt-3">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2
        text-[12px] text-amber-200 flex items-start gap-2">
        <span aria-hidden className="mt-[1px]">⚠</span>
        <div className="min-w-0">
          <span className="opacity-80">이 노트는 대체되었습니다 → </span>
          {by.map((n, i) => (
            <span key={n.id}>
              {i > 0 && <span className="opacity-50">, </span>}
              <button
                onClick={() => onOpen(n.title)}
                className="underline underline-offset-2 font-medium hover:text-amber-100"
              >
                {n.title}
              </button>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
