'use client'
import { Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ThreePanelLayout from '@/components/layout/ThreePanelLayout'
import MobileLayout from '@/components/layout/MobileLayout'
import LeftSidebar from '@/components/sidebar/LeftSidebar'
import RightSidebar from '@/components/sidebar/RightSidebar'
import CommandBar from '@/components/sidebar/CommandBar'
import ThemeProvider from '@/components/ThemeProvider'
import { createClient } from '@/lib/supabase/client'
import { useAuthStore } from '@/lib/stores/authStore'
import { useEventNotifications } from '@/lib/notifications/useEventNotifications'
import { refreshGoogleTokenNow, refreshGoogleTokenIfStale } from '@/lib/google/withToken'
import { useIsMobile } from '@/lib/hooks/useIsMobile'
import { useUIStore } from '@/lib/stores/uiStore'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { session, loading, setSession, setLoading, googleRefreshToken, googleTokenOnServer } = useAuthStore()
  const supabase = createClient()
  const isMobile = useIsMobile()
  useEventNotifications()  // 캘린더 이벤트 10분 전 알림

  useEffect(() => {
    // 초기 세션 로드
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    // 세션 변경 감지 (로그인/로그아웃)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  // ── Google access token 자동 갱신 (시작 시 + 50분마다 + 앱이 다시 앞으로 올 때) ──
  // access token은 ~1시간 만료 → refresh token으로 갱신해 재인증 없이 유지.
  // 맥이 잠들어 있던 동안엔 interval 이 돌지 않아, 깨어난 직후엔 만료된 토큰으로
  // 일정 추가가 실패했다 → 포커스/화면 복귀 때 오래된 토큰이면 바로 갱신.
  const canRefresh = !!googleRefreshToken || googleTokenOnServer
  useEffect(() => {
    if (!session) return
    if (!canRefresh) {
      // 새 기기·재로그인: 캘린더 토큰이 서버에 보관돼 있으면 다시 연결 없이 이어 쓴다
      if (!useAuthStore.getState().googleAccessToken) void refreshGoogleTokenNow({ silent: true })
      return
    }
    void refreshGoogleTokenNow()  // 시작 시 즉시 (만료된 토큰 교체)
    const id = setInterval(() => { void refreshGoogleTokenNow() }, 50 * 60 * 1000)
    const onWake = () => {
      if (document.visibilityState === 'visible') refreshGoogleTokenIfStale(40 * 60 * 1000)
    }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [canRefresh, !!session])

  // ── ⌘\ 왼쪽 사이드바, ⌘⇧\ 오른쪽(캘린더) 패널 ─────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘⌥⇧L — 마지막 줄 드래그 기록 (타임라인 드롭이 안 될 때 원인 확인용)
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && e.code === 'KeyL') {
        e.preventDefault()
        void import('@/lib/dnd/pointerLineDrag').then(m => m.showDragLog())
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyN') {
        e.preventDefault()
        window.dispatchEvent(new Event('np:new-note'))
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== 'Backslash') return
      e.preventDefault()
      const ui = useUIStore.getState()
      if (e.shiftKey) ui.toggleRightSidebar()
      else ui.toggleLeftSidebar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── 클라이언트 인증 가드 (정적 export는 middleware 없음) ──────────────────
  useEffect(() => {
    if (!loading && !session) router.replace('/login')
  }, [loading, session, router])

  // 세션 로딩 중이거나 미인증이면 앱 셸 렌더 보류
  if (loading || !session) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-primary)] text-[var(--text-muted)]">
        Loading...
      </div>
    )
  }

  return (
    <>
      <ThemeProvider />
      <Suspense fallback={<div className="h-screen w-screen bg-[var(--bg-primary)]" />}>
        {isMobile ? (
          <MobileLayout
            left={<LeftSidebar />}
            center={children}
            right={<RightSidebar />}
          />
        ) : (
          <ThreePanelLayout
            left={<LeftSidebar />}
            center={children}
            right={<RightSidebar />}
          />
        )}
        <CommandBar />
      </Suspense>
    </>
  )
}
