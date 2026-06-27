import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuthStore } from '@/lib/stores/authStore'

export const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events'

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Google OAuth 시작 — Tauri는 시스템 브라우저 + noteplan:// 딥링크,
// 웹은 같은 창 redirect. (로그인 / 캘린더 재연결 공용)
export async function startGoogleOAuth(
  supabase: SupabaseClient
): Promise<{ error?: string }> {
  if (isTauri()) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'noteplan://auth-callback',
        skipBrowserRedirect: true,
        scopes: GOOGLE_SCOPES,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    })
    if (error || !data?.url) return { error: error?.message ?? 'OAuth URL 생성 실패' }
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(data.url)
    return {}
  }

  // 웹앱: 같은 창 redirect
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: GOOGLE_SCOPES,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  })
  return {}
}

// 딥링크/콜백 URL의 code → 세션 교환
export async function exchangeGoogleCode(
  supabase: SupabaseClient,
  url: string
): Promise<{ error?: string }> {
  try {
    const code = new URL(url).searchParams.get('code')
    if (!code) return { error: '인증 코드를 받지 못했습니다' }
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) return { error: error.message }
    // provider_token / provider_refresh_token은 이 교환 직후 세션에만 확실히 담김
    // → 즉시 스토어에 캡처(refresh token 영구 저장)
    if (data.session) useAuthStore.getState().setSession(data.session)
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : '알 수 없는 오류' }
  }
}
