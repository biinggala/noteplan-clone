'use client'
import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isTauri, exchangeGoogleCode } from '@/lib/auth/googleOAuth'

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
        if (url) exchangeGoogleCode(supabase, url)
      }).then(fn => { unlisten = fn })
    })

    return () => unlisten?.()
  }, [])

  return null
}
