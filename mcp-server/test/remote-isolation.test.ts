/**
 * 원격(URL) MCP 서버의 격리 테스트.
 *
 * 이 파일이 답하는 질문: "URL로 열었을 때 특정 유저가 다른 유저의 노트를
 * 볼 수 있는가?" — 가짜 Supabase는 실제 RLS처럼 JWT의 sub로만 행을 보여주므로,
 * 서버가 엉뚱한 세션을 재사용하면 남의 노트가 응답에 섞여 나오고 테스트가 깨진다.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

// 가짜 Supabase를 먼저 띄우고, 그 주소를 env에 넣은 뒤에 서버 모듈을 import 해야 한다
// (supabase.ts 가 모듈 로드 시점에 URL을 읽는다).
import { emptyState, fakeJwt, startFakeSupabase, type FakeNote, type FakeState } from './fake-supabase.js'

const USER_A = '11111111-1111-1111-1111-111111111111'
const USER_B = '22222222-2222-2222-2222-222222222222'

function note(userId: string, title: string, content: string): FakeNote {
  return {
    id: randomUUID(), user_id: userId, type: 'project', title, content,
    date: null, folder: null, file_path: `Notes/${title}.md`,
    tags: [], mentions: [], backlinks: [], created_at: 1, updated_at: 1,
  }
}

interface Harness {
  state: FakeState
  mcpUrl: string
  enrollUrl: string
  patA: string
  patB: string
  patRevoked: string
  noteB: FakeNote
  close: () => Promise<void>
}

async function setup(): Promise<Harness> {
  const state = emptyState()
  state.users.set(USER_A, { id: USER_A, email: 'a@example.com' })
  state.users.set(USER_B, { id: USER_B, email: 'b@example.com' })
  state.refreshTokens.set('refresh-A', USER_A)
  state.refreshTokens.set('refresh-B', USER_B)

  const noteA = note(USER_A, 'A의 비밀 노트', '#journal A만 볼 수 있어야 하는 내용')
  const noteB = note(USER_B, 'B의 비밀 노트', '#journal B만 볼 수 있어야 하는 내용')
  state.notes.push(noteA, noteB)

  const fake = await startFakeSupabase(state)
  process.env.SUPABASE_URL = fake.url
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key'
  process.env.MCP_SESSION_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.MCP_ALLOW_INSECURE = '1'   // 테스트는 평문 HTTP
  process.env.MCP_RATE_LIMIT = '10000'
  process.env.MCP_ALLOWED_EMAILS = 'a@example.com'   // B는 등록 거부돼야 한다

  const { hashPat, seal, generatePat } = await import('../src/crypto.js')
  const { handleRequest } = await import('../src/http.js')

  const patA = generatePat()
  const patB = generatePat()
  const patRevoked = generatePat()
  state.tokens.set(hashPat(patA), { user_id: USER_A, session_cipher: seal(JSON.stringify({ refresh_token: 'refresh-A' })) })
  state.tokens.set(hashPat(patB), { user_id: USER_B, session_cipher: seal(JSON.stringify({ refresh_token: 'refresh-B' })) })
  state.tokens.set(hashPat(patRevoked), { user_id: USER_A, session_cipher: seal(JSON.stringify({ refresh_token: 'refresh-A' })), revoked: true })

  const mcp = createServer((req, res) => { void handleRequest(req, res) })
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve))
  const addr = mcp.address()
  if (!addr || typeof addr === 'string') throw new Error('포트 확보 실패')

  return {
    state, patA, patB, patRevoked, noteB,
    mcpUrl: `http://127.0.0.1:${addr.port}/mcp`,
    enrollUrl: `http://127.0.0.1:${addr.port}/enroll`,
    close: async () => {
      await new Promise<void>(resolve => mcp.close(() => resolve()))
      await fake.close()
    },
  }
}

let h: Harness
test.before(async () => { h = await setup() })
test.after(async () => { await h.close() })

async function callTool(pat: string | undefined, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(h.mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const raw = await res.text()
  // stateless 모드는 SSE 로 한 건 흘려보낼 수 있어 두 형식 모두 받아준다
  const jsonText = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5).trim()
    : raw
  let payload: any = undefined
  try { payload = JSON.parse(jsonText) } catch { /* 오류 응답이 JSON이 아닐 수도 */ }
  const toolText = payload?.result?.content?.map((c: any) => c.text).join('\n') ?? ''
  return { status: res.status, headers: res.headers, payload, toolText, raw }
}

test('Authorization 헤더가 없으면 401 + WWW-Authenticate', async () => {
  const r = await callTool(undefined, 'list_recent')
  assert.equal(r.status, 401)
  assert.match(r.headers.get('www-authenticate') ?? '', /Bearer/)
  assert.ok(!r.raw.includes('비밀 노트'), '인증 없이 노트 내용이 새면 안 된다')
})

test('아무 토큰이나 넣으면 401 (존재하지 않는 PAT)', async () => {
  const r = await callTool('npmcp_' + 'x'.repeat(43), 'list_recent')
  assert.equal(r.status, 401)
})

test('취소된 토큰은 401', async () => {
  const r = await callTool(h.patRevoked, 'list_recent')
  assert.equal(r.status, 401)
})

test('각 PAT는 자기 노트만 본다', async () => {
  const a = await callTool(h.patA, 'list_recent')
  assert.equal(a.status, 200)
  assert.match(a.toolText, /A의 비밀 노트/)
  assert.doesNotMatch(a.toolText, /B의 비밀 노트/)

  const b = await callTool(h.patB, 'list_recent')
  assert.equal(b.status, 200)
  assert.match(b.toolText, /B의 비밀 노트/)
  assert.doesNotMatch(b.toolText, /A의 비밀 노트/)
})

test('교차 순서로 불러도 세션이 섞이지 않는다 (전역 싱글턴 회귀 테스트)', async () => {
  for (const [pat, mine, theirs] of [
    [h.patA, /A의 비밀 노트/, /B의 비밀 노트/],
    [h.patB, /B의 비밀 노트/, /A의 비밀 노트/],
    [h.patA, /A의 비밀 노트/, /B의 비밀 노트/],
    [h.patB, /B의 비밀 노트/, /A의 비밀 노트/],
  ] as const) {
    const r = await callTool(pat as string, 'search_notes', { query: '비밀' })
    assert.match(r.toolText, mine as RegExp)
    assert.doesNotMatch(r.toolText, theirs as RegExp)
  }
})

test('동시 요청에서도 섞이지 않는다', async () => {
  const results = await Promise.all([
    callTool(h.patA, 'list_recent'),
    callTool(h.patB, 'list_recent'),
    callTool(h.patA, 'list_recent'),
    callTool(h.patB, 'list_recent'),
  ])
  assert.match(results[0].toolText, /A의 비밀 노트/)
  assert.doesNotMatch(results[0].toolText, /B의/)
  assert.match(results[1].toolText, /B의 비밀 노트/)
  assert.doesNotMatch(results[1].toolText, /A의/)
  assert.match(results[2].toolText, /A의 비밀 노트/)
  assert.match(results[3].toolText, /B의 비밀 노트/)
})

test('남의 노트 id를 직접 지정해도 못 읽는다', async () => {
  const r = await callTool(h.patA, 'get_note', { id: h.noteB.id })
  assert.equal(r.status, 200)
  assert.match(r.toolText, /노트를 찾지 못함/)
  assert.doesNotMatch(r.toolText, /B만 볼 수 있어야/)
})

test('쓰기도 자기 계정으로만 나간다', async () => {
  const before = h.state.notes.length
  const r = await callTool(h.patB, 'create_note', { title: 'B가 만든 노트', content: '본문' })
  assert.equal(r.status, 200)
  assert.equal(h.state.notes.length, before + 1)
  const created = h.state.notes[h.state.notes.length - 1]
  assert.equal(created.user_id, USER_B, '삽입된 행의 소유자가 요청자와 같아야 한다')
})

test('notes 쿼리는 언제나 요청자 JWT로 나갔다 (감사 로그)', () => {
  const users = new Set(h.state.queryLog.filter(q => q.table === 'notes').map(q => q.asUser))
  for (const u of users) assert.ok(u === USER_A || u === USER_B, `예상 밖 사용자: ${u}`)
  assert.ok(!users.has(null), '익명(JWT 없음)으로 notes 를 읽은 요청이 있으면 안 된다')
  // 두 사용자가 모두 등장해야 한다 — 한쪽만 있으면 세션이 한 명으로 고정된 것
  // (클라이언트를 전역 캐시했을 때 정확히 이 assert 가 깨진다)
  assert.ok(users.has(USER_A) && users.has(USER_B), '요청자별로 다른 세션이 쓰였어야 한다')
})

test('GET /mcp 는 405 (stateless — SSE 스트림 없음)', async () => {
  const res = await fetch(h.mcpUrl, { method: 'GET', headers: { Authorization: `Bearer ${h.patA}` } })
  assert.equal(res.status, 405)
})

// ── /enroll ────────────────────────────────────────────────────────────────

test('등록: 허용 목록에 없는 계정은 403 (토큰도 안 생긴다)', async () => {
  const before = h.state.tokens.size
  const res = await fetch(h.enrollUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fakeJwt(USER_B, 'b@example.com')}` },
    body: JSON.stringify({ refresh_token: 'refresh-B', label: 'B의 노트북' }),
  })
  assert.equal(res.status, 403)
  assert.equal(h.state.tokens.size, before)
})

test('등록: access token 없이 부르면 401', async () => {
  const res = await fetch(h.enrollUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: 'refresh-A' }),
  })
  assert.equal(res.status, 401)
})

test('등록: 허용된 계정은 PAT를 받고, 그 PAT로 자기 노트만 읽힌다', async () => {
  // 이 refresh token 은 로테이션으로 소모되므로 새로 하나 넣어준다
  h.state.refreshTokens.set('refresh-A2', USER_A)
  const res = await fetch(h.enrollUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fakeJwt(USER_A, 'a@example.com')}` },
    body: JSON.stringify({ refresh_token: 'refresh-A2', label: 'A의 맥북' }),
  })
  assert.equal(res.status, 201)
  const { token } = await res.json() as { token: string }
  assert.match(token, /^npmcp_/)

  const r = await callTool(token, 'list_recent')
  assert.match(r.toolText, /A의 비밀 노트/)
  assert.doesNotMatch(r.toolText, /B의 비밀 노트/)
})

test('등록: 위조한 user_id 는 access token 의 주인을 이길 수 없다', async () => {
  // 클라이언트가 body 에 user_id 를 끼워넣어도 서버는 access token 으로만 판단한다
  h.state.refreshTokens.set('refresh-A3', USER_A)
  const res = await fetch(h.enrollUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fakeJwt(USER_A, 'a@example.com')}` },
    body: JSON.stringify({ refresh_token: 'refresh-A3', user_id: USER_B, label: '사칭 시도' }),
  })
  assert.equal(res.status, 201)
  const { token, user_id: userId } = await res.json() as { token: string; user_id: string }
  assert.equal(userId, USER_A)
  const r = await callTool(token, 'list_recent')
  assert.doesNotMatch(r.toolText, /B의 비밀 노트/)
})

test('등록에 남의 refresh token 을 끼워넣어도 그 사람 노트는 못 읽는다', async () => {
  // A가 (이미 털린) B의 refresh token 을 자기 등록에 밀어넣는 시나리오.
  // 토큰 행의 주인은 A인데 세션은 B가 되므로, 서버는 저장 전에 이를 잡아낸다.
  h.state.refreshTokens.set('refresh-B-stolen', USER_B)
  const res = await fetch(h.enrollUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fakeJwt(USER_A, 'a@example.com')}` },
    body: JSON.stringify({ refresh_token: 'refresh-B-stolen', label: '탈취 시도' }),
  })
  assert.equal(res.status, 201)   // 등록 자체는 막을 수 없다 (본인 계정으로 하는 것이라)
  const { token } = await res.json() as { token: string }

  const r = await callTool(token, 'list_recent')
  assert.notEqual(r.status, 200)
  assert.doesNotMatch(r.raw, /B의 비밀 노트/, 'B의 노트가 응답에 실려선 안 된다')
  assert.doesNotMatch(r.raw, /B만 볼 수 있어야/)
})

test('본문이 깨진 JSON이면 400 (500 아님)', async () => {
  const res = await fetch(h.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.patA}` },
    body: '{ this is not json',
  })
  assert.equal(res.status, 400)
})

// ── MCP 프로토콜 자체 ───────────────────────────────────────────────────────

async function rpc(pat: string, method: string, params: unknown) {
  const res = await fetch(h.mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  })
  const raw = await res.text()
  const jsonText = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5).trim()
    : raw
  return { status: res.status, payload: JSON.parse(jsonText) as any }
}

test('initialize 핸드셰이크가 동작한다 (Claude가 처음 보내는 요청)', async () => {
  const r = await rpc(h.patA, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.payload.result.serverInfo.name, 'noteplan')
  // stateless 라 세션 헤더를 발급하지 않는다
})

test('tools/list 가 도구 9개를 노출한다', async () => {
  const r = await rpc(h.patA, 'tools/list', {})
  assert.equal(r.status, 200)
  const names = (r.payload.result.tools as Array<{ name: string }>).map(t => t.name).sort()
  assert.deepEqual(names, [
    'append_to_daily', 'append_to_note', 'create_note', 'get_backlinks',
    'get_note', 'list_by_tag', 'list_recent', 'search_notes', 'update_note',
  ])
})
