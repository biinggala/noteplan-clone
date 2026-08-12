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

  const redirectTo = isTauri()
    ? 'noteplan://auth-callback'
    : `${window.location.origin}/auth/callback`

  // 이미 로그인한 상태에서 캘린더를 붙이는 경우엔 linkIdentity를 쓴다.
  // signInWithOAuth는 말 그대로 '로그인'이라, 회사 계정으로 캘린더를 연결하면
  // 앱 로그인 자체가 그 계정으로 갈아치워진다(실제로 겪은 버그 — 이후 만든
  // 노트가 전부 엉뚱한 계정에 쌓였다). linkIdentity는 지금 사용자에
  // 두 번째 구글 계정을 '추가'만 하므로 로그인이 유지된다.
  const { data: { session } } = await supabase.auth.getSession()
  const shouldLink = withCalendar && !!session

  if (shouldLink) {
    const { data, error } = await supabase.auth.linkIdentity({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: isTauri(),
        ...(scopes ? { scopes } : {}),
        ...(queryParams ? { queryParams } : {}),
      },
    })
    if (error) {
      // Supabase 대시보드에서 Manual Linking이 꺼져 있으면 여기로 온다.
      // 이 경우 signInWithOAuth로 폴백하면 계정이 바뀌어버리므로 폴백하지 않는다.
      return {
        error: `캘린더 연결 실패: ${error.message}\n` +
          'Supabase 대시보드 → Authentication → Sign In / Providers 에서 ' +
          '"Allow manual linking"을 켜야 합니다.',
      }
    }
    if (isTauri() && data?.url) {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(data.url)
    }
    return {}
  }

  // 로그인(또는 로그아웃 상태에서의 캘린더 연결) — 세션을 새로 만든다
  if (isTauri()) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
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

  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
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
    const params = new URL(url).searchParams
    const code = params.get('code')
    if (!code) {
      // code가 없으면 대개 구글/Supabase가 대신 error 파라미터를 보낸 것이다.
      // 그동안은 이걸 버리고 "인증 코드를 받지 못했습니다"로 뭉뚱그려서
      // 진짜 이유(예: access_denied, redirect_uri_mismatch, 이미 다른
      // 계정에 연결된 identity 등)가 하나도 안 보였다.
      const reason = params.get('error_description') ?? params.get('error')
      return { error: reason ? `${reason} (${params.get('error') ?? 'no_code'})` : '인증 코드를 받지 못했습니다 (콜백 URL에 code도 error도 없음)' }
    }
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
