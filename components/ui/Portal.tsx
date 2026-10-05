'use client'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 창 전체를 덮는 대화상자·메뉴는 document.body 에 그린다.
 *
 * 사이드바는 반투명 유리 효과(backdrop-filter)를 쓰는데, 그런 조상 안에서는
 * position:fixed 가 화면이 아니라 그 조상을 기준으로 잡힌다. 그래서 사이드바에서
 * 연 '새 노트' 창이 화면 가운데가 아니라 좁은 사이드바 안에 끼어 들어갔다.
 */
export default function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted ? createPortal(children, document.body) : null
}
