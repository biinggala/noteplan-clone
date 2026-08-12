import type { SupabaseClient } from '@supabase/supabase-js'
import { useAuthStore } from '@/lib/stores/authStore'

export const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events'

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * 지금 진행 중인 OAuth가 '캘린더 연결'인지 표시해두는 자리.
 *
 * 로그인은 캘린더 권한 없이(email/profile만) 받는데, 그때 돌아오는
 * provider_token을 그대로 googleAccessToken에 넣으면 이전에 받아둔
 * '캘린더 권한 있는 토큰'을 권한 없는 토큰으로 덮어쓴다. 그러면 캘린더
 * API가 403으로 죽는데 화면엔 아무것도 안 뜬다.
 * OAuth는 페이지 리다이렉트를 건너뛰므로 메모리로는 못 넘기고 storage를 쓴다.
 */
const CALENDAR_FLOW_KEY = 'np-oauth-with-calendar'

function markCalendarFlow(on: boolean) {
  try {
    if (on) localStorage.setItem(CALENDAR_FLOW_KEY, '1')
    else localStorage.removeItem(CALENDAR_FLOW_KEY)
  } catch { /* storage 못 쓰면 그냥 무시 */ }
}

function consumeCalendarFlow(): boolean {
  try {
    const v = localStorage.getItem(CALENDAR_FLOW_KEY) === '1'
    localStorage.removeItem(CALENDAR_FLOW_KEY)
    return v
  } catch { return false }
}

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
  { withCalendar = false, forceSignIn = false }: { withCalendar?: boolean; forceSignIn?: boolean } = {},
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

  // 콜백에서 "이번 토큰이 캘린더용인지" 판단할 수 있게 표시해둔다
  markCalendarFlow(withCalendar)

  // 이미 로그인한 상태에서 캘린더를 붙이는 경우엔 linkIdentity를 쓴다.
  // signInWithOAuth는 말 그대로 '로그인'이라, 회사 계정으로 캘린더를 연결하면
  // 앱 로그인 자체가 그 계정으로 갈아치워진다(실제로 겪은 버그 — 이후 만든
  // 노트가 전부 엉뚱한 계정에 쌓였다). linkIdentity는 지금 사용자에
  // 두 번째 구글 계정을 '추가'만 하므로 로그인이 유지된다.
  const { data: { session } } = await supabase.auth.getSession()
  const shouldLink = withCalendar && !!session && !forceSignIn

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

/**
 * 딥링크/콜백 URL의 code → 세션 교환.
 *
 * @param expectedUserId  재연결 흐름이면 시도 시작 시점의 로그인 사용자 id를
 *   넘긴다. 교환 결과 세션이 이 사용자와 다르면(=계정이 바뀜) 아예 반영하지
 *   않는다 — 예전에 겪었던 "캘린더 연결이 로그인 계정을 갈아치우는" 사고의
 *   재발 방지용 마지막 안전장치.
 * @param allowRetryAsSignIn  true면 "Identity is already linked" 에러를
 *   자동으로 한 번 더 처리한다 — linkIdentity는 '새 계정 추가' 전용이라
 *   이미 연결된 계정을 다시 연결(토큰 갱신)하려 하면 이 에러로 거부되는데,
 *   그 계정은 이미 지금 사용자 소유이므로 signInWithOAuth로 다시 시도하면
 *   같은 사용자로 안전하게 재인증된다(계정 전환 없음).
 */
export async function exchangeGoogleCode(
  supabase: SupabaseClient,
  url: string,
  { expectedUserId, allowRetryAsSignIn }: { expectedUserId?: string; allowRetryAsSignIn?: boolean } = {},
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
    if (error) {
      if (allowRetryAsSignIn && /already linked/i.test(error.message)) {
        const retry = await startGoogleOAuth(supabase, { withCalendar: true, forceSignIn: true })
        // 성공하면 브라우저가 다시 열려 새 딥링크가 온다 — 그 두 번째 호출은
        // allowRetryAsSignIn을 안 넘길 테니(호출부에서 1회만 전달) 무한 재시도는 없다.
        return retry.error ? { error: `이미 연결된 계정 재인증 실패: ${retry.error}` } : {}
      }
      return { error: error.message }
    }
    const wasCalendarFlow = consumeCalendarFlow()
    if (data.session) {
      if (expectedUserId && data.session.user.id !== expectedUserId) {
        return { error: '계정이 바뀌어서 반영하지 않았습니다(안전장치). 로그인 화면에서 다시 시도해주세요.' }
      }
      // provider_token / provider_refresh_token은 이 교환 직후 세션에만 확실히 담김
      // → 즉시 스토어에 캡처(refresh token 영구 저장).
      // 단 로그인 흐름의 토큰은 캘린더 권한이 없으므로 구글 토큰으로 쓰지 않는다.
      useAuthStore.getState().setSession(data.session, { captureGoogleToken: wasCalendarFlow })
    }
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : '알 수 없는 오류' }
  }
}
