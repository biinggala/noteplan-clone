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
  setSession: (session: Session | null) => void
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
      setSession: (session) =>
        set((state) => ({
          session,
          user: session?.user ?? null,
          googleAccessToken:
            (session as any)?.provider_token
            ?? (session ? state.googleAccessToken : null),
          googleRefreshToken:
            (session as any)?.provider_refresh_token
            ?? (session ? state.googleRefreshToken : null),
        })),
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
