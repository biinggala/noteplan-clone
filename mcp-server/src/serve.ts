#!/usr/bin/env node
/**
 * 표준 Node HTTP 서버로 위 핸들러를 띄운다 (Fly/Railway/Render/로컬 공용).
 * TLS는 앞단 플랫폼이 담당한다 — 직접 노출할 거면 리버스 프록시를 두세요.
 */
import { createServer } from 'node:http'
import { allowedHosts, handleRequest } from './http.js'
import { publicUrl } from './oauth-server.js'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'

// 시작할 때 바로 확인 — 없으면 첫 요청에서야 죽는다
if (!process.env.MCP_SESSION_KEY) {
  console.error('[noteplan-mcp] MCP_SESSION_KEY 가 없습니다. openssl rand -base64 32 로 만들어 주세요.')
  process.exit(1)
}

// SDK의 DNS rebinding 보호는 허용목록이 있을 때만 실제로 검사한다
// (enableDnsRebindingProtection 만 켜고 목록이 비면 아무것도 막지 않는다).
if (!allowedHosts()?.length) {
  console.warn('[noteplan-mcp] 경고: MCP_ALLOWED_HOSTS 가 없어 Host 검사가 비활성입니다 (예: mcp.example.com)')
}
if (process.env.MCP_ALLOW_INSECURE === '1') {
  console.warn('[noteplan-mcp] 경고: MCP_ALLOW_INSECURE=1 — 평문 HTTP 허용. 로컬 테스트에서만 쓰세요.')
}
if (!publicUrl()) {
  console.warn('[noteplan-mcp] 안내: MCP_PUBLIC_URL 미설정 — OAuth(claude.ai·앱 커넥터) 비활성, 헤더 토큰만 가능합니다.')
}
if (!process.env.MCP_ALLOWED_EMAILS) {
  console.warn('[noteplan-mcp] 안내: MCP_ALLOWED_EMAILS 미설정 — 계정이 있는 누구나 등록할 수 있습니다(각자 자기 노트만).')
}

createServer((req, res) => { void handleRequest(req, res) }).listen(port, host, () => {
  console.log(`[noteplan-mcp] listening on http://${host}:${port}  (MCP: POST /mcp, 등록: POST /enroll, OAuth: /.well-known/oauth-authorization-server)`)
})
