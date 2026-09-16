#!/usr/bin/env node
/**
 * 원격 서버에 등록하고 PAT를 받는다.
 *
 *   npm run enroll -- --server https://mcp.example.com [--label "맥북"]
 *
 * 기본 동작은 **이 등록만을 위한 새 로그인**이다. 로컬 stdio 서버가 쓰는
 * ~/.noteplan-mcp/session.json 은 건드리지 않는다.
 *
 * 왜 새로 로그인하나: Supabase는 refresh 할 때마다 refresh_token 을 새로
 * 발급하고 옛것을 죽인다(로테이션). 로컬 서버와 원격 서버가 같은 토큰을
 * 나눠 쓰면 먼저 쓴 쪽이 다른 쪽을 죽여서, 양쪽 다
 * `Invalid Refresh Token: Already Used` 로 실패한다. 세션을 따로 가져야 한다.
 *
 * refresh token 은 등록할 때 한 번만 서버로 보낸다(TLS). 이후에는 PAT만
 * 주고받는다. PAT는 발급 시 딱 한 번 출력된다.
 */
import { interactiveLogin } from './oauth.js'
import { getAuthedClient, readStoredSession } from './supabase.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function sessionForEnroll(): Promise<{ accessToken: string; refreshToken: string }> {
  if (hasFlag('use-saved-session')) {
    // 옛 동작. 로컬 stdio 서버와 세션을 공유하게 되므로 권하지 않는다.
    console.warn('경고: 저장된 로컬 세션을 재사용합니다. 원격 서버가 이 토큰을')
    console.warn('      갱신하면 로컬 stdio 서버의 세션이 끊깁니다 (다시 npm run login 필요).')
    await getAuthedClient()   // 필요하면 refresh 하고 파일을 갱신
    const stored = readStoredSession()
    if (!stored?.access_token || !stored.refresh_token) {
      throw new Error('로컬 세션이 없습니다. `npm run login` 을 먼저 실행하세요.')
    }
    return { accessToken: stored.access_token, refreshToken: stored.refresh_token }
  }

  const session = await interactiveLogin('원격 MCP 서버 등록용')
  console.log(`\n로그인 완료: ${session.user.email ?? session.user.id}`)
  return { accessToken: session.access_token, refreshToken: session.refresh_token }
}

async function main() {
  const server = arg('server')
  if (!server) {
    console.error('사용법: npm run enroll -- --server https://mcp.example.com [--label "맥북"]')
    console.error('        (로컬 세션을 재사용하려면 --use-saved-session — 권장하지 않음)')
    process.exit(1)
  }
  const base = server.replace(/\/+$/, '')
  if (!base.startsWith('https://') && !base.startsWith('http://127.0.0.1') && !base.startsWith('http://localhost')) {
    console.error('https:// 주소만 허용합니다 (refresh token을 보내는 요청이라 평문은 위험).')
    process.exit(1)
  }

  const { accessToken, refreshToken } = await sessionForEnroll()

  const res = await fetch(`${base}/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ refresh_token: refreshToken, label: arg('label') }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`등록 실패 (${res.status}): ${(body as { error?: string }).error ?? '알 수 없는 오류'}`)
    process.exit(1)
  }

  const { token, email, user_id: userId } = body as { token: string; email?: string; user_id: string }
  console.log(`\n등록 완료: ${email ?? userId}`)
  console.log('\n토큰 (이 화면에서만 보입니다 — 서버에는 해시만 저장됩니다):')
  console.log(`  ${token}`)
  console.log('\nClaude Code에 등록:')
  console.log(`  claude mcp add --transport http noteplan ${base}/mcp --header "Authorization: Bearer ${token}"`)
  console.log('\n확인:')
  console.log(`  npm run smoke -- --server ${base} --token ${token}`)
  console.log('\n토큰이 새면 남이 내 노트를 읽고 쓸 수 있습니다. 유출이 의심되면')
  console.log('앱/SQL에서 mcp_tokens 의 해당 행 revoked_at 을 채우면 즉시 막힙니다.')
}

main().catch((e) => {
  console.error('등록 실패:', e instanceof Error ? e.message : e)
  process.exit(1)
})
