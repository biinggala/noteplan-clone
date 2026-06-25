'use client'
import { Suspense, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ThreePanelLayout from '@/components/layout/ThreePanelLayout'
import LeftSidebar from '@/components/sidebar/LeftSidebar'
import RightSidebar from '@/components/sidebar/RightSidebar'
import CommandBar from '@/components/sidebar/CommandBar'
import ThemeProvider from '@/components/ThemeProvider'
import { createClient } from '@/lib/supabase/client'
import { useAuthStore } from '@/lib/stores/authStore'
import { useEventNotifications } from '@/lib/notifications/useEventNotifications'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { session, loading, setSession, setLoading } = useAuthStore()
  const supabase = createClient()
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
        <ThreePanelLayout
          left={<LeftSidebar />}
          center={children}
          right={<RightSidebar />}
        />
        <CommandBar />
      </Suspense>
    </>
  )
}
