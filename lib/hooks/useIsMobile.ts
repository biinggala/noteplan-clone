'use client'
import { useEffect, useState } from 'react'

// 화면 폭으로 모바일 판별 (기본 768px 미만). SSR/초기 렌더는 false → 마운트 후 갱신.
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [breakpoint])
  return isMobile
}
