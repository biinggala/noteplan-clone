// Supabase Edge Function: Google access token 갱신
// client_secret을 앱 번들에 노출하지 않기 위해 서버측에서 refresh token을 교환한다.
//
// 배포:
//   supabase functions deploy google-token-refresh
//   supabase secrets set GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...
//
// 호출(클라이언트): supabase.functions.invoke('google-token-refresh', { body: { refresh_token } })
// JWT 검증 기본 활성 → 로그인된 사용자만 호출 가능. 각자 자신의 refresh_token을 보냄.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    return json({ error: 'server not configured (missing GOOGLE_CLIENT_ID/SECRET)' }, 500)
  }

  let refreshToken: string | undefined
  try {
    const body = await req.json()
    refreshToken = body?.refresh_token
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (!refreshToken) return json({ error: 'missing refresh_token' }, 400)

  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const data = await res.json()
    if (!res.ok) {
      return json({ error: data.error ?? 'google token error', detail: data }, 502)
    }
    return json({ access_token: data.access_token, expires_in: data.expires_in })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
