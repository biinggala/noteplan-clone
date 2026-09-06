/**
 * PAT(개인 접속 토큰) 생성·해시와, 서버가 보관하는 Supabase 세션의 봉인.
 *
 * 왜 봉인하나: 원격 서버는 사용자를 대신해 Supabase에 접속해야 하므로
 * refresh token을 들고 있어야 한다(로컬 stdio 버전은 각자 자기 컴퓨터에만
 * 뒀다 — URL로 여는 순간 이 신뢰 경계가 옮겨간다. SECURITY.md 1항).
 * DB 테이블이 새더라도 토큰이 바로 쓰이지 않게, 서버 환경변수에만 있는
 * 키로 AES-256-GCM 암호화해서 저장한다.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

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
