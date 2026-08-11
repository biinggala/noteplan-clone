import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * 앱(Next.js)의 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 와 동일한 값.
 * anon key는 이미 모든 사용자의 브라우저 번들에 공개되어 있다 — 이 키 자체는
 * 비밀이 아니고, 실제 보안 경계는 Postgres RLS(`auth.uid() = user_id`)다.
 * 그래서 소스에 그대로 박아둬도 된다(친구가 이 저장소를 그대로 clone해서
 * 자기 계정으로 로그인만 하면 되도록 하려는 목적).
 */
const SUPABASE_URL = 'https://wkixhqeifuxxttkcpwty.supabase.co'
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndraXhocWVpZnV4eHR0a2Nwd3R5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODEwNDYsImV4cCI6MjA5Mjc1NzA0Nn0.FHyRSJzCqJPWrHBaw7RPgM5skLOm34yeUgYk0I4vtOM'

const SESSION_DIR = join(homedir(), '.noteplan-mcp')
const SESSION_PATH = join(SESSION_DIR, 'session.json')

interface StoredSession {
  refresh_token: string
  /** 아직 유효한 access token — 있으면 굳이 refresh하지 않는다 (아래 주석 참고) */
  access_token?: string
  /** access token 만료 시각 (초 단위 epoch) */
  expires_at?: number
  email?: string
}

export function saveSession(
  refresh_token: string,
  email?: string,
  access_token?: string,
  expires_at?: number,
): void {
  mkdirSync(SESSION_DIR, { recursive: true })
  writeFileSync(
    SESSION_PATH,
    JSON.stringify({ refresh_token, access_token, expires_at, email } satisfies StoredSession, null, 2),
  )
  chmodSync(SESSION_PATH, 0o600)
}

function loadSession(): StoredSession | null {
  if (!existsSync(SESSION_PATH)) return null
  try {
    return JSON.parse(readFileSync(SESSION_PATH, 'utf8'))
  } catch {
    return null
  }
}

/** 로그인 흐름(login.ts)에서만 쓴다 — PKCE code_verifier를 잠깐 들고 있을 곳이 필요한데,
 *  이 프로세스는 로그인 한 번 하고 끝나므로 메모리 저장으로 충분하다. */
export function createBareClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: 'pkce', persistSession: false, autoRefreshToken: false },
  })
}

export interface AuthedClient {
  db: SupabaseClient
  userId: string
  email?: string
}

/**
 * 저장된 refresh_token으로 세션을 되살린다.
 * service_role 키를 안 쓰므로, 이 클라이언트가 만드는 모든 쿼리는 RLS로
 * 이 사용자 자신의 행에만 묶인다 — 코드가 실수로 필터를 빼먹어도 DB가 막는다.
 */
export async function getAuthedClient(): Promise<AuthedClient> {
  const stored = loadSession()
  if (!stored) {
    throw new Error(
      '로그인 정보가 없습니다. 먼저 `npm run login` 을 실행해 브라우저에서 ' +
      '(앱과 같은 계정으로) Google 로그인을 완료하세요.',
    )
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 아직 안 만료된 access token이 있으면 그걸 그대로 쓴다.
  //
  // Supabase는 refresh할 때마다 refresh_token을 새로 발급하고 옛것을 죽인다
  // (로테이션). 서버 인스턴스가 둘 이상 뜨면(예: Claude 데스크톱 + Claude Code)
  // 각자 시작할 때 refresh를 해서 서로의 토큰을 무효화한다 — 실제로 이걸로
  // 세션이 날아갔다. 만료 전에는 refresh를 아예 안 하는 게 가장 확실한 예방.
  const now = Math.floor(Date.now() / 1000)
  if (stored.access_token && stored.expires_at && stored.expires_at > now + 60) {
    const { data: setData, error: setErr } = await db.auth.setSession({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token,
    })
    if (!setErr && setData.session) {
      return {
        db,
        userId: setData.session.user.id,
        email: setData.session.user.email ?? stored.email,
      }
    }
    // 실패하면 아래 refresh 경로로 폴백
  }

  const { data, error } = await db.auth.refreshSession({ refresh_token: stored.refresh_token })
  if (error || !data.session) {
    throw new Error(
      `로그인 세션이 만료되었거나 취소된 것 같습니다 (${error?.message ?? '세션 없음'}). ` +
      '`npm run login` 을 다시 실행하세요.',
    )
  }

  saveSession(
    data.session.refresh_token,
    data.session.user.email ?? stored.email,
    data.session.access_token,
    data.session.expires_at,
  )

  await db.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })

  return { db, userId: data.session.user.id, email: data.session.user.email ?? stored.email }
}

export { SUPABASE_URL, SUPABASE_ANON_KEY }
