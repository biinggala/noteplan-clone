'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { exchangeGoogleCode } from '@/lib/auth/googleOAuth'

// 웹앱 OAuth 콜백 — Supabase가 ?code=... 로 리다이렉트
// (정적 export 호환: 서버 route handler 대신 클라이언트에서 code 교환)
function CallbackInner() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!params.get('code')) {
      router.replace('/login?error=no_code')
      return
    }
    const supabase = createClient()
    // 이 페이지는 앱 레이아웃 밖이라 스토어에 user 가 없다(persist 는 토큰만).
    // '계정이 바뀌면 반영 안 함' 확인은 OAuth 시작 때 남긴 사용자 id 로 한다
    // (exchangeGoogleCode 안에서).
    // exchangeGoogleCode가 code 교환 + provider refresh token 캡처까지 처리
    exchangeGoogleCode(supabase, window.location.href, { allowRetryAsSignIn: true }).then(({ error, ignored }) => {
      if (ignored) { router.replace('/'); return }
      if (error) { setError(error); return }
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
