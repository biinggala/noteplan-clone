#!/usr/bin/env node
/**
 * NotePlan MCP server
 * Claude(데스크톱/Code)에 내 노트(Supabase)를 검색·조회·연결·작성하는 도구로 노출.
 *
 * service_role 키를 쓰지 않는다. service_role은 RLS를 완전히 우회하는
 * 프로젝트 전체 마스터키라, 이 서버를 지인에게 공유하면 그 키를 가진
 * 사람이 (코드를 안 봐도) 다른 사용자의 노트까지 볼 수 있게 된다.
 *
 * 대신 `npm run login` 으로 (앱과 같은) 자기 Google 계정 세션을 로컬에 저장하고,
 * 그 세션으로 접속한다. 이러면 Postgres RLS(`auth.uid() = user_id`)가 모든
 * 쿼리를 자동으로 자기 자신의 행에만 묶는다 — 코드가 필터를 빼먹어도 DB가 막는다.
 * 친구가 이 저장소를 그대로 clone해서 `npm run login` 만 하면 자기 노트만
 * 보는 자기 전용 서버가 된다.
 */
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { derive, countOccurrences, replaceLiteral } from './derive.js'
import { getAuthedClient } from './supabase.js'

const { db, userId: USER_ID } = await getAuthedClient().catch((e: unknown) => {
  console.error('[noteplan-mcp]', e instanceof Error ? e.message : e)
  process.exit(1)
})

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

/** 클로드가 쓰는 모든 노트/블록 맨 앞에 #claude 태그를 달아 앱에서 모아볼 수 있게 함 */
function tagged(body: string): string {
  return `#claude\n${body}`
}

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

/**
 * 'Areas/블랙페이퍼' 같은 경로의 폴더 행을 (상위까지) 없으면 만든다.
 *
 * 앱 사이드바는 folders 테이블로 트리를 그린다. notes.folder에 문자열만 넣고
 * 폴더 행을 안 만들면 그 노트는 트리에서 통째로 사라진다(검색으로만 나옴).
 */
async function ensureFolderPath(path: string): Promise<string | undefined> {
  const segments = path.split('/').map(s => s.trim()).filter(Boolean)
  if (!segments.length) return undefined

  const { data: existing, error } = await db
    .from('folders').select('id,path').eq('user_id', USER_ID)
  if (error) return error.message
  const byPath = new Map((existing ?? []).map(f => [f.path as string, f.id as string]))

  let parentId: string | null = null
  for (let i = 0; i < segments.length; i++) {
    const sub = segments.slice(0, i + 1).join('/')
    const hit = byPath.get(sub)
    if (hit) { parentId = hit; continue }
    const id = randomUUID()
    const { error: insErr } = await db.from('folders').insert({
      id, user_id: USER_ID, name: segments[i], path: sub, parent_id: parentId,
    })
    if (insErr) return `폴더 생성 실패(${sub}): ${insErr.message}`
    byPath.set(sub, id)
    parentId = id
  }
  return undefined
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
    // 폴더 행이 없으면 사이드바 트리에 이 노트가 아예 안 뜬다.
    // (트리는 folders 테이블로 그리는데 notes.folder 문자열만 넣으면 붕 뜬다 —
    //  CMD+J로는 찾아지는데 목록엔 없어서 한참 헤맸던 버그)
    if (folder) {
      const err = await ensureFolderPath(folder)
      if (err) return fail(err)
    }
    const filePath = folder ? `Notes/${folder}/${title}.md` : `Notes/${title}.md`
    const body = tagged(content ?? `# ${title}\n\n`)
    const row = {
      id: randomUUID(), user_id: USER_ID, type: 'project', title,
      content: body, date: null, file_path: filePath,
      folder: folder ?? null, ...derive(body),
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
    const newContent = `${r.content.replace(/\s+$/, '')}\n${tagged(body)}\n`
    await broadcastTyping(id, true)
    const { error: e2 } = await db.from('notes')
      .update({ content: newContent, ...derive(newContent), updated_at: Date.now() })
      .eq('id', id).eq('user_id', USER_ID)
    await broadcastTyping(id, false)
    if (e2) return fail(e2.message)
    return text(`추가됨 → "${r.title}"`)
  },
)

// 기존 내용 수정 (덧붙이기가 아니라 고치기)
server.tool(
  'update_note',
  `노트 본문 수정. 두 가지 방식:
  • find + replace (권장) — 그 부분만 정확히 바꾼다. 원자로 승격처럼 한 줄을
    [[링크]]로 갈아끼울 때 쓴다. find가 없거나 여러 번 나오면 실패한다(오작동 방지).
  • content — 본문 전체 교체. 사용자가 편집 중이면 그 편집을 덮어쓸 수 있으니
    되도록 find/replace를 쓸 것.
  append_to_note와 달리 #claude 태그를 붙이지 않는다(본문 중간을 고치는 거라).`,
  {
    id: z.string(),
    find: z.string().optional().describe('바꿀 대상 (리터럴, 정규식 아님)'),
    replace: z.string().optional().describe('바꿀 내용. 빈 문자열이면 삭제'),
    content: z.string().optional().describe('본문 전체 교체'),
    all: z.boolean().optional().describe('find가 여러 번 나올 때 전부 바꾸려면 true'),
  },
  async ({ id, find, replace, content, all }) => {
    const findMode = find !== undefined
    if (findMode === (content !== undefined)) {
      return fail('find+replace 또는 content 중 하나만 지정해야 합니다')
    }
    if (findMode && replace === undefined) return fail('find를 쓰면 replace도 필요합니다')

    const { data, error } = await base().eq('id', id).limit(1).maybeSingle()
    if (error) return fail(error.message)
    if (!data) return fail('노트 없음')
    const r = data as Row

    let newContent: string
    let summary: string
    if (findMode) {
      const hits = countOccurrences(r.content, find!)
      if (hits === 0) {
        return fail(`"${find!.slice(0, 60)}" 를 "${r.title}" 본문에서 찾지 못했습니다. ` +
          `get_note로 현재 내용을 확인하세요 (공백·줄바꿈까지 정확히 일치해야 합니다).`)
      }
      if (hits > 1 && !all) {
        return fail(`"${find!.slice(0, 40)}" 가 ${hits}번 나옵니다. ` +
          `더 긴 문맥을 주거나 all:true 로 전부 바꾸세요.`)
      }
      newContent = replaceLiteral(r.content, find!, replace!, !!all)
      summary = all && hits > 1 ? `${hits}곳 수정됨` : '1곳 수정됨'
    } else {
      newContent = content!
      summary = '본문 전체 교체됨'
    }

    if (newContent === r.content) return text(`변경 없음 → "${r.title}"`)

    // 파생값(tags/mentions/backlinks)을 다시 계산한다.
    // 안 하면 사이드바 태그 목록과 백링크 패널에서 노트가 사라진다.
    const d = derive(newContent)
    await broadcastTyping(id, true)
    const { error: e2 } = await db.from('notes')
      .update({ content: newContent, ...d, updated_at: Date.now() })
      .eq('id', id).eq('user_id', USER_ID)
    await broadcastTyping(id, false)
    if (e2) return fail(e2.message)
    return text(`${summary} → "${r.title}" (id:${id})`)
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
      const newContent = `${r.content.replace(/\s+$/, '')}\n${tagged(body)}\n`
      await broadcastTyping(r.id, true)
      const { error } = await db.from('notes')
        .update({ content: newContent, ...derive(newContent), updated_at: now })
        .eq('id', r.id).eq('user_id', USER_ID)
      await broadcastTyping(r.id, false)
      if (error) return fail(error.message)
      return text(`${d} 데일리 노트에 추가됨`)
    }
    const dailyBody = `${tagged(body)}\n`
    const row = {
      id: randomUUID(), user_id: USER_ID, type: 'daily', title: d,
      content: dailyBody, date: d, file_path: `Calendar/${ymd}.md`,
      folder: null, ...derive(dailyBody), created_at: now, updated_at: now,
    }
    const { error } = await db.from('notes').insert(row)
    if (error) return fail(error.message)
    return text(`${d} 데일리 노트 생성 + 추가됨`)
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[noteplan-mcp] ready')
