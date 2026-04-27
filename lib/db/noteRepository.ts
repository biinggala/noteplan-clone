import type { Note, NoteType, Folder } from '@/types/note'
import { format, addDays, startOfISOWeek, endOfISOWeek } from 'date-fns'
import { v4 as uuidv4 } from 'uuid'
import { createClient } from '@/lib/supabase/client'

// ── Supabase row → Note 변환 ─────────────────────────────────────────────────

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id:        row.id as string,
    type:      row.type as NoteType,
    title:     row.title as string,
    content:   row.content as string,
    date:      row.date as string | undefined,
    filePath:  row.file_path as string,
    folder:    row.folder as string | undefined,
    tags:      (row.tags as string[]) ?? [],
    mentions:  (row.mentions as string[]) ?? [],
    backlinks: (row.backlinks as string[]) ?? [],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

function noteToRow(note: Partial<Note> & { id: string }, userId: string) {
  return {
    id:         note.id,
    user_id:    userId,
    type:       note.type,
    title:      note.title,
    content:    note.content ?? '',
    date:       note.date ?? null,
    file_path:  note.filePath,
    folder:     note.folder ?? null,
    tags:       note.tags ?? [],
    mentions:   note.mentions ?? [],
    backlinks:  note.backlinks ?? [],
    created_at: note.createdAt ?? Date.now(),
    updated_at: note.updatedAt ?? Date.now(),
  }
}

function rowToFolder(row: Record<string, unknown>): Folder {
  return {
    id:       row.id as string,
    name:     row.name as string,
    parentId: row.parent_id as string | undefined,
    path:     row.path as string,
  }
}

// ── 유저 ID 헬퍼 ─────────────────────────────────────────────────────────────

async function getUserId(): Promise<string> {
  const supabase = createClient()
  // getSession()은 localStorage에서 읽어 네트워크 불필요 — 언마운트 cleanup에서도 안전
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) throw new Error('로그인이 필요합니다')
  return session.user.id
}

// ── Note CRUD ─────────────────────────────────────────────────────────────────

export async function getNoteByDate(date: string): Promise<Note | undefined> {
  const supabase = createClient()
  const userId = await getUserId()
  // maybeSingle() 대신 limit(1) 사용 — 중복 행이 있어도 에러 없이 첫 번째 반환
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('date', date)
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) console.error('[getNoteByDate]', error)
  return data && data.length > 0 ? rowToNote(data[0]) : undefined
}

export async function getNoteById(id: string): Promise<Note | undefined> {
  const supabase = createClient()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  return data ? rowToNote(data) : undefined
}

export async function getAllNotes(): Promise<Note[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  return (data ?? []).map(rowToNote)
}

export async function getNotesByType(type: NoteType): Promise<Note[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('type', type)
    .order('date', { ascending: true })
  return (data ?? []).map(rowToNote)
}

export async function upsertNote(note: Note): Promise<Note> {
  const supabase = createClient()
  const userId = await getUserId()
  const row = noteToRow({ ...note, updatedAt: Date.now() }, userId)
  const { data, error } = await supabase
    .from('notes')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single()
  if (error) throw error
  return rowToNote(data)
}

export async function deleteNote(id: string): Promise<void> {
  const supabase = createClient()
  await supabase.from('notes').delete().eq('id', id)
}

export async function searchNotes(query: string): Promise<Note[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
    .order('updated_at', { ascending: false })
    .limit(20)
  return (data ?? []).map(rowToNote)
}

// ── Daily / Weekly Note 자동 생성 ────────────────────────────────────────────

export async function getOrCreateDailyNote(dateStr: string): Promise<Note> {
  const supabase = createClient()
  const userId = await getUserId()

  const [year, month, day] = dateStr.split('-').map(Number)
  const dateObj = new Date(year, month - 1, day)

  const row = {
    id:         uuidv4(),
    user_id:    userId,
    type:       'daily' as const,
    title:      dateStr,
    content:    `# ${format(dateObj, 'MMMM d, yyyy')}\n\n## Tasks\n\n## Notes\n`,
    date:       dateStr,
    file_path:  `Calendar/${dateStr.replace(/-/g, '')}.md`,
    folder:     null,
    tags:       [] as string[],
    mentions:   [] as string[],
    backlinks:  [] as string[],
    created_at: Date.now(),
    updated_at: Date.now(),
  }

  // 먼저 기존 노트 조회 — 있으면 바로 반환 (중복 생성 방지)
  const existing = await getNoteByDate(dateStr)
  if (existing) return existing

  // 없으면 insert (중복 키 에러는 무시 — Strict Mode 이중 실행 대비)
  const { error } = await supabase.from('notes').insert(row)
  if (error && error.code !== '23505') {
    // 23505 = unique_violation (동시 요청으로 이미 생성됨) → 무시
    console.error('[getOrCreateDailyNote] insert error', error)
  }

  // 항상 DB에서 최신 fetch
  const note = await getNoteByDate(dateStr)
  if (!note) throw new Error(`노트 생성 실패: ${dateStr}`)
  return note
}

function weekKeyToMonday(weekKey: string): Date {
  const [yearStr, weekPart] = weekKey.split('-W')
  const year = parseInt(yearStr)
  const week = parseInt(weekPart)
  const jan4 = new Date(year, 0, 4)
  const startW1 = startOfISOWeek(jan4)
  return addDays(startW1, (week - 1) * 7)
}

export async function getOrCreateWeeklyNote(weekKey: string): Promise<Note> {
  const supabase = createClient()
  const userId = await getUserId()

  const monday = weekKeyToMonday(weekKey)
  const sunday = endOfISOWeek(monday)
  const weekNum = weekKey.split('-W')[1]
  const year = weekKey.split('-W')[0]
  const rangeLabel = `${format(monday, 'MMM d')} – ${format(sunday, 'MMM d, yyyy')}`
  const title = `Week ${parseInt(weekNum)}, ${year}`

  const row = {
    id:         uuidv4(),
    user_id:    userId,
    type:       'weekly' as const,
    title,
    content:    `# ${title}\n${rangeLabel}\n\n## Goals\n\n## Tasks\n\n## Notes\n`,
    date:       weekKey,
    file_path:  `Calendar/${weekKey}.md`,
    folder:     null,
    tags:       [] as string[],
    mentions:   [] as string[],
    backlinks:  [] as string[],
    created_at: Date.now(),
    updated_at: Date.now(),
  }

  const existing = await getNoteByDate(weekKey)
  if (existing) return existing

  const { error } = await supabase.from('notes').insert(row)
  if (error && error.code !== '23505') {
    console.error('[getOrCreateWeeklyNote] insert error', error)
  }

  const note = await getNoteByDate(weekKey)
  if (!note) throw new Error(`주간 노트 생성 실패: ${weekKey}`)
  return note
}

// ── 날짜 범위 노트 요약 (미니 캘린더 태스크 점용) ────────────────────────────

export async function getNoteSummariesByDateRange(
  startDate: string,
  endDate: string,
): Promise<Array<{ date: string; content: string }>> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data, error } = await supabase
    .from('notes')
    .select('date, content')
    .eq('user_id', userId)
    .gte('date', startDate)
    .lte('date', endDate)
    .not('date', 'is', null)
  if (error) console.error('[getNoteSummariesByDateRange]', error)
  return (data ?? []) as Array<{ date: string; content: string }>
}

// ── Folder CRUD ──────────────────────────────────────────────────────────────

export async function getFolders(): Promise<Folder[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('folders')
    .select('*')
    .eq('user_id', userId)
  return (data ?? []).map(rowToFolder)
}

export async function createFolder(name: string, parentPath?: string): Promise<Folder> {
  const supabase = createClient()
  const userId = await getUserId()
  const path = parentPath ? `${parentPath}/${name}` : name
  let parentId: string | undefined

  if (parentPath) {
    const { data } = await supabase
      .from('folders')
      .select('id')
      .eq('user_id', userId)
      .eq('path', parentPath)
      .maybeSingle()
    parentId = data?.id
  }

  const folder = { id: uuidv4(), user_id: userId, name, parent_id: parentId ?? null, path }
  const { data, error } = await supabase.from('folders').insert(folder).select().single()
  if (error) throw error
  return rowToFolder(data)
}

export async function deleteFolder(id: string): Promise<void> {
  const supabase = createClient()
  const userId = await getUserId()

  // 하위 폴더 재귀 삭제
  const { data: subs } = await supabase
    .from('folders')
    .select('id')
    .eq('user_id', userId)
    .eq('parent_id', id)
  for (const sub of subs ?? []) await deleteFolder(sub.id)

  await supabase.from('folders').delete().eq('id', id)
}

export async function renameFolder(id: string, newName: string): Promise<Folder | undefined> {
  const supabase = createClient()
  const userId = await getUserId()

  const { data: folder } = await supabase
    .from('folders')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!folder) return undefined

  const oldPath = folder.path as string
  const newPath = oldPath.includes('/')
    ? oldPath.substring(0, oldPath.lastIndexOf('/') + 1) + newName
    : newName

  // 하위 폴더 경로 일괄 업데이트
  const { data: allFolders } = await supabase
    .from('folders')
    .select('*')
    .eq('user_id', userId)
  for (const f of allFolders ?? []) {
    if ((f.path as string).startsWith(oldPath + '/')) {
      const updatedPath = newPath + (f.path as string).slice(oldPath.length)
      await supabase.from('folders').update({ path: updatedPath }).eq('id', f.id)
    }
  }

  const { data, error } = await supabase
    .from('folders')
    .update({ name: newName, path: newPath })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return rowToFolder(data)
}

export async function getNotesByFolder(folderPath: string): Promise<Note[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .eq('folder', folderPath)
  return (data ?? []).map(rowToNote)
}

// ── PARA 기본 폴더 초기화 ────────────────────────────────────────────────────

export async function initDefaultFolders(): Promise<void> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data: existing } = await supabase
    .from('folders')
    .select('path')
    .eq('user_id', userId)
  const existingPaths = new Set((existing ?? []).map((f) => f.path as string))

  const defaults = ['Projects', 'Areas', 'Resources', 'Archive']
  for (const name of defaults) {
    if (!existingPaths.has(name)) await createFolder(name)
  }
}
