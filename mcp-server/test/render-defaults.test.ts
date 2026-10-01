/**
 * Render 에 올렸을 때 손으로 넣을 값을 줄이는 기본값들.
 * Render 는 RENDER_EXTERNAL_URL / RENDER_EXTERNAL_HOSTNAME 을 자동으로 넣어 준다.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

process.env.SUPABASE_URL = 'http://127.0.0.1:9'          // 쓰지 않음 (메타데이터만 본다)
process.env.SUPABASE_ANON_KEY = 'fake'
process.env.MCP_ALLOW_INSECURE = '1'
delete process.env.MCP_PUBLIC_URL
delete process.env.MCP_ALLOWED_HOSTS

const { publicUrl } = await import('../src/oauth-server.js')
const { allowedHosts, handleRequest } = await import('../src/http.js')
const { seal, unseal } = await import('../src/crypto.js')

test('MCP_PUBLIC_URL 이 없으면 Render 가 준 주소를 쓴다', () => {
  process.env.RENDER_EXTERNAL_URL = 'https://noteplan-mcp.onrender.com'
  assert.equal(publicUrl(), 'https://noteplan-mcp.onrender.com')
})

test('직접 지정한 MCP_PUBLIC_URL 이 Render 값보다 우선', () => {
  process.env.RENDER_EXTERNAL_URL = 'https://noteplan-mcp.onrender.com'
  process.env.MCP_PUBLIC_URL = 'https://mcp.example.com/'
  assert.equal(publicUrl(), 'https://mcp.example.com')
  delete process.env.MCP_PUBLIC_URL
})

test('MCP_ALLOWED_HOSTS 가 없으면 Render 호스트명으로 Host 검사', () => {
  process.env.RENDER_EXTERNAL_HOSTNAME = 'noteplan-mcp.onrender.com'
  assert.deepEqual(allowedHosts(), ['noteplan-mcp.onrender.com'])
  process.env.MCP_ALLOWED_HOSTS = 'a.example.com,b.example.com'
  assert.deepEqual(allowedHosts(), ['a.example.com', 'b.example.com'])
  delete process.env.MCP_ALLOWED_HOSTS
})

test('메타데이터의 issuer·resource 가 Render 주소로 나간다', async () => {
  process.env.RENDER_EXTERNAL_URL = 'https://noteplan-mcp.onrender.com'
  process.env.MCP_SESSION_KEY = randomBytes(32).toString('base64')
  const srv = createServer((q, s) => { void handleRequest(q, s) })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  const prm = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).json() as any
  assert.equal(prm.resource, 'https://noteplan-mcp.onrender.com/mcp')
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as any
  assert.equal(health.checks.oauth, true)
  assert.equal(health.checks.allowed_hosts, true)
  await new Promise<void>(r => srv.close(() => r()))
})

test('키: openssl rand -base64 32 형식은 그대로, 다른 형식의 긴 무작위 값도 동작', () => {
  for (const key of [
    randomBytes(32).toString('base64'),        // 기존 방식
    randomBytes(32).toString('base64url'),     // 패딩 없는 url-safe
    randomBytes(32).toString('hex'),           // 64자 hex
    randomBytes(48).toString('base64'),        // 더 긴 값
  ]) {
    process.env.MCP_SESSION_KEY = key
    assert.equal(unseal(seal('비밀')), '비밀', key.length + '자 키')
  }
})

test('키: 기존 32바이트 키로 봉인한 값은 그대로 열린다 (호환)', () => {
  const key = randomBytes(32).toString('base64')
  process.env.MCP_SESSION_KEY = key
  const sealed = seal('예전 세션')
  process.env.MCP_SESSION_KEY = key
  assert.equal(unseal(sealed), '예전 세션')
})

test('키: 너무 짧으면 거절', () => {
  process.env.MCP_SESSION_KEY = 'short'
  assert.throws(() => seal('x'), /너무 짧습니다/)
})
