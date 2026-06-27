'use client'
import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useUIStore } from '@/lib/stores/uiStore'

interface MobileLayoutProps {
  left: React.ReactNode    // LeftSidebar (노트/태그 내비)
  center: React.ReactNode  // 메인 에디터/뷰
  right: React.ReactNode   // MiniCalendar + Timeline
}

type Drawer = 'left' | 'right' | null

// 모바일 셸: 상단 앱바 + 풀스크린 콘텐츠 + 좌/우 슬라이드 드로어.
// (하단 탭바 없음 — 실제 NotePlan 방식. 좌=내비, 우=캘린더/타임라인)
export default function MobileLayout({ left, center, right }: MobileLayoutProps) {
  const [drawer, setDrawer] = useState<Drawer>(null)
  const { setCommandBarOpen } = useUIStore()
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
      {/* 상단 앱바 */}
      <header
        className="flex-shrink-0 flex items-center gap-2 px-2 border-b border-[var(--border)]"
        style={{ height: 'calc(52px + env(safe-area-inset-top))', paddingTop: 'env(safe-area-inset-top)' }}
      >
        <button
          onClick={() => setDrawer('left')}
          aria-label="메뉴 열기"
          className="p-2 rounded-md text-[var(--text-secondary)] hover:bg-white/5 active:bg-white/10"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <span className="flex-1 text-sm font-semibold text-[var(--text-muted)] select-none">NotePlan</span>

        <button
          onClick={() => setCommandBarOpen(true)}
          aria-label="검색"
          className="p-2 rounded-md text-[var(--text-secondary)] hover:bg-white/5 active:bg-white/10"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
        <button
          onClick={() => setDrawer('right')}
          aria-label="캘린더 열기"
          className="p-2 rounded-md text-[var(--text-secondary)] hover:bg-white/5 active:bg-white/10"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </button>
      </header>

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
              className={`fixed top-0 bottom-0 z-50 w-[84%] max-w-[340px] overflow-y-auto
                bg-[var(--bg-primary)] sidebar-glass
                ${drawer === 'left' ? 'left-0 border-r' : 'right-0 border-l'} border-[var(--border)]`}
            >
              {drawer === 'left' ? left : right}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
