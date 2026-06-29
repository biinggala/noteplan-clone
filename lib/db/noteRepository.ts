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

/** 특정 태그를 포함하는 노트 목록 (tags 배열 contains 쿼리) */
export async function getNotesByTag(tag: string): Promise<Note[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .contains('tags', [tag])
    .order('updated_at', { ascending: false })
  return (data ?? []).map(rowToNote)
}

/** 특정 멘션을 포함하는 노트 목록 */
export async function getNotesByMention(mention: string): Promise<Note[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .contains('mentions', [mention])
    .order('updated_at', { ascending: false })
  return (data ?? []).map(rowToNote)
}

/** folder가 null인 노트 (미분류) */
export async function getUnfiledNotes(): Promise<Note[]> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data } = await supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .is('folder', null)
    .in('type', ['project'])   // project 타입만 (daily/weekly/monthly는 제외)
    .order('updated_at', { ascending: false })
  return (data ?? []).map(rowToNote)
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

// ── Bulk Import ───────────────────────────────────────────────────────────────

export interface BulkImportResult {
  imported: number
  skipped: number   // 이미 존재해서 건너뜀
  errors: number
  firstError?: string  // 디버깅용 첫 번째 에러 메시지
}

/**
 * 노트를 일괄 삽입합니다.
 * - onConflict='skip': 같은 file_path가 이미 있으면 건너뜀 (기본값)
 * - onConflict='overwrite': 기존 노트를 덮어씀
 * - onProgress: 처리된 누적 개수를 콜백으로 전달
 */
export async function bulkImportNotes(
  notes: Note[],
  opts: {
    onConflict?: 'skip' | 'overwrite'
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<BulkImportResult> {
  const { onConflict = 'skip', onProgress } = opts
  const supabase = createClient()
  const userId = await getUserId()

  // 1) 기존 filePath 목록을 한 번에 조회
  const { data: existing } = await supabase
    .from('notes')
    .select('id, file_path')
    .eq('user_id', userId)

  const existingMap = new Map<string, string>()  // filePath → id
  for (const row of existing ?? []) {
    existingMap.set(row.file_path as string, row.id as string)
  }

  // 2) skip / overwrite 분류
  const toInsert: Note[] = []
  const toUpdate: Note[] = []
  let skipped = 0

  for (const note of notes) {
    const existingId = existingMap.get(note.filePath)
    if (existingId) {
      if (onConflict === 'overwrite') {
        toUpdate.push({ ...note, id: existingId })
      } else {
        skipped++
      }
    } else {
      toInsert.push(note)
    }
  }

  let imported = 0
  let errors = 0
  const total = toInsert.length + toUpdate.length
  let done = 0

  // 3) 신규 노트 일괄 insert (50개씩)
  const CHUNK = 50
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK)
    const rows = chunk.map(n => noteToRow(n, userId))
    const { error } = await supabase.from('notes').insert(rows)
    if (error) {
      console.error('[bulkImport insert]', error)
      errors += chunk.length
    } else {
      imported += chunk.length
    }
    done += chunk.length
    onProgress?.(done + skipped, notes.length)
  }

  // 4) 기존 노트 overwrite (50개씩)
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const chunk = toUpdate.slice(i, i + CHUNK)
    const rows = chunk.map(n => noteToRow({ ...n, updatedAt: Date.now() }, userId))
    const { error } = await supabase
      .from('notes')
      .upsert(rows, { onConflict: 'id' })
    if (error) {
      console.error('[bulkImport upsert]', error)
      errors += chunk.length
    } else {
      imported += chunk.length
    }
    done += chunk.length
    onProgress?.(done + skipped, notes.length)
  }

  return { imported, skipped, errors }
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

export async function getOrCreateMonthlyNote(monthKey: string): Promise<Note> {
  // monthKey = "YYYY-MM"
  const supabase = createClient()
  const userId = await getUserId()

  const [yearStr, monthStr] = monthKey.split('-')
  const year  = parseInt(yearStr)
  const month = parseInt(monthStr)   // 1-based
  const firstDay = new Date(year, month - 1, 1)
  const title = format(firstDay, 'MMMM yyyy')
  const dateStr = `${yearStr}-${monthStr}-01`

  const row = {
    id:         uuidv4(),
    user_id:    userId,
    type:       'monthly' as const,
    title,
    content:    `# ${title}\n\n## Goals\n\n## Review\n\n## Notes\n`,
    date:       monthKey,          // "YYYY-MM" — date 컬럼에 monthKey 저장
    file_path:  `Calendar/${monthKey}.md`,
    folder:     null,
    tags:       [] as string[],
    mentions:   [] as string[],
    backlinks:  [] as string[],
    created_at: Date.now(),
    updated_at: Date.now(),
  }

  const existing = await getNoteByDate(monthKey)
  if (existing) return existing

  const { error } = await supabase.from('notes').insert(row)
  if (error && error.code !== '23505') {
    console.error('[getOrCreateMonthlyNote] insert error', error)
  }

  const note = await getNoteByDate(monthKey)
  if (!note) throw new Error(`월간 노트 생성 실패: ${monthKey}`)
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

/** 노트를 다른 폴더로 이동 (folder + file_path 갱신). folderPath='' 이면 미분류. */
export async function moveNote(noteId: string, folderPath: string): Promise<void> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data: n } = await supabase
    .from('notes').select('file_path').eq('id', noteId).eq('user_id', userId).single()
  if (!n) return
  const base = (n.file_path as string).split('/').pop()
  const newFile = folderPath ? `Notes/${folderPath}/${base}` : `Notes/${base}`
  await supabase.from('notes')
    .update({ folder: folderPath || null, file_path: newFile, updated_at: Date.now() })
    .eq('id', noteId).eq('user_id', userId)
}

/**
 * 폴더를 다른 폴더 밑으로 이동. 자손 폴더 path + 내부 노트 folder/file_path를 cascade 갱신.
 * newParentPath=null 이면 최상위로. 자기 자신/자손으로의 이동은 거부.
 */
export async function moveFolder(folderId: string, newParentPath: string | null): Promise<void> {
  const supabase = createClient()
  const userId = await getUserId()
  const { data: folderRow } = await supabase
    .from('folders').select('id, name, path').eq('id', folderId).eq('user_id', userId).single()
  if (!folderRow) return
  const oldPath = folderRow.path as string
  const name = folderRow.name as string
  const newPath = newParentPath ? `${newParentPath}/${name}` : name
  if (newPath === oldPath) return
  // 순환 방지: 새 부모가 자기 자신 또는 자손이면 거부
  if (newParentPath && (newParentPath === oldPath || newParentPath.startsWith(oldPath + '/'))) return

  // 새 parentId
  let parentId: string | null = null
  if (newParentPath) {
    const { data: p } = await supabase
      .from('folders').select('id').eq('user_id', userId).eq('path', newParentPath).maybeSingle()
    parentId = p?.id ?? null
  }

  // 자기 자신 + 자손 폴더 path 갱신
  const { data: allFolders } = await supabase
    .from('folders').select('id, path').eq('user_id', userId)
  for (const f of allFolders ?? []) {
    const p = f.path as string
    if (p === oldPath) {
      await supabase.from('folders').update({ path: newPath, parent_id: parentId }).eq('id', f.id).eq('user_id', userId)
    } else if (p.startsWith(oldPath + '/')) {
      await supabase.from('folders').update({ path: newPath + p.slice(oldPath.length) }).eq('id', f.id).eq('user_id', userId)
    }
  }

  // 영향받는 노트 folder + file_path 갱신
  const { data: notes } = await supabase
    .from('notes').select('id, folder, file_path').eq('user_id', userId)
  for (const n of notes ?? []) {
    const nf = n.folder as string | null
    if (!nf) continue
    if (nf === oldPath || nf.startsWith(oldPath + '/')) {
      const newFolder = newPath + nf.slice(oldPath.length)
      const base = (n.file_path as string).split('/').pop()
      await supabase.from('notes')
        .update({ folder: newFolder, file_path: `Notes/${newFolder}/${base}`, updated_at: Date.now() })
        .eq('id', n.id).eq('user_id', userId)
    }
  }
}

/**
 * 주어진 폴더 경로들을 idempotent하게 생성 (얕은 단계부터, 이미 있으면 skip).
 * import 시 하위 폴더(Projects/Cringe Friends 등)를 미리 만들어 노트가 트리에 보이게 함.
 */
export async function ensureFolders(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const supabase = createClient()
  const userId = await getUserId()
  const { data: existing } = await supabase
    .from('folders')
    .select('path')
    .eq('user_id', userId)
  const have = new Set((existing ?? []).map(r => r.path as string))

  // 얕은 경로부터 생성해야 parentId 조회가 성립
  const sorted = [...new Set(paths)].sort((a, b) => a.split('/').length - b.split('/').length)
  for (const path of sorted) {
    if (have.has(path)) continue
    const segs = path.split('/')
    const name = segs[segs.length - 1]
    const parentPath = segs.length > 1 ? segs.slice(0, -1).join('/') : undefined
    try {
      await createFolder(name, parentPath)
      have.add(path)
    } catch (e) {
      console.error('[ensureFolders]', path, e)
    }
  }
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
