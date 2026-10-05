// Supabase Edge Function: Google access token 갱신
// client_secret을 앱 번들에 노출하지 않기 위해 서버측에서 refresh token을 교환한다.
//
// 배포:
//   supabase functions deploy google-token-refresh
//   supabase secrets set GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...
//   (선택) supabase secrets set ALLOWED_ORIGINS="https://내-도메인,tauri://localhost"
//
// 보안 (2.0):
// - 예전엔 anon 키(앱 번들에 든 공개값)만 있으면 누구나 호출할 수 있었다. Supabase의
//   verify_jwt 는 anon 키도 '유효한 JWT'로 통과시키기 때문이다. 그래서 어디서 얻은
//   refresh token 이든 이 함수에 넣으면 앱의 client secret 으로 피해자의 캘린더
//   토큰을 발급받을 수 있었다(사실상 공개된 client secret).
//   → 이제 로그인한 사용자의 세션을 auth.getUser 로 확인한다.
// - refresh token 을 브라우저 localStorage 에 두지 않는다. 처음 한 번 클라이언트가
//   보내면 google_tokens 테이블(클라이언트 접근 불가)에 사용자별로 보관하고, 이후엔
//   body 없이 호출하면 서버가 보관본으로 갱신한다. 새 기기에서 로그인해도 다시
//   연결할 필요가 없다.
// - CORS 는 허용한 출처만, 오류 응답에는 구글의 원문 응답을 싣지 않는다.
//
// 호출(클라이언트): supabase.functions.invoke('google-token-refresh', { body })
//   body = { refresh_token }  → 교환 + 서버에 보관 (stored: true)
//   body = {}                 → 서버 보관본으로 교환 (없으면 404 no_stored_token)
//   body = { action: 'forget' } → 서버 보관본 삭제 (캘린더 연결 해제)

import { createClient } from 'npm:@supabase/supabase-js@2'

const DEFAULT_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:3000',
]

function allowedOrigins(): string[] {
  const extra = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [...DEFAULT_ORIGINS, ...extra]
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return true  // 비브라우저 호출(앱 내부 fetch 등)
  if (allowedOrigins().includes(origin)) return true
  // Vercel 배포(프로덕션·프리뷰)는 기본 허용 — 도메인을 따로 안 넣어도 동작하게
  try { return new URL(origin).hostname.endsWith('.vercel.app') } catch { return false }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin && originAllowed(origin) ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin')
  const cors = corsHeaders(origin)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  if (!originAllowed(origin)) return json({ error: 'origin_not_allowed' }, 403)

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!clientId || !clientSecret || !supabaseUrl || !anonKey) {
    return json({ error: 'server_not_configured' }, 500)
  }

  // ── 호출자 확인: 로그인한 사용자 세션이어야 한다 (anon 키 불가) ──────────────
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })
  const { data: userData, error: userErr } = await authClient.auth.getUser(jwt)
  const user = userData?.user
  if (userErr || !user) return json({ error: 'unauthorized' }, 401)

  let body: { refresh_token?: string; action?: string } = {}
  try { body = await req.json() } catch { /* 빈 body 허용 */ }

  // google_tokens 는 클라이언트 권한이 전혀 없는 테이블 — service role 로만 접근.
  // 테이블/키가 아직 없으면(마이그레이션 전) 예전처럼 보관 없이 교환만 한다.
  const admin = serviceKey ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } }) : null

  if (body.action === 'forget') {
    if (admin) await admin.from('google_tokens').delete().eq('user_id', user.id)
    return json({ ok: true })
  }

  let refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : undefined
  let fromStore = false
  if (!refreshToken && admin) {
    const { data } = await admin.from('google_tokens').select('refresh_token').eq('user_id', user.id).maybeSingle()
    refreshToken = data?.refresh_token ?? undefined
    fromStore = !!refreshToken
  }
  if (!refreshToken) return json({ error: 'no_stored_token' }, 404)

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      // invalid_grant = 사용자가 권한을 철회했거나 만료 → 보관본도 버린다
      if (data?.error === 'invalid_grant' && fromStore && admin) {
        await admin.from('google_tokens').delete().eq('user_id', user.id)
      }
      return json({ error: typeof data?.error === 'string' ? data.error : 'google_token_error' }, 502)
    }

    let stored = false
    if (admin) {
      // 구글이 refresh token 을 새로 주면(회전) 그걸 보관한다
      const keep = typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken
      const { error } = await admin.from('google_tokens').upsert(
        { user_id: user.id, refresh_token: keep, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      )
      stored = !error
      if (error) console.error('[google-token-refresh] store failed:', error.message)
    }
    return json({ access_token: data.access_token, expires_in: data.expires_in, stored })
  } catch (e) {
    console.error('[google-token-refresh]', e)
    return json({ error: 'upstream_unreachable' }, 502)
  }
})
