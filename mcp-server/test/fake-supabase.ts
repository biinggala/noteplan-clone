/**
 * 테스트용 가짜 Supabase (GoTrue + PostgREST 최소 구현).
 *
 * 중요한 성질 하나: notes/folders 조회·수정은 **Authorization JWT의 sub**로만
 * 스코프한다. 클라이언트가 보낸 user_id=eq.… 필터는 신뢰하지 않는다 —
 * 실제 Postgres RLS(`auth.uid() = user_id`)와 같은 성질이다.
 * 그래서 서버가 엉뚱한 사용자의 세션으로 쿼리하면 그 사용자의 행이 돌아오고,
 * 테스트가 그걸 잡아낼 수 있다.
 */
import { createServer, type Server } from 'node:http'

export interface FakeNote {
  id: string; user_id: string; type: string; title: string; content: string
  date: string | null; folder: string | null; file_path: string
  tags: string[]; mentions: string[]; backlinks: string[]
  created_at: number; updated_at: number
}

export interface FakeTokenRow { user_id: string; session_cipher: string; revoked?: boolean }

export interface FakeState {
  users: Map<string, { id: string; email: string }>
  /** refresh_token → user_id */
  refreshTokens: Map<string, string>
  notes: FakeNote[]
  folders: Array<{ id: string; user_id: string; name: string; path: string; parent_id: string | null }>
  /** token_hash → row */
  tokens: Map<string, FakeTokenRow>
  /** 감사용: notes 를 어떤 사용자로 읽었는지 순서대로 기록 */
  queryLog: Array<{ table: string; method: string; asUser: string | null }>
  rotations: number
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function fakeJwt(userId: string, email: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, email, exp, role: 'authenticated' })}.fake`
}

function userFromJwt(token: string | undefined): string | null {
  if (!token || token.split('.').length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    if (typeof payload.exp === 'number' && payload.exp <= Math.floor(Date.now() / 1000)) return null
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

function bearer(header: string | undefined): string | undefined {
  const m = header && /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1] : undefined
}

/** PostgREST 필터 중 이 테스트에 필요한 것만 (eq / ilike / order / limit) */
function applyFilters(rows: FakeNote[], params: URLSearchParams): FakeNote[] {
  let out = [...rows]
  for (const [key, value] of params) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(key)) continue
    const [op, ...rest] = value.split('.')
    const operand = rest.join('.')
    if (op === 'eq') out = out.filter(r => String((r as unknown as Record<string, unknown>)[key] ?? '') === operand)
    else if (op === 'ilike') {
      const needle = decodeURIComponent(operand).replace(/%/g, '').toLowerCase()
      out = out.filter(r => String((r as unknown as Record<string, unknown>)[key] ?? '').toLowerCase().includes(needle))
    }
  }
  const order = params.get('order')
  if (order) {
    const [col, dir] = order.split('.')
    out.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[col] as number | string
      const bv = (b as unknown as Record<string, unknown>)[col] as number | string
      return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'desc' ? -1 : 1)
    })
  }
  const limit = params.get('limit')
  if (limit) out = out.slice(0, Number(limit))
  return out
}

export async function startFakeSupabase(state: FakeState): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const token = bearer(req.headers.authorization)
    const asUser = userFromJwt(token)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : undefined

    const send = (status: number, payload: unknown) => {
      const text = payload === undefined ? '' : JSON.stringify(payload)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(text)
    }

    // ── GoTrue ────────────────────────────────────────────────────────────
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const userId = state.refreshTokens.get(body?.refresh_token)
      if (!userId) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
      state.refreshTokens.delete(body.refresh_token)     // 로테이션: 옛 토큰 폐기
      state.rotations += 1
      const next = `refresh-${userId}-${state.rotations}`
      state.refreshTokens.set(next, userId)
      const user = state.users.get(userId)!
      return send(200, {
        access_token: fakeJwt(userId, user.email),
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: next,
        user: { id: userId, email: user.email, aud: 'authenticated', role: 'authenticated' },
      })
    }

    if (url.pathname === '/auth/v1/user') {
      if (!asUser) return send(401, { message: 'invalid claim: missing sub claim' })
      const user = state.users.get(asUser)
      if (!user) return send(401, { message: 'user not found' })
      return send(200, { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' })
    }

    // ── PostgREST: RPC ────────────────────────────────────────────────────
    if (url.pathname === '/rest/v1/rpc/mcp_redeem_token') {
      const row = state.tokens.get(body?.p_hash)
      if (!row || row.revoked) return send(200, [])
      return send(200, [{ t_user_id: row.user_id, t_session_cipher: row.session_cipher }])
    }

    if (url.pathname === '/rest/v1/rpc/mcp_store_session') {
      const row = state.tokens.get(body?.p_hash)
      if (row && !row.revoked) row.session_cipher = body.p_cipher
      return send(200, null)
    }

    // ── PostgREST: 테이블 ─────────────────────────────────────────────────
    if (url.pathname === '/rest/v1/notes') {
      state.queryLog.push({ table: 'notes', method: req.method ?? '', asUser })
      // RLS 시뮬레이션: JWT 없으면 아무 행도 안 보인다
      const visible = asUser ? state.notes.filter(n => n.user_id === asUser) : []

      if (req.method === 'GET') return send(200, applyFilters(visible, url.searchParams))

      if (req.method === 'POST') {
        const row = body as FakeNote
        // RLS WITH CHECK: 남의 user_id로 삽입 금지
        if (!asUser || row.user_id !== asUser) {
          return send(403, { code: '42501', message: 'new row violates row-level security policy for table "notes"' })
        }
        state.notes.push(row)
        return send(201, [row])
      }

      if (req.method === 'PATCH') {
        const targets = applyFilters(visible, url.searchParams)
        for (const t of targets) Object.assign(t, body)
        return send(200, targets)
      }
    }

    if (url.pathname === '/rest/v1/folders') {
      state.queryLog.push({ table: 'folders', method: req.method ?? '', asUser })
      const visible = asUser ? state.folders.filter(f => f.user_id === asUser) : []
      if (req.method === 'GET') return send(200, visible)
      if (req.method === 'POST') {
        const row = body as FakeState['folders'][number]
        if (!asUser || row.user_id !== asUser) {
          return send(403, { code: '42501', message: 'row-level security' })
        }
        state.folders.push(row)
        return send(201, [row])
      }
    }

    if (url.pathname === '/rest/v1/mcp_tokens' && req.method === 'POST') {
      const row = body as { user_id: string; token_hash: string; session_cipher: string }
      if (!asUser || row.user_id !== asUser) {
        return send(403, { code: '42501', message: 'row-level security' })
      }
      state.tokens.set(row.token_hash, { user_id: row.user_id, session_cipher: row.session_cipher })
      return send(201, [row])
    }

    send(404, { message: `fake supabase: unhandled ${req.method} ${url.pathname}` })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('포트 확보 실패')
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

export function emptyState(): FakeState {
  return {
    users: new Map(), refreshTokens: new Map(), notes: [], folders: [],
    tokens: new Map(), queryLog: [], rotations: 0,
  }
}
