import { createClient } from '@/lib/supabase/client'

// Google access token 갱신 — client_secret을 앱에 넣지 않기 위해
// Supabase Edge Function('google-token-refresh')을 통해 서버측에서 교환한다.
// (Edge Function이 GOOGLE_CLIENT_ID/SECRET을 Supabase secret으로 보관)
//
// 배포: supabase functions deploy google-token-refresh
//       supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...

export interface RefreshResult {
  token: string | null
  error: string | null
  /** 서버(google_tokens)가 refresh token 을 보관했는지 — true 면 로컬 사본을 지운다 */
  stored?: boolean
  /** 서버에 보관본이 없음 (아직 연결 안 함 / 철회됨) */
  noStoredToken?: boolean
}

/**
 * 새 access token 발급 (Edge Function 경유).
 * refreshToken 을 주면 교환 + 서버에 보관, null 이면 서버 보관본으로 교환한다.
 */
export async function refreshGoogleAccessToken(
  refreshToken: string | null
): Promise<RefreshResult> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase.functions.invoke('google-token-refresh', {
      body: refreshToken ? { refresh_token: refreshToken } : {},
    })
    if (error) {
      // Edge Function 응답 본문(예: invalid_grant, secret 미설정)을 최대한 추출
      let detail = error.message ?? '알 수 없는 오류'
      let status = 0
      try {
        const ctx = (error as { context?: Response }).context
        status = ctx?.status ?? 0
        if (ctx && typeof ctx.text === 'function') {
          const body = await ctx.text()
          if (body) detail = body
        }
      } catch { /* noop */ }
      // 새 함수: 404 no_stored_token / 예전 함수: 400 missing refresh_token
      const noStoredToken = !refreshToken && (status === 404 || status === 400 || /no_stored_token|missing refresh_token/.test(detail))
      if (!noStoredToken) console.error('[refreshGoogleAccessToken] edge fn:', detail)
      return { token: null, error: detail, noStoredToken }
    }
    const token = (data?.access_token as string) ?? null
    if (!token) {
      const detail = (data?.error as string) ?? '응답에 access_token 없음'
      console.error('[refreshGoogleAccessToken] no token:', detail)
      return { token: null, error: detail }
    }
    return { token, error: null, stored: data?.stored === true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[refreshGoogleAccessToken]', msg)
    return { token: null, error: msg }
  }
}

/** 서버에 보관된 refresh token 삭제 (캘린더 연결 해제 / 로그아웃) */
export async function forgetGoogleTokenOnServer(): Promise<void> {
  try {
    await createClient().functions.invoke('google-token-refresh', { body: { action: 'forget' } })
  } catch { /* 함수가 예전 버전이거나 오프라인 — 무시 */ }
}
