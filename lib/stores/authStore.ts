import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, Session } from '@supabase/supabase-js'

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
  googleAccessToken: string | null
  googleRefreshToken: string | null
  googleAuthError: string | null   // 토큰 갱신 실패 메시지 (재연결 유도)
  setUser: (user: User | null) => void
  setSession: (session: Session | null, opts?: { captureGoogleToken?: boolean }) => void
  setLoading: (loading: boolean) => void
  setGoogleToken: (token: string | null) => void
  setGoogleAuthError: (msg: string | null) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      session: null,
      loading: true,
      googleAccessToken: null,
      googleRefreshToken: null,
      googleAuthError: null,
      setUser: (user) => set({ user }),
      // provider_token / provider_refresh_token은 초기 OAuth 콜백에만 있음 → persist로 살려둠
      // session=null(로그아웃)이면 토큰 제거, 아니면 기존 캐시 유지
      // captureGoogleToken: 이 세션의 provider_token을 '구글 캘린더용 토큰'으로
      // 채택할지. 로그인 흐름은 캘린더 권한 없이 받으므로 false여야 한다 —
      // true로 두면 권한 없는 토큰이 기존 캘린더 토큰을 덮어써서, 캘린더 API가
      // 403으로 죽는데 화면엔 아무 표시도 안 나는 상태가 된다.
      // (onAuthStateChange 등 OAuth와 무관한 호출은 기본 false가 안전)
      setSession: (session, opts) =>
        set((state) => {
          const capture = opts?.captureGoogleToken ?? false
          const providerToken = capture ? (session as any)?.provider_token : undefined
          const providerRefresh = capture ? (session as any)?.provider_refresh_token : undefined
          return {
            session,
            user: session?.user ?? null,
            googleAccessToken: providerToken ?? (session ? state.googleAccessToken : null),
            googleRefreshToken: providerRefresh ?? (session ? state.googleRefreshToken : null),
            // 캘린더 토큰을 새로 받았다면 이전 실패 배너는 치운다
            ...(providerToken ? { googleAuthError: null } : {}),
          }
        }),
      setLoading: (loading) => set({ loading }),
      setGoogleToken: (token) => set({ googleAccessToken: token }),
      setGoogleAuthError: (msg) => set({ googleAuthError: msg }),
    }),
    {
      name: 'auth-google-token',
      // 토큰만 localStorage에 저장 (Session/User 객체는 제외)
      partialize: (state) => ({
        googleAccessToken: state.googleAccessToken,
        googleRefreshToken: state.googleRefreshToken,
      }),
    }
  )
)
