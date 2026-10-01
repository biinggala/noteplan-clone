/**
 * 요청 본문 읽기 (JSON / form). http.ts 와 oauth-server.ts 가 함께 쓴다.
 *
 * 앞단(서버리스 런타임, express.json 등)이 이미 본문을 파싱했으면 스트림은
 * 비어 있다. 그걸 모르고 스트림만 읽으면 body가 undefined 로 넘어가
 * "요청 본문이 없다"는 엉뚱한 오류가 난다. 그래서 req.body 를 먼저 본다.
 */
import type { IncomingMessage } from 'node:http'
import { AuthError } from './remote-auth.js'

export const MAX_BODY_BYTES = 1024 * 1024   // 1MB — 메모리 고갈 방어

/** 원문 문자열, 또는 앞단이 이미 파싱한 객체 */
async function readRaw(req: IncomingMessage): Promise<string | Record<string, unknown> | undefined> {
  const preparsed = (req as IncomingMessage & { body?: unknown }).body
  if (preparsed !== undefined && preparsed !== null && preparsed !== '') {
    if (typeof preparsed === 'string') return preparsed
    if (typeof preparsed === 'object') return preparsed as Record<string, unknown>
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new AuthError('요청 본문이 너무 큽니다', 413)
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req)
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    // 깨진 JSON은 서버 오류가 아니라 잘못된 요청이다
    throw new AuthError('본문이 올바른 JSON이 아닙니다', 400)
  }
}

/** OAuth 표준은 application/x-www-form-urlencoded. 관대하게 JSON 도 받는다. */
export async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readRaw(req)
  if (raw === undefined) return {}
  if (typeof raw !== 'string') {
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]))
  }
  const type = String(req.headers['content-type'] ?? '')
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
    } catch {
      throw new AuthError('본문이 올바른 JSON이 아닙니다', 400)
    }
  }
  return Object.fromEntries(new URLSearchParams(raw))
}
