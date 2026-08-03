#!/usr/bin/env node
/**
 * 1회 로그인. 브라우저를 열어 (앱과 같은) Google 계정으로 로그인시키고,
 * 그 결과로 받은 refresh_token을 로컬(~/.noteplan-mcp/session.json)에 저장한다.
 *
 * service_role 키를 아예 안 쓰는 이유가 이거다 — 각자 자기 계정으로 로그인하면
 * 이후 모든 쿼리가 Postgres RLS(`auth.uid() = user_id`)로 자동 스코프된다.
 * 친구가 이 저장소를 그대로 clone해서 이 명령만 실행하면, 자기 노트만 보는
 * 자기 전용 MCP 서버가 된다.
 */
import { createServer } from 'node:http'
import { exec } from 'node:child_process'
import { createBareClient, saveSession } from './supabase.js'

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open'
  exec(`${cmd} "${url}"`, (err) => {
    if (err) console.error(`브라우저를 자동으로 못 열었습니다. 아래 주소를 직접 여세요:\n${url}`)
  })
}

async function main() {
  const supabase = createBareClient()

  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('로컬 서버 포트 확보 실패')
  const port = address.port
  const redirectTo = `http://127.0.0.1:${port}/callback`

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  })
  if (error || !data?.url) {
    console.error('로그인 URL 생성 실패:', error?.message)
    server.close()
    process.exit(1)
  }

  console.log('브라우저에서 Google 로그인을 진행하세요…')
  console.log('(자동으로 안 열리면 이 주소를 복사해서 여세요)')
  console.log(data.url)
  openBrowser(data.url)

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('5분 안에 로그인이 완료되지 않았습니다')), 5 * 60_000)
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectTo)
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
      const c = url.searchParams.get('code')
      const errParam = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(errParam
        ? `<h2>로그인 실패</h2><p>${errParam}</p><p>이 창은 닫아도 됩니다.</p>`
        : `<h2>로그인 완료 ✓</h2><p>이 창은 닫고 터미널로 돌아가세요.</p>`)
      clearTimeout(timeout)
      if (errParam) reject(new Error(errParam))
      else if (c) resolve(c)
      else reject(new Error('콜백에 code가 없습니다'))
    })
  }).finally(() => server.close())

  const { data: sessionData, error: exErr } = await supabase.auth.exchangeCodeForSession(code)
  if (exErr || !sessionData.session) {
    console.error('세션 교환 실패:', exErr?.message)
    process.exit(1)
  }

  saveSession(sessionData.session.refresh_token, sessionData.session.user.email ?? undefined)
  console.log(`\n로그인 완료: ${sessionData.session.user.email ?? sessionData.session.user.id}`)
  console.log('이제 Claude에 MCP 서버를 등록하면 됩니다 (README 참고).')
}

main().catch((e) => {
  console.error('로그인 실패:', e instanceof Error ? e.message : e)
  process.exit(1)
})
