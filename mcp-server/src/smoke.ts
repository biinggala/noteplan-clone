#!/usr/bin/env node
/**
 * 배포한 서버가 제대로 서 있는지 확인한다 (배포 직후 1회 실행용).
 *
 *   npm run smoke -- --server https://mcp.example.com [--token npmcp_...]
 *
 * 토큰 없이 돌리면 설정·거절 동작만 본다. 토큰을 주면 실제 MCP 핸드셰이크와
 * 도구 목록까지 확인한다. 노트 내용은 출력하지 않는다.
 */
interface Check { name: string; ok: boolean; detail: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const server = arg('server')
  if (!server) {
    console.error('사용법: npm run smoke -- --server https://mcp.example.com [--token npmcp_...]')
    process.exit(1)
  }
  const base = server.replace(/\/+$/, '')
  const token = arg('token')
  const checks: Check[] = []

  // ① 설정 자체 점검
  try {
    const res = await fetch(`${base}/healthz`)
    const body = await res.json() as { ok: boolean; checks: Record<string, boolean>; warnings: string[] }
    checks.push({
      name: '서버 응답 + 설정',
      ok: res.status === 200 && body.ok,
      detail: res.status === 200
        ? (body.warnings.length ? `경고: ${body.warnings.join(' / ')}` : '설정 이상 없음')
        : `HTTP ${res.status} — ${body.warnings?.join(' / ') ?? ''}`,
    })
  } catch (e) {
    checks.push({ name: '서버 응답 + 설정', ok: false, detail: `연결 실패: ${e instanceof Error ? e.message : e}` })
  }

  // ② 인증 없이 접근하면 막혀야 한다
  try {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const raw = await res.text()
    checks.push({
      name: '무인증 요청 거절',
      ok: res.status === 401 && /Bearer/i.test(res.headers.get('www-authenticate') ?? ''),
      detail: `HTTP ${res.status}${res.status === 401 ? '' : ` (401이어야 함) ${raw.slice(0, 120)}`}`,
    })
  } catch (e) {
    checks.push({ name: '무인증 요청 거절', ok: false, detail: `${e instanceof Error ? e.message : e}` })
  }

  // ③ 아무 토큰이나 통과되면 안 된다
  try {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer npmcp_${'0'.repeat(43)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    checks.push({ name: '엉터리 토큰 거절', ok: res.status === 401, detail: `HTTP ${res.status}` })
  } catch (e) {
    checks.push({ name: '엉터리 토큰 거절', ok: false, detail: `${e instanceof Error ? e.message : e}` })
  }

  // ④ GET /mcp 은 stateless 라 405
  try {
    const res = await fetch(`${base}/mcp`, { method: 'GET' })
    checks.push({ name: 'GET /mcp 405 (stateless)', ok: res.status === 405 || res.status === 401, detail: `HTTP ${res.status}` })
  } catch (e) {
    checks.push({ name: 'GET /mcp 405 (stateless)', ok: false, detail: `${e instanceof Error ? e.message : e}` })
  }

  // ⑤ 토큰이 있으면 실제 MCP 대화까지
  if (token) {
    const rpc = async (method: string, params: unknown) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      const raw = await res.text()
      const jsonText = raw.startsWith('event:') || raw.startsWith('data:')
        ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5).trim() ?? raw
        : raw
      return { status: res.status, body: JSON.parse(jsonText) as Record<string, any> }
    }
    try {
      const init = await rpc('initialize', {
        protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'noteplan-smoke', version: '1.0.0' },
      })
      checks.push({
        name: 'initialize 핸드셰이크',
        ok: init.status === 200 && init.body.result?.serverInfo?.name === 'noteplan',
        detail: init.status === 200 ? `서버: ${init.body.result?.serverInfo?.name}` : `HTTP ${init.status} ${init.body.error?.message ?? ''}`,
      })
      const tools = await rpc('tools/list', {})
      const names = (tools.body.result?.tools ?? []).map((t: { name: string }) => t.name)
      checks.push({
        name: '도구 목록',
        ok: tools.status === 200 && names.length === 9,
        detail: tools.status === 200 ? `${names.length}개: ${names.join(', ')}` : `HTTP ${tools.status} ${tools.body.error?.message ?? ''}`,
      })
    } catch (e) {
      checks.push({ name: 'MCP 대화', ok: false, detail: `${e instanceof Error ? e.message : e}` })
    }
  }

  console.log(`\n${base}\n`)
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`)
  const failed = checks.filter(c => !c.ok).length
  if (!token) console.log('\n  (--token 을 주면 실제 MCP 핸드셰이크까지 확인합니다)')
  console.log(failed ? `\n${failed}개 항목 실패\n` : '\n전부 통과\n')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('점검 실패:', e instanceof Error ? e.message : e); process.exit(1) })
