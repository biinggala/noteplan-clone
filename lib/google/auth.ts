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
}

/**
 * refresh token으로 새 access token 발급 (Edge Function 경유).
 * 성공 시 { token, error:null }, 실패 시 { token:null, error:'사유' }.
 */
export async function refreshGoogleAccessToken(
  refreshToken: string
): Promise<RefreshResult> {
  if (!refreshToken) return { token: null, error: 'refresh token 없음 — 재연결 필요' }
  try {
    const supabase = createClient()
    const { data, error } = await supabase.functions.invoke('google-token-refresh', {
      body: { refresh_token: refreshToken },
    })
    if (error) {
      // Edge Function 응답 본문(예: invalid_grant, secret 미설정)을 최대한 추출
      let detail = error.message ?? '알 수 없는 오류'
      try {
        const ctx = (error as { context?: Response }).context
        if (ctx && typeof ctx.text === 'function') {
          const body = await ctx.text()
          if (body) detail = body
        }
      } catch { /* noop */ }
      console.error('[refreshGoogleAccessToken] edge fn:', detail)
      return { token: null, error: detail }
    }
    const token = (data?.access_token as string) ?? null
    if (!token) {
      const detail = (data?.error as string) ?? '응답에 access_token 없음'
      console.error('[refreshGoogleAccessToken] no token:', detail)
      return { token: null, error: detail }
    }
    return { token, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[refreshGoogleAccessToken]', msg)
    return { token: null, error: msg }
  }
}
