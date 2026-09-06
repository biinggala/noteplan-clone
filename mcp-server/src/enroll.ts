#!/usr/bin/env node
/**
 * 원격 서버에 이 컴퓨터의 로그인 세션을 등록하고 PAT를 받는다.
 *
 *   npm run enroll -- --server https://mcp.example.com [--label "맥북"]
 *
 * refresh token은 이때 한 번만 서버로 보낸다(TLS). 서버는 그걸 봉인해서
 * 저장하고, 이후에는 PAT만 주고받는다. PAT는 여기서 딱 한 번 출력된다.
 */
import { getAuthedClient, readStoredSession } from './supabase.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const server = arg('server')
  if (!server) {
    console.error('사용법: npm run enroll -- --server https://mcp.example.com [--label "맥북"]')
    process.exit(1)
  }
  const base = server.replace(/\/+$/, '')
  if (!base.startsWith('https://') && !base.startsWith('http://127.0.0.1') && !base.startsWith('http://localhost')) {
    console.error('https:// 주소만 허용합니다 (refresh token을 보내는 요청이라 평문은 위험).')
    process.exit(1)
  }

  // 저장된 세션을 살려 access token을 최신으로 만든다 (필요하면 refresh + 파일 갱신)
  await getAuthedClient()
  const stored = readStoredSession()
  if (!stored?.access_token || !stored.refresh_token) {
    console.error('로컬 세션이 없습니다. 먼저 `npm run login` 을 실행하세요.')
    process.exit(1)
  }

  const res = await fetch(`${base}/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${stored.access_token}`,
    },
    body: JSON.stringify({ refresh_token: stored.refresh_token, label: arg('label') }),
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
  console.log('\n토큰이 새면 남이 내 노트를 읽고 쓸 수 있습니다. 유출이 의심되면')
  console.log('앱/SQL에서 mcp_tokens 의 해당 행 revoked_at 을 채우면 즉시 막힙니다.')
}

main().catch((e) => {
  console.error('등록 실패:', e instanceof Error ? e.message : e)
  process.exit(1)
})
