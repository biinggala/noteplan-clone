'use client'
import { useEffect } from 'react'
import ThreePanelLayout from '@/components/layout/ThreePanelLayout'
import LeftSidebar from '@/components/sidebar/LeftSidebar'
import RightSidebar from '@/components/sidebar/RightSidebar'
import CommandBar from '@/components/sidebar/CommandBar'
import ThemeProvider from '@/components/ThemeProvider'
import MobileLayout from '@/components/mobile/MobileLayout'
import { useIsMobile } from '@/lib/hooks/useIsMobile'
import { createClient } from '@/lib/supabase/client'
import { useAuthStore } from '@/lib/stores/authStore'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { setSession, setLoading } = useAuthStore()
  const supabase = createClient()
  const isMobile = useIsMobile()

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

  return (
    <>
      <ThemeProvider />
      {isMobile ? (
        <MobileLayout>{children}</MobileLayout>
      ) : (
        <ThreePanelLayout
          left={<LeftSidebar />}
          center={children}
          right={<RightSidebar />}
        />
      )}
      <CommandBar />
    </>
  )
}
