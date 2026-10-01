/**
 * 공통 방어: TLS 확인, 요청 제한. /mcp·/enroll 과 OAuth 엔드포인트가 함께 쓴다.
 */
import type { IncomingMessage } from 'node:http'
import { AuthError } from './remote-auth.js'

/** 로컬/테스트에서만 평문 HTTP 허용 */
export const allowInsecure = () => process.env.MCP_ALLOW_INSECURE === '1'

/**
 * TLS 확인. 원격 서버에 PAT와 (등록 시) refresh token이 평문으로 흐르면
 * 중간에서 가져가는 순간 노트 전체를 읽고 쓸 수 있다.
 */
export function requireTls(req: IncomingMessage): void {
  // 주의: x-forwarded-proto 는 앞단 프록시가 정직하게 세팅해 줄 때만 의미가 있다.
  // 프록시 없이 직접 노출하면 공격자가 이 헤더를 위조해 우회할 수 있다 —
  // 이 검사는 "TLS 종단 뒤에 둔다"는 배포 전제의 보조 장치다 (SECURITY.md 7항).
  if (allowInsecure()) return
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true
  if (proto === 'https' || encrypted) return
  throw new AuthError('HTTPS로만 접속할 수 있습니다', 400)
}

// ── 아주 단순한 요청 제한 ────────────────────────────────────────────────────
// 목적은 PAT 대량 추측·RPC 남용 속도를 떨어뜨리는 것. 인스턴스 메모리 기준이라
// 여러 인스턴스로 뜨면 그만큼 느슨해진다 — 앞단(Cloudflare 등)에 두는 게 정석.
const RATE_WINDOW_MS = 60_000
const hits = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(key: string): void {
  const now = Date.now()
  const entry = hits.get(key)
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
    return
  }
  entry.count += 1
  if (entry.count > Number(process.env.MCP_RATE_LIMIT ?? 120)) throw new AuthError('요청이 너무 많습니다', 429)
}

export function clientKey(req: IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return fwd || req.socket.remoteAddress || 'unknown'
}
