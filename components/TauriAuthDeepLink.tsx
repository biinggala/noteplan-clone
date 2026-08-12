'use client'
import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isTauri, exchangeGoogleCode } from '@/lib/auth/googleOAuth'
import { useAuthStore } from '@/lib/stores/authStore'

// Tauri 전용: noteplan://auth-callback?code=... 딥링크를 전역에서 수신해
// 세션 교환. 로그인 화면이든 앱 안(캘린더 재연결)이든 어디서나 동작.
export default function TauriAuthDeepLink() {
  useEffect(() => {
    if (!isTauri()) return
    const supabase = createClient()
    let unlisten: (() => void) | undefined

    import('@tauri-apps/plugin-deep-link').then(({ onOpenUrl }) => {
      onOpenUrl((urls) => {
        const url = urls.find(u => u.startsWith('noteplan://'))
        if (!url) return
        // 여기서 실패해도 지금까지는 아무 데도 안 보였다 — linkIdentity 자체는
        // Supabase 서버에서 이미 처리돼 있어서(계정에 identity가 붙음) "연결은
        // 됐는데 캘린더는 안 뜬다"는 상태가 조용히 만들어질 수 있었다.
        // 기존 재연결 배너(MiniCalendar)를 그대로 재사용해 원인을 보여준다.
        exchangeGoogleCode(supabase, url).then(({ error }) => {
          if (error) useAuthStore.getState().setGoogleAuthError(`캘린더 연결 실패: ${error}`)
        })
      }).then(fn => { unlisten = fn })
    })

    return () => unlisten?.()
  }, [])

  return null
}
