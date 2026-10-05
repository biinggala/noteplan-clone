'use client'
import { useEffect, useRef } from 'react'
import { useUIStore } from '@/lib/stores/uiStore'
import { useIsMobile } from '@/lib/hooks/useIsMobile'

/**
 * 가운데 영역 머리줄 (2.0).
 *
 * 예전 머리줄은 'Monday / October 5, 2026' 을 크게 띄우고, 바로 아래 노트 본문이
 * 또 '# October 5, 2026' 으로 시작해 같은 날짜가 두 번 보였다. 이제 큰 제목은
 * 본문의 첫 줄에 맡기고, 머리줄은 위치(무슨 날·주·달인지)와 이동·상태만 담는
 * 얇은 줄이다. 맥 앱의 신호등 버튼 줄과 높이(52px)를 맞춰 창 위쪽이 한 줄로 이어진다.
 */
export interface PageNav {
  onPrev: () => void
  onNext: () => void
  onToday?: () => void
  /** 지금 보고 있는 게 오늘/이번 주/이번 달이면 '오늘' 버튼을 감춘다 */
  isCurrent?: boolean
  prevLabel: string
  nextLabel: string
  todayLabel?: string
}

export default function PageHeader({
  kicker, title, subtitle, nav, actions, children,
}: {
  /** 제목 앞의 작은 표식 (예: 'CW 41', '오늘') */
  kicker?: React.ReactNode
  title?: React.ReactNode
  subtitle?: React.ReactNode
  nav?: PageNav
  actions?: React.ReactNode
  /** title 대신 임의의 내용 (예: 노트 경로) */
  children?: React.ReactNode
}) {
  const { leftSidebarVisible, rightSidebarVisible, toggleLeftSidebar, toggleRightSidebar, setMobileDrawer, setCommandBarOpen } = useUIStore()
  const isMobile = useIsMobile()

  // ⌥⌘← / ⌥⌘→ 이전·다음, ⌥⌘T 오늘 (에디터 안에서도 동작)
  const navRef = useRef(nav)
  useEffect(() => { navRef.current = nav })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = navRef.current
      if (!n || !(e.metaKey || e.ctrlKey) || !e.altKey) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); n.onPrev() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); n.onNext() }
      else if (e.code === 'KeyT' && n.onToday) { e.preventDefault(); n.onToday() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header
      data-tauri-drag-region
      className="electron-drag flex items-center gap-2 px-3 md:px-4 border-b border-[var(--border)] flex-shrink-0 select-none"
      style={{ height: 'var(--header-h)' }}
    >
      {isMobile && (
        <IconButton label="메뉴" onClick={() => setMobileDrawer('left')} className="h-9 w-9 -ml-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </IconButton>
      )}
      {!isMobile && !leftSidebarVisible && (
        <IconButton label="사이드바 열기 (⌘\)" onClick={toggleLeftSidebar}><SidebarIcon side="left" /></IconButton>
      )}

      {nav && (
        <div className="flex items-center gap-0.5 titlebar-no-drag">
          <IconButton label={nav.prevLabel} onClick={nav.onPrev}><Chevron dir="left" /></IconButton>
          <IconButton label={nav.nextLabel} onClick={nav.onNext}><Chevron dir="right" /></IconButton>
        </div>
      )}

      <div className="min-w-0 flex-1 flex items-baseline gap-2 pl-1">
        {children ?? (
          <>
            {kicker && (
              <span className="text-[11px] font-semibold tracking-wide uppercase text-[var(--accent)] flex-shrink-0">
                {kicker}
              </span>
            )}
            {title && <h1 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">{title}</h1>}
            {subtitle && <span className="text-[13px] text-[var(--text-muted)] truncate tabular hidden sm:inline">{subtitle}</span>}
          </>
        )}
      </div>

      <div className="flex items-center gap-1 titlebar-no-drag">
        {nav?.onToday && !nav.isCurrent && (
          <button
            onClick={nav.onToday}
            className="h-7 px-2.5 rounded-md text-xs font-medium text-[var(--text-secondary)]
              border border-[var(--border)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-primary)] transition-colors"
          >
            {nav.todayLabel ?? '오늘'}
          </button>
        )}
        {actions}
        {isMobile && (
          <>
            <IconButton label="검색" onClick={() => setCommandBarOpen(true)} className="h-9 w-9">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
              </svg>
            </IconButton>
            <IconButton label="캘린더" onClick={() => setMobileDrawer('right')} className="h-9 w-9 -mr-1">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M16 3v4M8 3v4M3 10h18" />
              </svg>
            </IconButton>
          </>
        )}
        {!isMobile && (
          <IconButton
            label={rightSidebarVisible ? '캘린더 닫기 (⌘⇧\\)' : '캘린더 열기 (⌘⇧\\)'}
            onClick={toggleRightSidebar}
            active={rightSidebarVisible}
          >
            <SidebarIcon side="right" />
          </IconButton>
        )}
      </div>
    </header>
  )
}

export function IconButton({
  label, onClick, children, active, className = '',
}: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors
        ${active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}
        hover:bg-[var(--hover-bg)] hover:text-[var(--text-primary)] ${className}`}
    >
      {children}
    </button>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  )
}

export function SidebarIcon({ side }: { side: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d={side === 'left' ? 'M9 4v16' : 'M15 4v16'} />
    </svg>
  )
}
