'use client'
import { useEffect, useState } from 'react'

/**
 * Returns true on narrow (phone-sized) viewports.
 * Starts `null` until mounted so SSR/first paint can avoid committing to a
 * layout — callers should treat `null` as "unknown / not yet measured".
 */
export function useIsMobile(breakpoint = 768): boolean | null {
  const [isMobile, setIsMobile] = useState<boolean | null>(null)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [breakpoint])

  return isMobile
}
