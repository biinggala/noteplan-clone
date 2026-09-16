#!/usr/bin/env node
/**
 * 로컬(stdio) 서버용 1회 로그인. 브라우저를 열어 (앱과 같은) Google 계정으로
 * 로그인하고, 그 세션을 ~/.noteplan-mcp/session.json 에 저장한다.
 *
 * service_role 키를 아예 안 쓰는 이유가 이거다 — 각자 자기 계정으로 로그인하면
 * 이후 모든 쿼리가 Postgres RLS(`auth.uid() = user_id`)로 자동 스코프된다.
 *
 * 원격(URL) 서버 등록은 `npm run enroll` 이 자기 세션을 따로 만든다 —
 * 하나의 refresh_token 을 둘이 나눠 쓰면 로테이션으로 서로를 죽인다.
 */
import { interactiveLogin } from './oauth.js'
import { saveSession } from './supabase.js'

async function main() {
  const session = await interactiveLogin('로컬 stdio 서버용')
  saveSession(
    session.refresh_token,
    session.user.email ?? undefined,
    session.access_token,
    session.expires_at,
  )
  console.log(`\n로그인 완료: ${session.user.email ?? session.user.id}`)
  console.log('이제 Claude에 MCP 서버를 등록하면 됩니다 (README 참고).')
}

main().catch((e) => {
  console.error('로그인 실패:', e instanceof Error ? e.message : e)
  process.exit(1)
})
