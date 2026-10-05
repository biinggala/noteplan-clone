'use client'
import { useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useUIStore } from '@/lib/stores/uiStore'

interface MobileLayoutProps {
  left: React.ReactNode    // LeftSidebar (노트/태그 내비)
  center: React.ReactNode  // 메인 에디터/뷰
  right: React.ReactNode   // MiniCalendar + Timeline
}


// 모바일 셸: 상단 앱바 + 풀스크린 콘텐츠 + 좌/우 슬라이드 드로어.
// (하단 탭바 없음 — 실제 NotePlan 방식. 좌=내비, 우=캘린더/타임라인)
export default function MobileLayout({ left, center, right }: MobileLayoutProps) {
  const { mobileDrawer: drawer, setMobileDrawer: setDrawer } = useUIStore()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // 라우트 변경(노트 열기 등) 시 드로어 자동 닫기
  useEffect(() => { setDrawer(null) }, [pathname, searchParams])

  // 드로어 열렸을 때 본문 스크롤 잠금
  useEffect(() => {
    document.body.style.overflow = drawer ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [drawer])

  return (
    <div className="flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]"
      style={{ height: '100dvh' }}>
      {/* 상단 줄은 각 페이지의 PageHeader 가 맡는다 (메뉴·검색·캘린더 버튼 포함).
          예전엔 앱바 + 페이지 머리줄이 두 줄로 쌓여 화면 위쪽 100px 이상을 차지했다. */}
      <div className="flex-shrink-0" style={{ height: 'env(safe-area-inset-top)' }} />

      {/* 메인 콘텐츠 */}
      <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {center}
      </main>

      {/* 드로어 + 백드롭 */}
      <AnimatePresence>
        {drawer && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/50"
              onClick={() => setDrawer(null)}
            />
            <motion.aside
              key="drawer"
              initial={{ x: drawer === 'left' ? '-100%' : '100%' }}
              animate={{ x: 0 }}
              exit={{ x: drawer === 'left' ? '-100%' : '100%' }}
              transition={{ type: 'tween', duration: 0.25, ease: 'easeOut' }}
              // 불투명 배경 — 예전엔 반투명(sidebar-glass)이라 뒤의 본문 글자가 비쳐 읽기 어려웠다
              className={`fixed top-0 bottom-0 z-50 w-[86%] max-w-[360px] overflow-y-auto overscroll-contain
                bg-[var(--bg-primary)] shadow-2xl
                ${drawer === 'left' ? 'left-0 border-r' : 'right-0 border-l'} border-[var(--border)]`}
              style={{
                // 상태바/Dynamic Island 가림 방지 (하단은 풋터가 채우므로 패딩 X)
                paddingTop: 'env(safe-area-inset-top)',
              }}
            >
              {drawer === 'left' ? left : right}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
