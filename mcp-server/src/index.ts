#!/usr/bin/env node
/**
 * NotePlan MCP server — stdio (로컬 전용)
 *
 * Claude(데스크톱/Code)가 이 프로세스를 직접 실행하고 표준입출력으로 대화한다.
 * 1 프로세스 = 1 사용자이므로, 시작할 때 로컬 세션 하나를 열어 그걸 계속 쓴다.
 *
 * service_role 키를 쓰지 않는다. service_role은 RLS를 완전히 우회하는
 * 프로젝트 전체 마스터키라, 이 서버를 지인에게 공유하면 그 키를 가진
 * 사람이 (코드를 안 봐도) 다른 사용자의 노트까지 볼 수 있게 된다.
 *
 * 대신 `npm run login` 으로 (앱과 같은) 자기 Google 계정 세션을 로컬에 저장하고,
 * 그 세션으로 접속한다. 이러면 Postgres RLS(`auth.uid() = user_id`)가 모든
 * 쿼리를 자동으로 자기 자신의 행에만 묶는다 — 코드가 필터를 빼먹어도 DB가 막는다.
 *
 * URL로 붙이고 싶으면 `npm run serve` (src/http.ts) 를 쓴다. 그쪽은 요청마다
 * 사용자를 인증하고 요청마다 별도 클라이언트를 만든다 — SECURITY.md 참고.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getAuthedClient } from './supabase.js'
import { registerTools } from './tools.js'

const ctx = await getAuthedClient().catch((e: unknown) => {
  console.error('[noteplan-mcp]', e instanceof Error ? e.message : e)
  process.exit(1)
})

const server = new McpServer({ name: 'noteplan', version: '0.2.0' })
registerTools(server, ctx)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[noteplan-mcp] ready (stdio)')
