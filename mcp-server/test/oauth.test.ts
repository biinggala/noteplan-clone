/**
 * OAuth 2.1 흐름 테스트 — claude.ai 커넥터처럼 "URL만 넣는" 클라이언트가 겪는 그대로.
 *
 *   /mcp(401) → 메타데이터 → /register → /authorize → (구글 로그인) → /oauth/callback
 *   → 동의 화면 → [허용] → /token → /mcp(200)
 *
 * 가짜 Supabase 는 실제 RLS처럼 JWT 의 sub 로만 노트를 보여준다. 그래서 토큰이
 * 엉뚱한 사용자의 세션에 묶이면 남의 노트가 응답에 섞이고 테스트가 깨진다.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { emptyState, startFakeSupabase, type FakeNote, type FakeState } from './fake-supabase.js'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'   // 허용 목록에 없는 계정
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

function note(userId: string, title: string): FakeNote {
  return {
    id: randomUUID(), user_id: userId, type: 'project', title, content: `${title} 본문`,
    date: null, folder: null, file_path: `Notes/${title}.md`,
    tags: [], mentions: [], backlinks: [], created_at: 1, updated_at: 1,
  }
}

let state: FakeState
let base: string
let close: () => Promise<void>

test.before(async () => {
  state = emptyState()
  state.users.set(A, { id: A, email: 'a@example.com' })
  state.users.set(B, { id: B, email: 'b@example.com' })
  state.users.set(C, { id: C, email: 'c@example.com' })
  state.notes.push(note(A, 'A의 비밀 노트'), note(B, 'B의 비밀 노트'), note(C, 'C의 비밀 노트'))

  const fake = await startFakeSupabase(state)
  process.env.SUPABASE_URL = fake.url
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key'
  process.env.MCP_SESSION_KEY = Buffer.alloc(32, 5).toString('base64')
  process.env.MCP_ALLOW_INSECURE = '1'
  process.env.MCP_RATE_LIMIT = '100000'
  process.env.MCP_ALLOWED_EMAILS = 'a@example.com,b@example.com'

  const { handleRequest } = await import('../src/http.js')
  const srv = createServer((req, res) => { void handleRequest(req, res) })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error('포트 확보 실패')
  base = `http://127.0.0.1:${addr.port}`
  process.env.MCP_PUBLIC_URL = base
  close = async () => {
    await new Promise<void>(r => srv.close(() => r()))
    await fake.close()
  }
})
test.after(async () => { await close() })

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

const verifierOf = () => randomBytes(32).toString('base64url')
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url')

async function register(body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: 'Claude', ...body }),
  })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const u = new URL(`${base}/authorize`)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', CLAUDE_CALLBACK)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', 'st-123')
  u.searchParams.set('resource', `${base}/mcp`)
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
  return u.toString()
}

/** /authorize → 구글 로그인(가짜) → 콜백까지. 콜백 응답을 돌려준다. */
async function loginUntilCallback(userId: string | undefined, clientId: string, challenge: string) {
  const a = await fetch(authorizeUrl(clientId, challenge), { redirect: 'manual' })
  assert.equal(a.status, 302, '/authorize 는 Supabase 로그인으로 보내야 한다')
  const cookie = a.headers.getSetCookie().find(c => c.startsWith('np_oauth_pending='))!.split(';')[0]
  state.nextLoginUser = userId
  const g = await fetch(a.headers.get('location')!, { redirect: 'manual' })
  assert.equal(g.status, 302)
  const cb = await fetch(g.headers.get('location')!, { redirect: 'manual', headers: { Cookie: cookie } })
  return { cb, html: cb.status === 200 ? await cb.text() : '', cookie }
}

const nonceIn = (html: string) => /name="nonce" value="([^"]+)"/.exec(html)?.[1]

async function consent(nonce: string, decision: 'allow' | 'deny', headers: Record<string, string> = {}) {
  return fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ nonce, decision }).toString(),
  })
}

async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params).toString(),
  })
  return { status: res.status, body: await res.json() as Record<string, any>, headers: res.headers }
}

/** 처음부터 끝까지: 등록 → 로그인 → 허용 → 코드. 코드 교환 직전 상태를 돌려준다. */
async function flowUntilCode(userId: string) {
  const { body: client } = await register()
  const verifier = verifierOf()
  const { html } = await loginUntilCallback(userId, client.client_id, challengeOf(verifier))
  const back = await consent(nonceIn(html)!, 'allow')
  assert.equal(back.status, 302)
  const loc = new URL(back.headers.get('location')!)
  return { clientId: client.client_id as string, verifier, code: loc.searchParams.get('code')!, loc }
}

async function fullFlow(userId: string) {
  const f = await flowUntilCode(userId)
  const t = await token({
    grant_type: 'authorization_code', code: f.code, redirect_uri: CLAUDE_CALLBACK,
    code_verifier: f.verifier, client_id: f.clientId,
  })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  return { ...f, tokens: t.body }
}

async function mcp(accessToken: string | undefined, method = 'tools/call', params: unknown = { name: 'list_recent', arguments: {} }) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const raw = await res.text()
  const jsonText = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5).trim() : raw
  let payload: any
  try { payload = JSON.parse(jsonText) } catch { /* noop */ }
  return {
    status: res.status, raw, www: res.headers.get('www-authenticate') ?? '',
    text: payload?.result?.content?.map((c: any) => c.text).join('\n') ?? '',
  }
}

// ── 발견(discovery) ──────────────────────────────────────────────────────────

test('토큰 없이 /mcp → 401 + 메타데이터 위치 (클라이언트가 여기서 OAuth 를 시작)', async () => {
  const r = await mcp(undefined)
  assert.equal(r.status, 401)
  assert.match(r.www, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/)
  assert.doesNotMatch(r.raw, /비밀 노트/)
})

test('메타데이터: 보호 자원(RFC 9728) + 인가 서버(RFC 8414)', async () => {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as any
  assert.equal(prm.resource, `${base}/mcp`)
  assert.deepEqual(prm.authorization_servers, [base])
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as any
  assert.equal(as.issuer, base)
  assert.equal(as.token_endpoint, `${base}/token`)
  assert.equal(as.registration_endpoint, `${base}/register`)
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
})

// ── 등록 ─────────────────────────────────────────────────────────────────────

test('등록: Claude 콜백은 받는다', async () => {
  const r = await register()
  assert.equal(r.status, 201)
  assert.match(r.body.client_id, /^npc_/)
  assert.equal(r.body.token_endpoint_auth_method, 'none')
})

test('등록: 허용 목록 밖 redirect_uri 는 거부 (남의 코드를 받아가는 통로 차단)', async () => {
  for (const uri of ['https://evil.example/cb', 'javascript:alert(1)', 'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai.evil.example/cb', 'https://user:pw@claude.ai/cb']) {
    const r = await register({ redirect_uris: [uri] })
    assert.equal(r.status, 400, uri)
    assert.equal(r.body.error, 'invalid_redirect_uri', uri)
  }
})

// ── 정상 흐름 + 격리 ─────────────────────────────────────────────────────────

test('정상 흐름: A 는 OAuth 로 받은 토큰으로 자기 노트만 본다', async () => {
  const { tokens, loc } = await fullFlow(A)
  assert.equal(loc.searchParams.get('state'), 'st-123', 'state 는 그대로 돌아와야 한다')
  assert.equal(loc.searchParams.get('iss'), base, 'RFC 9207 iss')
  assert.match(tokens.access_token, /^npmat_/)
  assert.match(tokens.refresh_token, /^npmrt_/)
  assert.equal(tokens.token_type, 'Bearer')
  assert.equal(tokens.expires_in, 3600)

  const r = await mcp(tokens.access_token)
  assert.equal(r.status, 200)
  assert.match(r.text, /A의 비밀 노트/)
  assert.doesNotMatch(r.text, /B의 비밀 노트|C의 비밀 노트/)
})

test('사용자 간 격리: A 와 B 가 각자 연결해도 섞이지 않는다', async () => {
  const a = await fullFlow(A)
  const b = await fullFlow(B)
  for (const [tok, mine, theirs] of [
    [a.tokens.access_token, /A의 비밀 노트/, /B의 비밀 노트/],
    [b.tokens.access_token, /B의 비밀 노트/, /A의 비밀 노트/],
    [a.tokens.access_token, /A의 비밀 노트/, /B의 비밀 노트/],
  ] as const) {
    const r = await mcp(tok as string)
    assert.match(r.text, mine as RegExp)
    assert.doesNotMatch(r.text, theirs as RegExp)
  }
})

// ── 코드 교환 공격 ───────────────────────────────────────────────────────────

test('같은 코드는 두 번 쓸 수 없다', async () => {
  const f = await flowUntilCode(A)
  const params = { grant_type: 'authorization_code', code: f.code, redirect_uri: CLAUDE_CALLBACK, code_verifier: f.verifier, client_id: f.clientId }
  assert.equal((await token(params)).status, 200)
  const again = await token(params)
  assert.equal(again.status, 400)
  assert.equal(again.body.error, 'invalid_grant')
})

test('PKCE: 틀린 verifier 는 거절, 그래도 코드는 타지 않아 정당한 클라이언트는 성공', async () => {
  const f = await flowUntilCode(A)
  const base_ = { grant_type: 'authorization_code', code: f.code, redirect_uri: CLAUDE_CALLBACK, client_id: f.clientId }
  const wrong = await token({ ...base_, code_verifier: verifierOf() })
  assert.equal(wrong.status, 400)
  assert.equal(wrong.body.error, 'invalid_grant')
  const right = await token({ ...base_, code_verifier: f.verifier })
  assert.equal(right.status, 200)
})

test('코드를 가로챈 다른 클라이언트·다른 redirect_uri 로는 교환 불가', async () => {
  const f = await flowUntilCode(A)
  const { body: other } = await register()
  const asOther = await token({ grant_type: 'authorization_code', code: f.code, redirect_uri: CLAUDE_CALLBACK, code_verifier: f.verifier, client_id: other.client_id })
  assert.equal(asOther.body.error, 'invalid_grant')
  const { body: multi } = await register({ redirect_uris: [CLAUDE_CALLBACK, 'https://claude.com/api/mcp/auth_callback'] })
  void multi
  const wrongRedirect = await token({ grant_type: 'authorization_code', code: f.code, redirect_uri: 'https://claude.com/api/mcp/auth_callback', code_verifier: f.verifier, client_id: f.clientId })
  assert.equal(wrongRedirect.body.error, 'invalid_grant')
})

test('위조된 client_id 는 invalid_client', async () => {
  const t = await token({ grant_type: 'authorization_code', code: 'x', code_verifier: verifierOf(), client_id: 'npc_forged' })
  assert.equal(t.status, 401)
  assert.equal(t.body.error, 'invalid_client')
})

// ── /authorize 는 오픈 리다이렉터가 아니다 ───────────────────────────────────

test('/authorize: 모르는 client 나 등록 안 된 redirect_uri 면 리다이렉트하지 않는다', async () => {
  const { body: client } = await register()
  const badClient = await fetch(authorizeUrl('npc_nope', challengeOf(verifierOf())), { redirect: 'manual' })
  assert.equal(badClient.status, 400)
  assert.equal(badClient.headers.get('location'), null)
  const badRedirect = await fetch(authorizeUrl(client.client_id, challengeOf(verifierOf()), { redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' })
  assert.equal(badRedirect.status, 400)
  assert.equal(badRedirect.headers.get('location'), null, 'evil.example 로 보내면 안 된다')
})

test('/authorize: PKCE 없으면 클라이언트로 invalid_request', async () => {
  const { body: client } = await register()
  const u = new URL(authorizeUrl(client.client_id, 'x'))
  u.searchParams.delete('code_challenge')
  const r = await fetch(u, { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(new URL(r.headers.get('location')!).searchParams.get('error'), 'invalid_request')
})

// ── 로그인·동의 단계 ─────────────────────────────────────────────────────────

test('허용 목록에 없는 계정은 동의 화면까지 가지 못한다', async () => {
  const before = state.tokens.size
  const { body: client } = await register()
  const { cb } = await loginUntilCallback(C, client.client_id, challengeOf(verifierOf()))
  assert.equal(cb.status, 302)
  assert.equal(new URL(cb.headers.get('location')!).searchParams.get('error'), 'access_denied')
  assert.equal(state.tokens.size, before, '토큰 행이 생기면 안 된다')
})

test('거부하면 코드 없이 access_denied 로 돌아가고, 그 nonce 는 다시 못 쓴다', async () => {
  const { body: client } = await register()
  const { html } = await loginUntilCallback(A, client.client_id, challengeOf(verifierOf()))
  const nonce = nonceIn(html)!
  const denied = await consent(nonce, 'deny')
  const loc = new URL(denied.headers.get('location')!)
  assert.equal(loc.searchParams.get('error'), 'access_denied')
  assert.equal(loc.searchParams.get('code'), null)
  const retry = await consent(nonce, 'allow')
  assert.equal(retry.status, 400)
})

test('허용 nonce 도 한 번뿐 (새로고침·재전송으로 코드가 두 번 나오지 않는다)', async () => {
  const { body: client } = await register()
  const { html } = await loginUntilCallback(A, client.client_id, challengeOf(verifierOf()))
  const nonce = nonceIn(html)!
  assert.equal((await consent(nonce, 'allow')).status, 302)
  assert.equal((await consent(nonce, 'allow')).status, 400)
})

test('동의 화면: client_name 의 HTML 은 이스케이프된다 (XSS)', async () => {
  const { body: client } = await register({ client_name: '<script>alert(1)</script>' })
  const { html } = await loginUntilCallback(A, client.client_id, challengeOf(verifierOf()))
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('동의 화면: 다른 사이트에 끼워 넣을 수 없다 (클릭재킹)', async () => {
  const { body: client } = await register()
  const { cb } = await loginUntilCallback(A, client.client_id, challengeOf(verifierOf()))
  assert.equal(cb.headers.get('x-frame-options'), 'DENY')
  assert.match(cb.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
})

test('동의 POST: 다른 사이트(Origin)에서 보낸 승인은 거절', async () => {
  const { body: client } = await register()
  const { html } = await loginUntilCallback(A, client.client_id, challengeOf(verifierOf()))
  const r = await consent(nonceIn(html)!, 'allow', { Origin: 'https://evil.example' })
  assert.equal(r.status, 403)
})

test('콜백: 대기 쿠키가 없거나 위조되면 거절', async () => {
  const none = await fetch(`${base}/oauth/callback?code=x`, { redirect: 'manual' })
  assert.equal(none.status, 400)
  const forged = await fetch(`${base}/oauth/callback?code=x`, { redirect: 'manual', headers: { Cookie: 'np_oauth_pending=v1.AAAA.BBBB.CCCC' } })
  assert.equal(forged.status, 400)
})

// ── 갱신·만료 ────────────────────────────────────────────────────────────────

test('리프레시: 새 토큰 발급, 옛 리프레시·옛 접근 토큰은 즉시 무효', async () => {
  const f = await fullFlow(A)
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: f.clientId })
  assert.equal(r1.status, 200)
  assert.notEqual(r1.body.refresh_token, f.tokens.refresh_token)

  const reuse = await token({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: f.clientId })
  assert.equal(reuse.body.error, 'invalid_grant', '옛 리프레시 토큰 재사용은 막혀야 한다')

  assert.equal((await mcp(f.tokens.access_token)).status, 401, '옛 접근 토큰')
  const fresh = await mcp(r1.body.access_token)
  assert.equal(fresh.status, 200)
  assert.match(fresh.text, /A의 비밀 노트/)
})

test('만료된 접근 토큰 → 401 + error="invalid_token" (클라이언트가 refresh 하도록)', async () => {
  const f = await fullFlow(A)
  for (const row of state.tokens.values()) {
    if (row.refresh_hash && row.user_id === A) row.token_expires_at = Date.now() - 1000
  }
  const r = await mcp(f.tokens.access_token)
  assert.equal(r.status, 401)
  assert.match(r.www, /error="invalid_token"/)
})

test('기밀 클라이언트: client_secret 이 틀리면 invalid_client', async () => {
  const { body: client } = await register({ token_endpoint_auth_method: 'client_secret_post' })
  assert.ok(client.client_secret)
  const verifier = verifierOf()
  const { html } = await loginUntilCallback(A, client.client_id, challengeOf(verifier))
  const loc = new URL((await consent(nonceIn(html)!, 'allow')).headers.get('location')!)
  const params = { grant_type: 'authorization_code', code: loc.searchParams.get('code')!, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier, client_id: client.client_id }
  const wrong = await token({ ...params, client_secret: 'nope' })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.body.error, 'invalid_client')
  const right = await token({ ...params, client_secret: client.client_secret })
  assert.equal(right.status, 200)
})

test('토큰 응답은 캐시되지 않는다', async () => {
  const f = await flowUntilCode(A)
  const t = await token({ grant_type: 'authorization_code', code: f.code, redirect_uri: CLAUDE_CALLBACK, code_verifier: f.verifier, client_id: f.clientId })
  assert.equal(t.headers.get('cache-control'), 'no-store')
})
