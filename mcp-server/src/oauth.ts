/**
 * 브라우저 OAuth 로그인 (한 번). 세션을 반환만 하고 저장은 하지 않는다.
 *
 * login.ts 는 이걸 받아 ~/.noteplan-mcp/session.json 에 저장하고,
 * enroll.ts 는 저장하지 않고 원격 서버로 넘긴다 — 둘이 **서로 다른 세션**을
 * 쓰게 하려는 것이 요점이다.
 *
 * Supabase는 refresh 할 때마다 refresh_token 을 새로 발급하고 옛것을 죽인다
 * (로테이션). 로컬 stdio 서버와 원격 서버가 같은 refresh_token 을 공유하면
 * 서로의 토큰을 무효화해서 양쪽 다 `Invalid Refresh Token: Already Used` 로
 * 죽는다. 그래서 각자 자기 세션을 갖는다.
 */
import { createServer } from 'node:http'
import { exec } from 'node:child_process'
import type { Session } from '@supabase/supabase-js'
import { createBareClient } from './supabase.js'

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open'
  exec(`${cmd} "${url}"`, (err) => {
    if (err) console.error(`브라우저를 자동으로 못 열었습니다. 아래 주소를 직접 여세요:\n${url}`)
  })
}

export async function interactiveLogin(purpose: string): Promise<Session> {
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
    server.close()
    throw new Error(`로그인 URL 생성 실패: ${error?.message ?? '주소 없음'}`)
  }

  console.log(`브라우저에서 Google 로그인을 진행하세요 (${purpose})…`)
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
    throw new Error(`세션 교환 실패: ${exErr?.message ?? '세션 없음'}`)
  }
  return sessionData.session
}
