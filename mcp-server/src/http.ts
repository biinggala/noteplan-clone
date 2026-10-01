/**
 * URL로 붙는 MCP 서버 (Streamable HTTP).
 *
 * 설계 원칙 (SECURITY.md 에 근거와 남은 위험을 정리해 두었다):
 *  1. 요청마다 인증하고, 요청마다 새 MCP 서버·새 Supabase 클라이언트를 만든다.
 *     전역 캐시 금지 — 그게 바로 남의 노트가 보이는 경로다.
 *  2. service_role 키를 쓰지 않는다. 모든 쿼리는 사용자 JWT로 나가고
 *     Postgres RLS가 자기 행에만 묶는다.
 *  3. 세션 상태를 안 만든다(stateless). Mcp-Session-Id 를 발급하지 않으므로
 *     세션 ID 추측·재사용으로 남의 컨텍스트에 올라탈 여지가 없다.
 *  4. DNS rebinding 보호 + Origin 허용목록 (브라우저에서 사설망 서버를 찌르는 공격).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AuthError, clientForPat, enroll } from './remote-auth.js'
import { generatePat, hashPat, PAT_PREFIX } from './crypto.js'
import { registerTools } from './tools.js'
import { readJsonBody } from './body.js'
import { allowInsecure, clientKey, rateLimit, requireTls } from './guard.js'
import { handleOAuth, publicUrl, wwwAuthenticate } from './oauth-server.js'

const MCP_PATH = '/mcp'
const ENROLL_PATH = '/enroll'


/**
 * 등록 허용 이메일. 이 서버는 인터넷에 열려 있고, 계정만 있으면 누구나
 * /enroll 로 자기 PAT를 받아갈 수 있다(자기 노트만 보인다). 그래도 "나와
 * 친구 몇 명"만 쓰는 서버라면 여기서 좁혀두는 편이 낫다 — 비워두면 무제한.
 */
function allowedEmails(): string[] | undefined {
  const raw = process.env.MCP_ALLOWED_EMAILS
  return raw ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : undefined
}

function allowedHosts(): string[] | undefined {
  const raw = process.env.MCP_ALLOWED_HOSTS
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined
}

function allowedOrigins(): string[] | undefined {
  const raw = process.env.MCP_ALLOWED_ORIGINS
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

/** JSON-RPC 규격 오류 (MCP 클라이언트가 알아볼 수 있게) */
function rpcError(res: ServerResponse, status: number, message: string, headers?: Record<string, string>): void {
  json(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers)
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

/** 로그에 토큰 원문을 남기지 않는다 — 로그가 곧 열쇠가 되지 않도록. */
function tokenLabel(pat: string): string {
  return `${PAT_PREFIX}…${pat.slice(-4)}`
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // OAuth 엔드포인트(메타데이터·등록·인가·토큰)는 별도 모듈이 맡는다
  if (await handleOAuth(req, res, url)) return

  try {
    if (url.pathname === '/healthz') {
      // 배포 직후 "무엇이 빠졌는지"를 바로 보기 위한 자기 점검.
      // 값은 절대 내보내지 않는다 — 설정됐는지 여부만.
      const checks = {
        session_key: Boolean(process.env.MCP_SESSION_KEY),
        allowed_hosts: Boolean(process.env.MCP_ALLOWED_HOSTS),
        allowed_emails: Boolean(process.env.MCP_ALLOWED_EMAILS),
        tls_enforced: !allowInsecure(),
        oauth: Boolean(publicUrl()),
      }
      // session_key 가 없으면 등록·접속이 아예 안 된다 → 준비 안 된 상태로 표시
      const ready = checks.session_key
      const warnings: string[] = []
      if (!checks.session_key) warnings.push('MCP_SESSION_KEY 없음 — 등록/접속 불가')
      if (!checks.allowed_hosts) warnings.push('MCP_ALLOWED_HOSTS 없음 — Host 검사 비활성')
      if (!checks.allowed_emails) warnings.push('MCP_ALLOWED_EMAILS 없음 — 계정 있는 누구나 등록 가능')
      if (allowInsecure()) warnings.push('MCP_ALLOW_INSECURE=1 — 평문 HTTP 허용 중')
      if (!publicUrl()) warnings.push('MCP_PUBLIC_URL 없음 — OAuth(claude.ai·앱 커넥터) 비활성, 헤더 토큰만 가능')
      return json(res, ready ? 200 : 503, { ok: ready, checks, warnings })
    }

    if (url.pathname === ENROLL_PATH) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST만 허용' })
      requireTls(req)
      rateLimit(`enroll:${clientKey(req)}`)

      const accessToken = bearer(req)
      if (!accessToken) {
        return json(res, 401, { error: 'Authorization: Bearer <supabase access token> 필요' })
      }
      const body = (await readJsonBody(req)) as { refresh_token?: string; label?: string } | undefined
      if (!body?.refresh_token) return json(res, 400, { error: 'refresh_token 필요' })

      const pat = generatePat()
      const { userId, email } = await enroll(accessToken, body.refresh_token, body.label, pat, allowedEmails())
      console.log(`[noteplan-mcp] enrolled ${email ?? userId} (${tokenLabel(pat)})`)
      // PAT는 이 응답에서 딱 한 번만 나온다 (DB에는 해시만 남는다)
      return json(res, 201, { token: pat, user_id: userId, email })
    }

    if (url.pathname === MCP_PATH) {
      if (req.method !== 'POST') {
        // stateless라 SSE 스트림(GET)·세션 종료(DELETE)는 제공하지 않는다
        return rpcError(res, 405, 'POST만 허용 (stateless 모드)', { Allow: 'POST' })
      }
      requireTls(req)
      rateLimit(`mcp:${clientKey(req)}`)

      const pat = bearer(req)
      if (!pat) {
        return rpcError(res, 401, 'Authorization: Bearer <토큰> 필요', {
          'WWW-Authenticate': wwwAuthenticate(false),
        })
      }
      // 토큰 원문 조각을 키로 쓰지 않는다 (메모리 덤프·디버거에 남지 않게)
      rateLimit(`pat:${hashPat(pat).slice(0, 16)}`)

      const body = await readJsonBody(req)
      // ① 이 요청의 사용자로만 스코프된 클라이언트
      const ctx = await clientForPat(pat)

      // ② 이 요청만 쓰는 MCP 서버 — 도구 클로저가 위 ctx 하나만 본다
      const server = new McpServer({ name: 'noteplan', version: '0.2.0' })
      registerTools(server, ctx)

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,        // stateless
        enableDnsRebindingProtection: true,
        allowedHosts: allowedHosts(),
        allowedOrigins: allowedOrigins(),
      })

      res.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500
    const message = e instanceof Error ? e.message : '알 수 없는 오류'
    if (status >= 500) console.error('[noteplan-mcp]', message)
    if (res.headersSent) { res.end(); return }
    if (url.pathname === MCP_PATH) {
      rpcError(res, status, message, status === 401
        ? { 'WWW-Authenticate': wwwAuthenticate(Boolean(bearer(req))) }
        : undefined)
    } else {
      json(res, status, { error: message })
    }
  }
}
