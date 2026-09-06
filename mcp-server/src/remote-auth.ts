/**
 * 원격(HTTP) 인증: PAT → 그 사용자 한 명으로 스코프된 Supabase 클라이언트.
 *
 * 핵심 규칙 — 여기서 만든 클라이언트는 절대 재사용/공유하지 않는다.
 * 요청마다 새로 만들고, 요청이 끝나면 버린다. 전역에 캐시하면 "먼저 접속한
 * 사람"의 세션으로 다른 사용자의 요청이 처리돼 남의 노트가 그대로 보인다.
 * (캐시하는 건 '세션 토큰'뿐이고, 그것도 PAT별로 분리된다.)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { hashPat, seal, unseal } from './crypto.js'
import { SUPABASE_ANON_KEY, SUPABASE_URL, type AuthedClient } from './supabase.js'

export interface StoredRemoteSession {
  refresh_token: string
  access_token?: string
  /** epoch 초 */
  expires_at?: number
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) { super(message) }
}

/** 익명 키만 쓰는 클라이언트. RPC 두 개(redeem/store)를 부르는 용도. */
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

interface TokenRow { t_user_id: string; t_session_cipher: string }

/**
 * PAT 해시로 행을 찾는다. 테이블은 RLS로 잠겨 있고(자기 행만 select),
 * 이 조회는 SECURITY DEFINER 함수를 통해서만 가능하다 — 함수 인자가
 * 사실상 비밀(256비트 토큰의 해시)이고, 반환값도 암호문이라 anon 키만으로는
 * 아무것도 못 한다. service_role 키를 서버에 두지 않으려고 이 구조를 택했다.
 */
async function redeem(patHash: string): Promise<TokenRow> {
  const { data, error } = await anonClient().rpc('mcp_redeem_token', { p_hash: patHash })
  if (error) throw new AuthError(`토큰 확인 실패: ${error.message}`, 500)
  const rows = (data ?? []) as TokenRow[]
  const row = rows[0]
  // 없는 토큰과 취소된 토큰을 구분해서 알려주지 않는다 (정보 노출 최소화)
  if (!row) throw new AuthError('토큰이 유효하지 않거나 취소되었습니다')
  return row
}

async function storeSession(patHash: string, session: StoredRemoteSession): Promise<void> {
  const { error } = await anonClient().rpc('mcp_store_session', {
    p_hash: patHash,
    p_cipher: seal(JSON.stringify(session)),
  })
  if (error) throw new AuthError(`세션 저장 실패: ${error.message}`, 500)
}

/**
 * refresh 중복 실행 방지.
 *
 * Supabase는 refresh할 때마다 refresh_token을 새로 발급하고 옛것을 죽인다.
 * 동시에 들어온 두 요청이 각자 refresh하면 서로의 토큰을 무효화해서 세션이
 * 통째로 날아간다 (로컬 버전 주석에 있는 그 사고). PAT별로 한 번에 하나만.
 */
const inflight = new Map<string, Promise<StoredRemoteSession>>()

function refreshOnce(patHash: string, refreshToken: string, expectedUserId: string): Promise<StoredRemoteSession> {
  const running = inflight.get(patHash)
  if (running) return running
  const task = (async () => {
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session) {
      throw new AuthError(
        `Supabase 세션이 만료되었거나 취소되었습니다 (${error?.message ?? '세션 없음'}). ` +
        `npm run enroll 로 이 서버에 다시 등록하세요.`,
      )
    }
    // 저장 전에 확인한다. 등록할 때 남의 refresh token 을 끼워넣은 경우
    // (그 사람 세션이 이미 털린 상황) 여기서 끊어 남의 데이터에 손대지 않는다.
    if (data.session.user.id !== expectedUserId) {
      throw new AuthError('토큰과 세션의 사용자가 일치하지 않습니다', 403)
    }
    const next: StoredRemoteSession = {
      refresh_token: data.session.refresh_token,
      access_token: data.session.access_token,
      expires_at: data.session.expires_at,
    }
    await storeSession(patHash, next)
    return next
  })().finally(() => inflight.delete(patHash))
  inflight.set(patHash, task)
  return task
}

/**
 * PAT 하나 → 그 사용자로 스코프된 새 클라이언트.
 * 모든 쿼리는 이 사용자의 JWT로 나가므로 Postgres RLS가 자기 행에만 묶는다.
 */
export async function clientForPat(pat: string): Promise<AuthedClient> {
  const patHash = hashPat(pat)
  const row = await redeem(patHash)

  let session: StoredRemoteSession
  try {
    session = JSON.parse(unseal(row.t_session_cipher))
  } catch {
    // 키 교체(rotate) 후이거나 암호문이 손상된 경우
    throw new AuthError(
      '저장된 세션을 복호화할 수 없습니다 (서버 키가 바뀌었을 수 있습니다). 다시 등록하세요.',
    )
  }

  const now = Math.floor(Date.now() / 1000)
  if (!session.access_token || !session.expires_at || session.expires_at <= now + 60) {
    session = await refreshOnce(patHash, session.refresh_token, row.t_user_id)
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await db.auth.setSession({
    access_token: session.access_token!,
    refresh_token: session.refresh_token,
  })
  if (error || !data.session) throw new AuthError(`세션 복원 실패: ${error?.message ?? '세션 없음'}`)

  // 방어선: 토큰 행의 주인과 JWT의 주인이 다르면 즉시 거부.
  // 정상 흐름에서는 일어날 수 없다 — 일어났다면 암호문이 섞였거나 DB가
  // 조작된 것이므로, 남의 데이터를 만지기 전에 여기서 끊는다.
  if (data.session.user.id !== row.t_user_id) {
    throw new AuthError('토큰과 세션의 사용자가 일치하지 않습니다', 500)
  }

  return { db, userId: data.session.user.id, email: data.session.user.email ?? undefined }
}

/**
 * 등록(enroll): 클라이언트가 보낸 access token으로 본인을 확인하고,
 * refresh token을 봉인해 저장한 뒤 PAT를 발급한다.
 *
 * user_id를 클라이언트 입력에서 절대 받지 않는다 — access token을 Supabase에
 * 물어봐서 얻는다. 안 그러면 아무나 남의 user_id로 토큰을 만들 수 있다.
 */
export async function enroll(
  accessToken: string,
  refreshToken: string,
  label: string | undefined,
  pat: string,
  allowedEmails?: string[],
): Promise<{ userId: string; email?: string }> {
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await db.auth.getUser(accessToken)
  if (userErr || !userData.user) {
    throw new AuthError(`access token이 유효하지 않습니다 (${userErr?.message ?? '사용자 없음'})`)
  }
  const userId = userData.user.id
  const email = userData.user.email?.toLowerCase()
  if (allowedEmails && (!email || !allowedEmails.includes(email))) {
    // 계정 자체는 정상이지만 이 서버가 받아주는 사람이 아니다
    throw new AuthError('이 서버에 등록할 수 있는 계정이 아닙니다', 403)
  }

  // 이 insert는 사용자 본인의 JWT로 나간다 → RLS(with check auth.uid() = user_id)가
  // 남의 user_id로 행을 만드는 것을 DB에서 막는다.
  const { error: setErr } = await db.auth.setSession({
    access_token: accessToken, refresh_token: refreshToken,
  })
  if (setErr) throw new AuthError(`세션 확인 실패: ${setErr.message}`)

  const { error } = await db.from('mcp_tokens').insert({
    user_id: userId,
    token_hash: hashPat(pat),
    label: label ?? null,
    // access token은 저장하지 않는다 — 첫 요청에서 refresh해 새로 받는다.
    // 보관 기간이 짧을수록 새어나갈 표면이 작다.
    session_cipher: seal(JSON.stringify({ refresh_token: refreshToken } satisfies StoredRemoteSession)),
  })
  if (error) throw new AuthError(`토큰 등록 실패: ${error.message}`, 500)

  return { userId, email: userData.user.email ?? undefined }
}
