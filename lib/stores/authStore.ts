import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, Session } from '@supabase/supabase-js'

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
  googleAccessToken: string | null
  setUser: (user: User | null) => void
  setSession: (session: Session | null) => void
  setLoading: (loading: boolean) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      session: null,
      loading: true,
      googleAccessToken: null,
      setUser: (user) => set({ user }),
      // provider_token은 초기 OAuth 콜백에만 있음 → persist로 살려둠
      // session=null(로그아웃)이면 토큰 제거, 아니면 기존 캐시 유지
      setSession: (session) =>
        set((state) => ({
          session,
          user: session?.user ?? null,
          googleAccessToken:
            (session as any)?.provider_token   // 새 로그인 시
            ?? (session ? state.googleAccessToken : null), // 세션 있으면 캐시 유지, 없으면 clear
        })),
      setLoading: (loading) => set({ loading }),
    }),
    {
      name: 'auth-google-token',
      // googleAccessToken만 localStorage에 저장 (Session/User 객체는 제외)
      partialize: (state) => ({ googleAccessToken: state.googleAccessToken }),
    }
  )
)
