import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuthStore } from '@/lib/stores/authStore'

export const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events'

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Google OAuth 시작 — Tauri는 시스템 브라우저 + noteplan:// 딥링크,
 * 웹은 같은 창 redirect.
 *
 * `withCalendar`로 요청 권한을 나눈다.
 *   false(기본, 로그인) — 이메일/프로필만. 민감하지 않은 권한이라 심사 없이
 *                        누구나 가입할 수 있다.
 *   true(캘린더 연결)   — calendar 권한까지. 이건 Google이 '민감한 범위'로
 *                        분류해서 미검증 앱이면 경고 화면을 거쳐야 한다.
 *
 * 로그인에까지 캘린더 권한을 묶어두면, 캘린더를 안 쓰는 사람도 그 게이트를
 * 통과해야 해서 가입 자체가 막힌다. 그래서 분리했다.
 */
export async function startGoogleOAuth(
  supabase: SupabaseClient,
  { withCalendar = false }: { withCalendar?: boolean } = {},
): Promise<{ error?: string }> {
  // 캘린더는 refresh token이 필요해 offline + consent를 붙인다.
  // 로그인엔 불필요하고, prompt:consent는 매번 동의 화면을 다시 띄워 성가시다.
  const scopes = withCalendar ? GOOGLE_SCOPES : undefined
  const queryParams = withCalendar
    ? { access_type: 'offline', prompt: 'consent' }
    : undefined

  if (isTauri()) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'noteplan://auth-callback',
        skipBrowserRedirect: true,
        ...(scopes ? { scopes } : {}),
        ...(queryParams ? { queryParams } : {}),
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
      ...(scopes ? { scopes } : {}),
      ...(queryParams ? { queryParams } : {}),
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
