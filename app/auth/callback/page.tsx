'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// 웹앱 OAuth 콜백 — Supabase가 ?code=... 로 리다이렉트
// (정적 export 호환: 서버 route handler 대신 클라이언트에서 code 교환)
function CallbackInner() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const code = params.get('code')
    if (!code) {
      router.replace('/login?error=no_code')
      return
    }
    const supabase = createClient()
    supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
      if (error) {
        setError(error.message)
        return
      }
      router.replace('/')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-primary)] text-[var(--text-muted)]">
      {error ? (
        <div className="text-center">
          <p className="text-red-400 text-sm mb-2">⚠ 로그인 실패: {error}</p>
          <button
            onClick={() => router.replace('/login')}
            className="text-xs text-blue-400 hover:underline"
          >
            로그인 페이지로 돌아가기
          </button>
        </div>
      ) : (
        '로그인 처리 중…'
      )}
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-primary)] text-[var(--text-muted)]">
        로그인 처리 중…
      </div>
    }>
      <CallbackInner />
    </Suspense>
  )
}
