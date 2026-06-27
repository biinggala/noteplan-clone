'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { startGoogleOAuth, isTauri } from '@/lib/auth/googleOAuth'

export default function LoginPage() {
  const supabase = createClient()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)

  // 이미 로그인됐거나, (전역 딥링크 핸들러가) 로그인 완료 시 앱으로 이동
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) router.replace('/')
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) router.replace('/')
    })
    return () => subscription.unsubscribe()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleGoogleLogin = async () => {
    setError(null)
    if (isTauri()) setWaiting(true)
    const { error: oauthErr } = await startGoogleOAuth(supabase)
    if (oauthErr) {
      setError(oauthErr)
      setWaiting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="flex flex-col items-center gap-8">
        {/* 로고 */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center mb-2">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
              <path d="M8 14h4M8 18h8" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">NotePlan Clone</h1>
          <p className="text-sm text-[var(--text-muted)]">마크다운 기반 일정 & 노트 앱</p>
        </div>

        {/* 로그인 카드 */}
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-8 w-80 flex flex-col gap-4">
          <h2 className="text-base font-medium text-[var(--text-primary)] text-center">시작하기</h2>

          <button
            onClick={handleGoogleLogin}
            disabled={waiting}
            className="flex items-center justify-center gap-3 w-full py-2.5 px-4 rounded-lg border border-[var(--border)] bg-white/5 hover:bg-white/10 transition-colors text-sm text-[var(--text-primary)] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {/* Google 아이콘 */}
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            {waiting ? '브라우저에서 로그인 진행 중…' : 'Google로 계속하기'}
          </button>

          {waiting && (
            <p className="text-xs text-blue-400/80 text-center">
              브라우저에서 Google 로그인을 완료하면 자동으로 돌아옵니다
            </p>
          )}

          {error && (
            <p className="text-xs text-red-400 text-center break-words">⚠ {error}</p>
          )}

          <p className="text-xs text-[var(--text-muted)] text-center">
            로그인 시 서비스 이용약관에 동의하는 것으로 간주합니다
          </p>
        </div>
      </div>
    </div>
  )
}
