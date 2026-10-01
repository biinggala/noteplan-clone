/**
 * 공식 MCP SDK 클라이언트로 검증.
 *
 * oauth.test.ts 는 제가 쓴 클라이언트라 "제가 이해한 스펙"끼리만 맞을 수 있다.
 * 여기서는 SDK 의 StreamableHTTPClientTransport + OAuthClientProvider — 실제 MCP
 * 클라이언트가 쓰는 구현 — 가 메타데이터 탐색, 동적 등록, PKCE, 코드 교환,
 * 만료 시 자동 refresh 까지 이 서버와 끝까지 대화할 수 있는지 본다.
 * (SDK 는 메타데이터·토큰 응답을 zod 스키마로 검증한다)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { emptyState, startFakeSupabase, type FakeState } from './fake-supabase.js'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

class MemoryProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed
  stored?: OAuthTokens
  verifier?: string
  authUrl?: URL
  get redirectUrl() { return CALLBACK }
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [CALLBACK], client_name: 'SDK 테스트 클라이언트',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  clientInformation() { return this.info }
  saveClientInformation(info: OAuthClientInformationMixed) { this.info = info }
  tokens() { return this.stored }
  saveTokens(t: OAuthTokens) { this.stored = t }
  redirectToAuthorization(url: URL) { this.authUrl = url }
  saveCodeVerifier(v: string) { this.verifier = v }
  codeVerifier() { return this.verifier! }
}

let state: FakeState
let base: string
let close: () => Promise<void>

test.before(async () => {
  state = emptyState()
  state.users.set(A, { id: A, email: 'a@example.com' })
  state.users.set(B, { id: B, email: 'b@example.com' })
  for (const [uid, title] of [[A, 'A의 비밀 노트'], [B, 'B의 비밀 노트']] as const) {
    state.notes.push({
      id: randomUUID(), user_id: uid, type: 'project', title, content: '본문',
      date: null, folder: null, file_path: `Notes/${title}.md`,
      tags: [], mentions: [], backlinks: [], created_at: 1, updated_at: 1,
    })
  }
  const fake = await startFakeSupabase(state)
  process.env.SUPABASE_URL = fake.url
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key'
  process.env.MCP_SESSION_KEY = Buffer.alloc(32, 3).toString('base64')
  process.env.MCP_ALLOW_INSECURE = '1'
  process.env.MCP_RATE_LIMIT = '100000'

  const { handleRequest } = await import('../src/http.js')
  const srv = createServer((req, res) => { void handleRequest(req, res) })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error('포트 확보 실패')
  base = `http://127.0.0.1:${addr.port}`
  process.env.MCP_PUBLIC_URL = base
  close = async () => { await new Promise<void>(r => srv.close(() => r())); await fake.close() }
})
test.after(async () => { await close() })

/** 브라우저 역할: 인가 URL → 구글 로그인(가짜) → 동의 [허용] → 콜백의 code */
async function browserApproves(authUrl: URL, userId: string): Promise<string> {
  const a = await fetch(authUrl, { redirect: 'manual' })
  assert.equal(a.status, 302, `authorize 실패: ${a.status} ${await a.clone().text()}`)
  const cookie = a.headers.getSetCookie().find(c => c.startsWith('np_oauth_pending='))!.split(';')[0]
  state.nextLoginUser = userId
  const g = await fetch(a.headers.get('location')!, { redirect: 'manual' })
  const cb = await fetch(g.headers.get('location')!, { redirect: 'manual', headers: { Cookie: cookie } })
  const html = await cb.text()
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1]
  assert.ok(nonce, `동의 화면이 안 나옴: ${cb.status}`)
  const consent = await fetch(`${base}/oauth/consent`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce, decision: 'allow' }).toString(),
  })
  const back = new URL(consent.headers.get('location')!)
  assert.equal(back.origin + back.pathname, CALLBACK)
  return back.searchParams.get('code')!
}

async function connectWithOAuth(userId: string) {
  const provider = new MemoryProvider()
  const url = new URL(`${base}/mcp`)

  // 1) 토큰 없이 연결 → SDK 가 401 을 보고 탐색·등록 후 브라우저로 보내려 한다
  const first = new StreamableHTTPClientTransport(url, { authProvider: provider })
  await assert.rejects(new Client({ name: 't', version: '1' }).connect(first), UnauthorizedError)
  assert.ok(provider.info?.client_id, 'SDK 가 동적 등록(DCR)을 마쳤어야 한다')
  assert.ok(provider.authUrl, 'SDK 가 인가 URL 을 만들었어야 한다')
  assert.equal(provider.authUrl.searchParams.get('code_challenge_method'), 'S256')

  // 2) 사용자가 브라우저에서 승인 → 3) SDK 가 코드 교환
  const code = await browserApproves(provider.authUrl, userId)
  await first.finishAuth(code)
  assert.ok(provider.stored?.access_token, 'SDK 가 토큰을 저장했어야 한다')

  // 4) 토큰으로 정식 연결
  const client = new Client({ name: 't', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))
  return { client, provider }
}

const textOf = (r: unknown) =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map(c => c.text ?? '').join('\n')

test('SDK 클라이언트: 탐색 → 등록 → 승인 → 교환 → 도구 호출까지 끝까지 된다', async () => {
  const { client } = await connectWithOAuth(A)
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 9)
  const r = await client.callTool({ name: 'list_recent', arguments: {} })
  assert.match(textOf(r), /A의 비밀 노트/)
  assert.doesNotMatch(textOf(r), /B의 비밀 노트/)
  await client.close()
})

test('SDK 클라이언트: 접근 토큰이 만료되면 스스로 refresh 하고 계속 쓴다', async () => {
  const { client, provider } = await connectWithOAuth(A)
  const before = provider.stored!.access_token
  // 서버 쪽에서 이 연결의 접근 토큰을 만료시킨다 (1시간이 지난 상황)
  for (const row of state.tokens.values()) {
    if (row.refresh_hash && row.user_id === A) row.token_expires_at = Date.now() - 1000
  }
  const r = await client.callTool({ name: 'list_recent', arguments: {} })
  assert.match(textOf(r), /A의 비밀 노트/)
  assert.notEqual(provider.stored!.access_token, before, 'SDK 가 새 접근 토큰을 받아 저장했어야 한다')
  await client.close()
})

test('SDK 클라이언트: 두 사용자가 각자 연결해도 섞이지 않는다', async () => {
  const a = await connectWithOAuth(A)
  const b = await connectWithOAuth(B)
  assert.match(textOf(await b.client.callTool({ name: 'list_recent', arguments: {} })), /B의 비밀 노트/)
  assert.doesNotMatch(textOf(await b.client.callTool({ name: 'list_recent', arguments: {} })), /A의 비밀 노트/)
  assert.doesNotMatch(textOf(await a.client.callTool({ name: 'list_recent', arguments: {} })), /B의 비밀 노트/)
  await a.client.close(); await b.client.close()
})
