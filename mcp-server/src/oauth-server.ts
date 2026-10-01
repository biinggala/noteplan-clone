/**
 * OAuth 2.1 인가 서버 — claude.ai·폰 앱 커넥터처럼 "URL만 넣는" 클라이언트용.
 *
 * 흐름 (MCP Authorization 스펙):
 *   1. 클라이언트가 /mcp 를 토큰 없이 부른다 → 401 + WWW-Authenticate 의
 *      resource_metadata 로 이 서버의 메타데이터 위치를 알려준다
 *   2. 메타데이터(RFC 9728 / 8414)를 읽고 /register 로 자기 자신을 등록한다 (RFC 7591)
 *   3. 사용자 브라우저를 /authorize 로 보낸다 (PKCE S256 필수)
 *   4. 이 서버는 사용자를 Supabase Google 로그인으로 보낸다 — 로그인 자체는
 *      앱과 똑같은 Supabase 계정 체계를 그대로 쓴다
 *   5. /oauth/callback 에서 Supabase 세션을 받고, 동의 화면을 보여준다
 *   6. [허용] → 일회용 코드를 들려 클라이언트로 돌려보낸다
 *   7. 클라이언트가 /token 에서 코드 + PKCE verifier 로 접근/리프레시 토큰을 받는다
 *
 * 저장 위치를 줄이려고:
 *   • 클라이언트 등록 정보는 DB에 두지 않고 client_id 자체에 봉인해 넣는다
 *   • 로그인 대기 상태는 봉인된 쿠키에 둔다 (서버 메모리 없음 — 인스턴스가 여러 개여도 됨)
 *   • 동의 대기·코드·토큰 상태는 mcp_tokens 한 행이 들고, 전부 해시로만 저장한다
 *
 * 보안 판단의 근거는 SECURITY.md 13항.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { readFormBody, readJsonBody } from './body.js'
import {
  clientSecretFor, hashPat, randomToken, s256, safeEqual, seal, sealTyped, unsealTyped,
} from './crypto.js'
import { clientKey, rateLimit, requireTls } from './guard.js'
import { AuthError } from './remote-auth.js'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase.js'

const ACCESS_TTL_SECONDS = 3600      // 접근 토큰 1시간 — 이후 refresh 로 회전
const CODE_TTL_SECONDS = 300         // 동의 → /token 교환까지
const CONSENT_TTL_SECONDS = 600      // 로그인 → [허용] 클릭까지
const PENDING_TTL_SECONDS = 600      // /authorize → 구글 로그인 완료까지

const PENDING_COOKIE = 'np_oauth_pending'
const CALLBACK_PATH = '/oauth/callback'
const CONSENT_PATH = '/oauth/consent'

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const
type AuthMethod = typeof AUTH_METHODS[number]

interface ClientInfo extends Record<string, unknown> {
  r: string[]          // 등록된 redirect_uris
  n: string | null     // client_name
  m: AuthMethod
  iat: number
}

interface Pending extends Record<string, unknown> {
  cid: string          // client_id
  ru: string           // redirect_uri
  cc: string           // 클라이언트의 code_challenge
  st: string | null    // 클라이언트의 state
  sv: string           // Supabase 쪽 PKCE verifier (이 서버가 Supabase 의 클라이언트)
  n: string | null
}

// ── 설정 ─────────────────────────────────────────────────────────────────────

/**
 * 바깥에서 보이는 이 서버의 주소. issuer·엔드포인트·리다이렉트 주소를 만든다.
 * Host 헤더로 추측하지 않는다 — 요청자가 바꿀 수 있는 값으로 issuer 를 만들면
 * 메타데이터를 엉뚱한 주소로 오염시킬 수 있다.
 */
export function publicUrl(): string | undefined {
  // Render 는 서비스 주소를 RENDER_EXTERNAL_URL 로 직접 넣어 준다 — 요청 헤더가 아니라
  // 플랫폼이 정한 값이라 믿을 수 있다. 직접 지정(MCP_PUBLIC_URL)이 있으면 그게 우선.
  const raw = (process.env.MCP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.trim()
  return raw ? raw.replace(/\/+$/, '') : undefined
}

export function wwwAuthenticate(invalidToken: boolean): string {
  const parts = ['Bearer realm="noteplan-mcp"']
  const pub = publicUrl()
  if (pub) parts.push(`resource_metadata="${pub}/.well-known/oauth-protected-resource"`)
  if (invalidToken) parts.push('error="invalid_token"')
  return parts.join(', ')
}

/**
 * 돌아갈 수 있는 곳을 좁힌다. DCR 은 누구나 할 수 있으므로, 이게 없으면
 * 공격자가 자기 서버를 redirect_uri 로 등록해 남의 승인 코드를 받아갈 수 있다.
 * 기본값은 Claude(웹·앱)와 로컬 CLI 콜백뿐이다.
 */
function redirectHosts(): string[] {
  return (process.env.MCP_OAUTH_REDIRECT_HOSTS ?? 'claude.ai,claude.com,localhost,127.0.0.1')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

function isAllowedRedirect(uri: string): boolean {
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hash || u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return false
  return redirectHosts().includes(host)
}

function decodeClient(clientId: string | undefined): ClientInfo | null {
  if (!clientId?.startsWith('npc_')) return null
  const info = unsealTyped<ClientInfo>('client', clientId.slice(4))
  if (!info || !Array.isArray(info.r) || !AUTH_METHODS.includes(info.m)) return null
  return info
}

function resourceMatches(resource: string, pub: string): boolean {
  const r = resource.replace(/\/+$/, '')
  return r === `${pub}/mcp` || r === pub
}

function anon() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// ── 응답 헬퍼 ────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

function oauthError(res: ServerResponse, status: number, error: string, description?: string): void {
  sendJson(res, status, { error, ...(description ? { error_description: description } : {}) }, {
    'Cache-Control': 'no-store',
    ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="noteplan-mcp"' } : {}),
  })
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers })
  res.end()
}

function redirectWithError(res: ServerResponse, pub: string, redirectUri: string, state: string | null | undefined,
  error: string, description?: string, headers: Record<string, string | string[]> = {}): void {
  const u = new URL(redirectUri)
  u.searchParams.set('error', error)
  if (description) u.searchParams.set('error_description', description)
  if (state) u.searchParams.set('state', state)
  u.searchParams.set('iss', pub)
  redirect(res, u.toString(), headers)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 승인 화면은 다른 사이트 안에 끼워 넣을 수 없어야 한다 (클릭재킹) */
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

function page(res: ServerResponse, status: number, title: string, bodyHtml: string, headers: Record<string, string | string[]> = {}): void {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--muted:#666;--card:#fff;--line:#e5e5e5;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#999;--card:#1e1e1e;--line:#2c2c2c;--accent:#3b82f6}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif;padding:20px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px}
h1{font-size:20px;margin:0 0 14px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
strong{word-break:break-all}.row{display:flex;gap:10px;margin-top:22px}
button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid var(--line);cursor:pointer;background:transparent;color:var(--fg)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><main>${bodyHtml}</main></body></html>`
  res.writeHead(status, { ...PAGE_HEADERS, ...headers })
  res.end(html)
}

function errorPage(res: ServerResponse, status: number, message: string, headers: Record<string, string | string[]> = {}): void {
  page(res, status, 'NotePlan 연결 오류', `<h1>연결할 수 없습니다</h1><p>${escapeHtml(message)}</p>
<p class="muted">Claude로 돌아가 커넥터 연결을 다시 시도해 주세요.</p>`, headers)
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

function pendingCookie(value: string, maxAge: number): string {
  return `${PENDING_COOKIE}=${value}; Path=${CALLBACK_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

// ── 메타데이터 ───────────────────────────────────────────────────────────────

function protectedResourceMetadata(pub: string) {
  return {
    resource: `${pub}/mcp`,
    authorization_servers: [pub],
    bearer_methods_supported: ['header'],
    scopes_supported: ['notes'],
    resource_name: 'NotePlan',
  }
}

function authorizationServerMetadata(pub: string) {
  return {
    issuer: pub,
    authorization_endpoint: `${pub}/authorize`,
    token_endpoint: `${pub}/token`,
    registration_endpoint: `${pub}/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: ['notes'],
    authorization_response_iss_parameter_supported: true,
  }
}

// ── /register (RFC 7591) ─────────────────────────────────────────────────────

async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown
  } | undefined
  const uris = body?.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(u => typeof u === 'string')) {
    return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris 는 1~10개의 문자열이어야 합니다')
  }
  const bad = (uris as string[]).find(u => !isAllowedRedirect(u))
  if (bad) {
    // 새 클라이언트(예: Claude 외의 앱)를 붙일 때 무엇을 허용해야 하는지 운영자가
    // 바로 알 수 있게 남긴다. redirect_uri 는 비밀이 아니다.
    let host = bad
    try { host = new URL(bad).hostname } catch { /* 그대로 */ }
    console.warn(`[noteplan-mcp] 등록 거부: 허용되지 않은 redirect_uri ${bad}` +
      ` — 이 앱을 믿는다면 MCP_OAUTH_REDIRECT_HOSTS 에 ${host} 를 추가하세요`)
    return oauthError(res, 400, 'invalid_redirect_uri',
      `허용되지 않은 redirect_uri 입니다: ${bad} (MCP_OAUTH_REDIRECT_HOSTS 로 허용 호스트를 정합니다)`)
  }
  const requested = body?.token_endpoint_auth_method
  const method: AuthMethod = AUTH_METHODS.includes(requested as AuthMethod) ? requested as AuthMethod : 'none'
  const name = typeof body?.client_name === 'string' ? body.client_name.trim().slice(0, 100) || null : null
  const iat = Math.floor(Date.now() / 1000)

  const clientId = 'npc_' + sealTyped('client', { r: uris as string[], n: name, m: method, iat })
  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: iat,
    redirect_uris: uris,
    token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(name ? { client_name: name } : {}),
    ...(method !== 'none' ? { client_secret: clientSecretFor(clientId), client_secret_expires_at: 0 } : {}),
  }, { 'Cache-Control': 'no-store' })
}

// ── /authorize ───────────────────────────────────────────────────────────────

function authorize(res: ServerResponse, url: URL, pub: string): void {
  const q = url.searchParams
  const clientId = q.get('client_id') ?? undefined
  const client = decodeClient(clientId)
  // client_id 나 redirect_uri 가 틀리면 **절대 리다이렉트하지 않는다** —
  // 확인 안 된 주소로 보내면 이 서버가 오픈 리다이렉터가 된다 (RFC 6749 4.1.2.1)
  if (!client || !clientId) return errorPage(res, 400, '등록되지 않은 클라이언트입니다.')
  const requestedRedirect = q.get('redirect_uri')
  const redirectUri = requestedRedirect ?? (client.r.length === 1 ? client.r[0] : null)
  if (!redirectUri || !client.r.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    return errorPage(res, 400, '등록되지 않은 돌아갈 주소(redirect_uri)입니다.')
  }

  const state = q.get('state')
  if (q.get('response_type') !== 'code') {
    return redirectWithError(res, pub, redirectUri, state, 'unsupported_response_type')
  }
  const challenge = q.get('code_challenge')
  if (q.get('code_challenge_method') !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return redirectWithError(res, pub, redirectUri, state, 'invalid_request', 'PKCE(S256)가 필요합니다')
  }
  const resource = q.get('resource')
  if (resource && !resourceMatches(resource, pub)) {
    return redirectWithError(res, pub, redirectUri, state, 'invalid_target', '이 서버의 리소스가 아닙니다')
  }

  // 이 서버가 Supabase 에 대해 하는 PKCE — 클라이언트의 PKCE 와는 별개다
  const supabaseVerifier = randomToken('')
  const pending: Pending = { cid: clientId, ru: redirectUri, cc: challenge, st: state, sv: supabaseVerifier, n: client.n }
  const target = new URL(`${SUPABASE_URL}/auth/v1/authorize`)
  target.searchParams.set('provider', 'google')
  target.searchParams.set('redirect_to', `${pub}${CALLBACK_PATH}`)
  target.searchParams.set('code_challenge', s256(supabaseVerifier))
  target.searchParams.set('code_challenge_method', 's256')

  redirect(res, target.toString(), {
    'Set-Cookie': pendingCookie(sealTyped('pending', pending, PENDING_TTL_SECONDS), PENDING_TTL_SECONDS),
  })
}

// ── /oauth/callback — Supabase 로그인에서 돌아오는 곳 ─────────────────────────

async function callback(req: IncomingMessage, res: ServerResponse, url: URL, pub: string): Promise<void> {
  const clear = { 'Set-Cookie': pendingCookie('', 0) }
  const raw = readCookie(req, PENDING_COOKIE)
  const pending = raw ? unsealTyped<Pending>('pending', raw) : null
  if (!pending) return errorPage(res, 400, '로그인 대기 정보가 없거나 만료됐습니다 (10분).', clear)

  const supabaseError = url.searchParams.get('error_description') ?? url.searchParams.get('error')
  if (supabaseError) return redirectWithError(res, pub, pending.ru, pending.st, 'access_denied', supabaseError, clear)
  const code = url.searchParams.get('code')
  if (!code) return redirectWithError(res, pub, pending.ru, pending.st, 'access_denied', '로그인 코드가 없습니다', clear)

  const exchange = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ auth_code: code, code_verifier: pending.sv }),
  })
  const session = await exchange.json().catch(() => null) as {
    access_token?: string; refresh_token?: string; user?: { id?: string; email?: string }
  } | null
  if (!exchange.ok || !session?.access_token || !session.refresh_token || !session.user?.id) {
    return redirectWithError(res, pub, pending.ru, pending.st, 'access_denied', '로그인 확인에 실패했습니다', clear)
  }

  const email = session.user.email?.toLowerCase()
  const allowed = process.env.MCP_ALLOWED_EMAILS?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (allowed?.length && (!email || !allowed.includes(email))) {
    // 쓰지 않을 세션은 바로 닫는다 (best-effort)
    void fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    }).catch(() => {})
    return redirectWithError(res, pub, pending.ru, pending.st, 'access_denied',
      '이 서버에 연결할 수 있는 계정이 아닙니다', clear)
  }

  // 동의 대기 행. **사용자 본인 JWT 로** 삽입하므로 RLS(with check auth.uid() = user_id)가
  // 남의 user_id 로 행을 만드는 것을 DB에서 막는다. 이 Supabase 세션은 이 연결 전용이라
  // 다른 연결·로컬 서버와 refresh token 을 공유하지 않는다 (로테이션 충돌 없음).
  const nonce = randomToken('npmcn_')
  const userDb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await userDb.from('mcp_tokens').insert({
    user_id: session.user.id,
    token_hash: hashPat(randomToken('inert_')),   // 아무도 모르는 값 — 활성화 전엔 접근 불가
    label: pending.n ?? 'OAuth 클라이언트',
    session_cipher: seal(JSON.stringify({ refresh_token: session.refresh_token })),
    client_id_hash: hashPat(pending.cid),
    redirect_uri: pending.ru,
    code_challenge: pending.cc,
    oauth_state: pending.st,
    consent_hash: hashPat(nonce),
    consent_expires_at: new Date(Date.now() + CONSENT_TTL_SECONDS * 1000).toISOString(),
  })
  if (error) {
    console.error('[noteplan-mcp] 동의 대기 행 생성 실패:', error.message)
    return errorPage(res, 500, '서버 오류로 연결을 준비하지 못했습니다.', clear)
  }

  const clientName = pending.n ?? '알 수 없는 앱'
  const host = new URL(pending.ru).host
  page(res, 200, 'NotePlan 연결 승인', `
<h1>NotePlan 노트에 연결</h1>
<p><strong>${escapeHtml(clientName)}</strong> 이(가)
<strong>${escapeHtml(email ?? session.user.id)}</strong> 계정의 노트를 <strong>읽고 쓰려고</strong> 합니다.</p>
<p class="muted">허용하면 <strong>${escapeHtml(host)}</strong> 로 돌아갑니다.
직접 시작한 연결이 아니라면 거부하세요.</p>
<form method="post" action="${escapeHtml(pub + CONSENT_PATH)}">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<div class="row">
<button type="submit" name="decision" value="deny">거부</button>
<button type="submit" name="decision" value="allow" class="primary">허용</button>
</div></form>`, clear)
}

// ── /oauth/consent ───────────────────────────────────────────────────────────

async function consent(req: IncomingMessage, res: ServerResponse, pub: string): Promise<void> {
  // 다른 사이트에서 몰래 POST 시키는 것 차단 (브라우저는 폼 POST 에 Origin 을 붙인다)
  const origin = req.headers.origin
  if (origin && origin !== 'null' && origin !== new URL(pub).origin) {
    return errorPage(res, 403, '다른 사이트에서 보낸 승인 요청은 받지 않습니다.')
  }
  const form = await readFormBody(req)
  if (!form.nonce) return errorPage(res, 400, '승인 정보가 없습니다.')
  const allow = form.decision === 'allow'
  const code = allow ? randomToken('npmcd_') : null

  const { data, error } = await anon().rpc('mcp_oauth_consent', {
    p_consent_hash: hashPat(form.nonce),
    p_allow: allow,
    p_code_hash: code ? hashPat(code) : null,
    p_code_ttl_seconds: CODE_TTL_SECONDS,
  })
  if (error) {
    console.error('[noteplan-mcp] 동의 처리 실패:', error.message)
    return errorPage(res, 500, '서버 오류로 승인을 처리하지 못했습니다.')
  }
  const row = (data as Array<{ t_redirect_uri: string; t_state: string | null }> | null)?.[0]
  // nonce 는 한 번만 쓰인다 — 새로고침·뒤로가기로 다시 보내도 여기서 끝난다
  if (!row) return errorPage(res, 400, '이 승인 요청은 만료됐거나 이미 처리됐습니다.')

  if (!allow) return redirectWithError(res, pub, row.t_redirect_uri, row.t_state, 'access_denied', '사용자가 거부했습니다')
  const back = new URL(row.t_redirect_uri)
  back.searchParams.set('code', code!)
  if (row.t_state) back.searchParams.set('state', row.t_state)
  back.searchParams.set('iss', pub)
  redirect(res, back.toString())
}

// ── /token ───────────────────────────────────────────────────────────────────

function basicAuth(header: string | undefined): { id: string; secret: string } | null {
  const m = header && /^Basic\s+(.+)$/i.exec(header.trim())
  if (!m) return null
  const decoded = Buffer.from(m[1], 'base64').toString('utf8')
  const i = decoded.indexOf(':')
  if (i < 0) return null
  return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) }
}

async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readFormBody(req)
  const basic = basicAuth(req.headers.authorization)
  const clientId = basic?.id ?? form.client_id
  const client = decodeClient(clientId)
  if (!client || !clientId) return oauthError(res, 401, 'invalid_client', '알 수 없는 클라이언트입니다')
  if (client.m !== 'none') {
    const secret = basic?.secret ?? form.client_secret
    if (!secret || !safeEqual(secret, clientSecretFor(clientId))) {
      return oauthError(res, 401, 'invalid_client', '클라이언트 인증에 실패했습니다')
    }
  }

  const accessToken = randomToken('npmat_')
  const refreshToken = randomToken('npmrt_')
  type GrantRows = Array<{ t_user_id: string }> | null
  let rows: GrantRows = null

  if (form.grant_type === 'authorization_code') {
    if (!form.code || !form.code_verifier) {
      return oauthError(res, 400, 'invalid_request', 'code 와 code_verifier 가 필요합니다')
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(form.code_verifier)) {
      return oauthError(res, 400, 'invalid_grant', 'code_verifier 형식이 올바르지 않습니다')
    }
    const redirectUri = form.redirect_uri ?? (client.r.length === 1 ? client.r[0] : '')
    // client·redirect_uri·PKCE·만료·1회용을 DB 에서 한 번에 확인하고 그 자리에서 코드를 태운다
    const { data, error } = await anon().rpc('mcp_oauth_redeem_code', {
      p_code_hash: hashPat(form.code),
      p_client_id_hash: hashPat(clientId),
      p_redirect_uri: redirectUri,
      p_challenge: s256(form.code_verifier),
      p_token_hash: hashPat(accessToken),
      p_refresh_hash: hashPat(refreshToken),
      p_token_ttl_seconds: ACCESS_TTL_SECONDS,
    })
    if (error) throw new AuthError(`코드 교환 실패: ${error.message}`, 500)
    rows = data as GrantRows
  } else if (form.grant_type === 'refresh_token') {
    if (!form.refresh_token) return oauthError(res, 400, 'invalid_request', 'refresh_token 이 필요합니다')
    // 리프레시 토큰도 매번 새로 발급하고 옛것은 그 자리에서 무효가 된다 (OAuth 2.1)
    const { data, error } = await anon().rpc('mcp_oauth_refresh', {
      p_refresh_hash: hashPat(form.refresh_token),
      p_client_id_hash: hashPat(clientId),
      p_new_token_hash: hashPat(accessToken),
      p_new_refresh_hash: hashPat(refreshToken),
      p_token_ttl_seconds: ACCESS_TTL_SECONDS,
    })
    if (error) throw new AuthError(`토큰 갱신 실패: ${error.message}`, 500)
    rows = data as GrantRows
  } else {
    return oauthError(res, 400, 'unsupported_grant_type')
  }

  // 무엇이 틀렸는지(만료/재사용/PKCE/redirect)는 알려주지 않는다
  if (!rows?.length) return oauthError(res, 400, 'invalid_grant', '코드나 토큰이 유효하지 않습니다')

  sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: 'notes',
  }, { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
}

// ── 라우팅 ───────────────────────────────────────────────────────────────────

const ROUTES: Record<string, { method: 'GET' | 'POST'; secret: boolean }> = {
  '/.well-known/oauth-protected-resource':     { method: 'GET', secret: false },
  '/.well-known/oauth-protected-resource/mcp': { method: 'GET', secret: false },
  '/.well-known/oauth-authorization-server':   { method: 'GET', secret: false },
  '/register':     { method: 'POST', secret: true },
  '/authorize':    { method: 'GET', secret: true },
  [CALLBACK_PATH]: { method: 'GET', secret: true },
  [CONSENT_PATH]:  { method: 'POST', secret: true },
  '/token':        { method: 'POST', secret: true },
}

/** OAuth 경로면 처리하고 true, 아니면 false (다른 핸들러로 넘긴다) */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const route = ROUTES[url.pathname]
  if (!route) return false
  const isPage = url.pathname === '/authorize' || url.pathname === CALLBACK_PATH || url.pathname === CONSENT_PATH

  const pub = publicUrl()
  if (!pub) {
    if (isPage) errorPage(res, 503, '이 서버는 OAuth 연결이 설정돼 있지 않습니다 (MCP_PUBLIC_URL).')
    else oauthError(res, 503, 'temporarily_unavailable', 'MCP_PUBLIC_URL 이 없어 OAuth 가 비활성입니다')
    return true
  }
  if (req.method === 'OPTIONS' && !route.secret) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' })
    res.end()
    return true
  }
  if (req.method !== route.method) {
    if (isPage) errorPage(res, 405, '허용되지 않은 요청 방식입니다.', { Allow: route.method })
    else oauthError(res, 405, 'invalid_request', `${route.method} 만 허용`)
    return true
  }

  try {
    if (route.secret) {
      requireTls(req)
      rateLimit(`oauth:${clientKey(req)}`)
    }
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        sendJson(res, 200, protectedResourceMetadata(pub), { 'Access-Control-Allow-Origin': '*' })
        break
      case '/.well-known/oauth-authorization-server':
        sendJson(res, 200, authorizationServerMetadata(pub), { 'Access-Control-Allow-Origin': '*' })
        break
      case '/register': await register(req, res); break
      case '/authorize': authorize(res, url, pub); break
      case CALLBACK_PATH: await callback(req, res, url, pub); break
      case CONSENT_PATH: await consent(req, res, pub); break
      case '/token': await token(req, res); break
    }
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500
    const message = e instanceof Error ? e.message : '알 수 없는 오류'
    if (status >= 500) console.error('[noteplan-mcp] oauth', message)
    if (res.headersSent) { res.end(); return true }
    if (isPage) errorPage(res, status, message)
    else oauthError(res, status, status === 429 ? 'slow_down' : status >= 500 ? 'server_error' : 'invalid_request', message)
  }
  return true
}
