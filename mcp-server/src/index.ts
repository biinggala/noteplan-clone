#!/usr/bin/env node
/**
 * NotePlan MCP server
 * Claude(데스크톱/Code)에 내 노트(Supabase)를 검색·조회·연결·작성하는 도구로 노출.
 * 로컬 전용: service_role 키 + 내 user_id 로 동작 (앱 번들과 무관).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

// ── .env 로드 (패키지 루트) ──────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url))
try {
  const envText = readFileSync(join(here, '..', '.env'), 'utf8')
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* .env 없으면 process.env 사용 */ }

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const USER_ID = process.env.NOTEPLAN_USER_ID
if (!SUPABASE_URL || !SERVICE_KEY || !USER_ID) {
  console.error('[noteplan-mcp] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NOTEPLAN_USER_ID 필요 (.env 확인)')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
interface Row {
  id: string; type: string; title: string; content: string
  date: string | null; folder: string | null; file_path: string
  tags: string[]; mentions: string[]; backlinks: string[]
  created_at: number; updated_at: number
}

const base = () => db.from('notes').select('*').eq('user_id', USER_ID)

/** 노트 한 줄 요약 (검색 결과용) */
function summarize(r: Row, query?: string): string {
  const ref = r.type === 'daily' && r.date ? r.date
    : r.type === 'weekly' && r.date ? `Week ${r.date}` : r.title
  let snippet = ''
  const lines = (r.content ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  if (query) {
    const q = query.toLowerCase()
    snippet = lines.find(l => l.toLowerCase().includes(q)) ?? lines[0] ?? ''
  } else {
    snippet = lines.find(l => !l.startsWith('#')) ?? lines[0] ?? ''
  }
  if (snippet.length > 160) snippet = snippet.slice(0, 160) + '…'
  const loc = r.folder ? ` [${r.folder}]` : r.type !== 'project' ? ` [${r.type}]` : ''
  return `• ${ref}${loc} (id:${r.id})\n  ${snippet}`
}

function text(s: string) { return { content: [{ type: 'text' as const, text: s }] } }
function fail(s: string) { return { content: [{ type: 'text' as const, text: `⚠ ${s}` }], isError: true } }

/** 열려있는 에디터에 "Claude AI 작성 중…" presence를 broadcast (노션 스타일 표시).
 *  구독자가 없어도 안전하게 무시됨 — 실패해도 실제 저장은 계속 진행. */
async function broadcastTyping(noteId: string, typing: boolean): Promise<void> {
  const channel = db.channel(`note:${noteId}`)
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500) // 구독자 없으면 최대 1.5초만 대기
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve() }
      })
    })
    await channel.send({ type: 'broadcast', event: 'typing', payload: { typing, author: 'Claude AI' } })
  } catch { /* presence는 부가기능 — 실패해도 무시 */ }
  finally { db.removeChannel(channel) }
}

// ── 서버 ─────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'noteplan', version: '0.1.0' })

// 검색: 제목/본문 키워드
server.tool(
  'search_notes',
  '내 노트에서 키워드로 검색 (제목·본문). 최근 수정순. 결과는 요약 + id.',
  { query: z.string().describe('검색어'), limit: z.number().optional().describe('최대 개수(기본 8)') },
  async ({ query, limit }) => {
    const like = `%${query}%`
    const { data, error } = await base()
      .or(`title.ilike.${like},content.ilike.${like}`)
      .order('updated_at', { ascending: false })
      .limit(limit ?? 8)
    if (error) return fail(error.message)
    const rows = (data ?? []) as Row[]
    if (!rows.length) return text(`"${query}" 검색 결과 없음`)
    return text(rows.map(r => summarize(r, query)).join('\n\n'))
  },
)

// 노트 전체 조회
server.tool(
  'get_note',
  '노트 전체 내용 조회. id 또는 title 또는 date(YYYY-MM-DD) 중 하나로.',
  {
    id: z.string().optional(),
    title: z.string().optional(),
    date: z.string().optional().describe('daily 노트 날짜 YYYY-MM-DD'),
  },
  async ({ id, title, date }) => {
    let q = base()
    if (id) q = q.eq('id', id)
    else if (date) q = q.eq('date', date)
    else if (title) q = q.ilike('title', title)
    else return fail('id / title / date 중 하나 필요')
    const { data, error } = await q.limit(1).maybeSingle()
    if (error) return fail(error.message)
    if (!data) return text('노트를 찾지 못함')
    const r = data as Row
    return text(`# ${r.title}  (id:${r.id}, type:${r.type}${r.folder ? `, folder:${r.folder}` : ''})\n\n${r.content}`)
  },
)

// 최근 노트
server.tool(
  'list_recent',
  '최근 수정된 노트 목록. type으로 필터 가능(daily/weekly/monthly/project).',
  { limit: z.number().optional(), type: z.string().optional() },
  async ({ limit, type }) => {
    let q = base().order('updated_at', { ascending: false }).limit(limit ?? 10)
    if (type) q = q.eq('type', type)
    const { data, error } = await q
    if (error) return fail(error.message)
    const rows = (data ?? []) as Row[]
    return text(rows.length ? rows.map(r => summarize(r)).join('\n\n') : '노트 없음')
  },
)

// 태그로 검색 (계층 포함: #tag 는 #tag/sub 도 매칭)
server.tool(
  'list_by_tag',
  '특정 태그가 포함된 노트 검색. 계층 태그 포함(#journal → #journal/x 도).',
  { tag: z.string().describe('# 없이 태그명, 예: journal 또는 journal/reflection') },
  async ({ tag }) => {
    const clean = tag.replace(/^#/, '')
    const { data, error } = await base()
      .ilike('content', `%#${clean}%`)
      .order('updated_at', { ascending: false })
      .limit(20)
    if (error) return fail(error.message)
    const rows = (data ?? []) as Row[]
    return text(rows.length ? rows.map(r => summarize(r, `#${clean}`)).join('\n\n') : `#${clean} 결과 없음`)
  },
)

// 백링크: 이 노트를 [[링크]]한 노트들
server.tool(
  'get_backlinks',
  '이 노트를 [[위키링크]]로 참조한 노트들 (지식 그래프 역방향).',
  { title: z.string().describe('대상 노트 제목') },
  async ({ title }) => {
    const { data, error } = await base()
      .ilike('content', `%[[${title}]]%`)
      .order('updated_at', { ascending: false })
      .limit(20)
    if (error) return fail(error.message)
    const rows = (data ?? []) as Row[]
    return text(rows.length ? rows.map(r => summarize(r, `[[${title}]]`)).join('\n\n') : `[[${title}]] 백링크 없음`)
  },
)

// 새 노트 작성 (project)
server.tool(
  'create_note',
  '새 노트 생성 (project 타입). folder는 PARA 경로 예: Projects, Areas/My Area.',
  { title: z.string(), content: z.string().optional(), folder: z.string().optional() },
  async ({ title, content, folder }) => {
    const now = Date.now()
    const filePath = folder ? `Notes/${folder}/${title}.md` : `Notes/${title}.md`
    const row = {
      id: randomUUID(), user_id: USER_ID, type: 'project', title,
      content: content ?? `# ${title}\n\n`, date: null, file_path: filePath,
      folder: folder ?? null, tags: [], mentions: [], backlinks: [],
      created_at: now, updated_at: now,
    }
    const { error } = await db.from('notes').insert(row)
    if (error) return fail(error.message)
    return text(`생성됨: "${title}" (id:${row.id}${folder ? `, folder:${folder}` : ''})`)
  },
)

// 노트에 내용 추가
server.tool(
  'append_to_note',
  '기존 노트 본문 끝에 텍스트 추가 (id로 지정).',
  { id: z.string(), text: z.string() },
  async ({ id, text: body }) => {
    const { data, error } = await base().eq('id', id).limit(1).maybeSingle()
    if (error) return fail(error.message)
    if (!data) return fail('노트 없음')
    const r = data as Row
    const newContent = `${r.content.replace(/\s+$/, '')}\n${body}\n`
    await broadcastTyping(id, true)
    const { error: e2 } = await db.from('notes')
      .update({ content: newContent, updated_at: Date.now() }).eq('id', id).eq('user_id', USER_ID)
    await broadcastTyping(id, false)
    if (e2) return fail(e2.message)
    return text(`추가됨 → "${r.title}"`)
  },
)

// 데일리 노트에 추가 (없으면 생성)
server.tool(
  'append_to_daily',
  '해당 날짜 데일리 노트에 텍스트 추가 (없으면 생성). date 미지정 시 오늘.',
  { date: z.string().optional().describe('YYYY-MM-DD, 기본 오늘'), text: z.string() },
  async ({ date, text: body }) => {
    const d = date ?? new Date().toLocaleDateString('en-CA') // YYYY-MM-DD (local)
    const ymd = d.replace(/-/g, '')
    const { data } = await base().eq('date', d).eq('type', 'daily').limit(1).maybeSingle()
    const now = Date.now()
    if (data) {
      const r = data as Row
      const newContent = `${r.content.replace(/\s+$/, '')}\n${body}\n`
      await broadcastTyping(r.id, true)
      const { error } = await db.from('notes')
        .update({ content: newContent, updated_at: now }).eq('id', r.id).eq('user_id', USER_ID)
      await broadcastTyping(r.id, false)
      if (error) return fail(error.message)
      return text(`${d} 데일리 노트에 추가됨`)
    }
    const row = {
      id: randomUUID(), user_id: USER_ID, type: 'daily', title: d,
      content: `${body}\n`, date: d, file_path: `Calendar/${ymd}.md`,
      folder: null, tags: [], mentions: [], backlinks: [], created_at: now, updated_at: now,
    }
    const { error } = await db.from('notes').insert(row)
    if (error) return fail(error.message)
    return text(`${d} 데일리 노트 생성 + 추가됨`)
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[noteplan-mcp] ready')
