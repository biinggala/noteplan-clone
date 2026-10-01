/**
 * PAT(개인 접속 토큰) 생성·해시와, 서버가 보관하는 Supabase 세션의 봉인.
 *
 * 왜 봉인하나: 원격 서버는 사용자를 대신해 Supabase에 접속해야 하므로
 * refresh token을 들고 있어야 한다(로컬 stdio 버전은 각자 자기 컴퓨터에만
 * 뒀다 — URL로 여는 순간 이 신뢰 경계가 옮겨간다. SECURITY.md 1항).
 * DB 테이블이 새더라도 토큰이 바로 쓰이지 않게, 서버 환경변수에만 있는
 * 키로 AES-256-GCM 암호화해서 저장한다.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const PAT_PREFIX = 'npmcp_'
const KEY_ENV = 'MCP_SESSION_KEY'

/** 256비트 난수 → 추측 불가. 그래서 해시는 bcrypt 같은 느린 KDF가 필요없다. */
export function generatePat(): string {
  return PAT_PREFIX + randomBytes(32).toString('base64url')
}

/** DB에는 원문이 아니라 이 해시만 저장한다 (테이블이 새도 토큰 자체는 안 샌다). */
export function hashPat(pat: string): string {
  return createHash('sha256').update(pat, 'utf8').digest('hex')
}

function sessionKey(): Buffer {
  const raw = process.env[KEY_ENV]
  if (!raw) {
    throw new Error(
      `${KEY_ENV} 환경변수가 필요합니다. ` +
      `openssl rand -base64 32 로 만들어 서버 환경에만 두세요.`,
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} 는 base64로 인코딩된 32바이트여야 합니다 (지금 ${key.length}바이트)`)
  }
  return key
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.')
}

export function unseal(sealed: string): string {
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('세션 암호문 형식이 아닙니다')
  const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  // GCM 인증 태그가 안 맞으면 final()이 throw → 위조·손상된 암호문은 여기서 걸린다
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
}

// ── OAuth 용 ────────────────────────────────────────────────────────────────

/** 접두사로 종류를 구분하는 불투명 난수 토큰 (접근 npmat_, 리프레시 npmrt_, 코드 npmcd_ …) */
export function randomToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

/** PKCE S256: base64url(SHA-256(verifier)) — RFC 7636 */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/**
 * 용도가 박힌 봉인. 봉인된 값은 브라우저·클라이언트를 거쳐 다시 돌아오므로,
 * "클라이언트 등록용으로 만든 봉인을 로그인 대기 쿠키로 들이미는" 식의
 * 바꿔치기를 막으려고 typ 을 넣고 열 때 확인한다. 만료(exp)도 같이 본다.
 */
export function sealTyped(typ: string, payload: Record<string, unknown>, ttlSeconds?: number): string {
  const exp = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : undefined
  return seal(JSON.stringify({ ...payload, typ, exp }))
}

export function unsealTyped<T extends Record<string, unknown>>(typ: string, sealed: string): T | null {
  try {
    const value = JSON.parse(unseal(sealed)) as T & { typ?: string; exp?: number }
    if (value.typ !== typ) return null
    if (typeof value.exp === 'number' && value.exp < Math.floor(Date.now() / 1000)) return null
    return value
  } catch {
    return null   // 위조·손상·키 교체 — 구분해 알려줄 필요 없다
  }
}

/**
 * 기밀 클라이언트(client_secret_post/basic)의 비밀값. 저장하지 않고 서버 키로
 * 매번 다시 계산한다 — 클라이언트 등록 정보를 DB에 두지 않기 위해서다.
 */
export function clientSecretFor(clientId: string): string {
  const raw = process.env.MCP_SESSION_KEY ?? ''
  return createHmac('sha256', Buffer.from(raw, 'base64')).update(`client-secret:${clientId}`).digest('base64url')
}

/** 길이가 달라도 시간차로 새지 않는 비교 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}
