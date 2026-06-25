import { startOfISOWeek, addDays, format } from 'date-fns'
import { v4 as uuidv4 } from 'uuid'
import type { Note, NoteType } from '@/types/note'
import { extractTags, extractMentions, extractBacklinks } from '@/lib/parser/noteParser'

export interface ImportFileMeta {
  type: NoteType
  date: string         // YYYY-MM-DD
  filePath: string     // Calendar/YYYYMMDD.md 등
  title: string
}

/**
 * 파일명으로부터 노트 타입 및 날짜를 파싱합니다.
 *
 * 지원 형식:
 *  - Daily:   YYYYMMDD.txt        (예: 20240901.txt)
 *  - Weekly:  YYYY-WNN.txt        (예: 2025-W29.txt)
 *  - Monthly: YYYY-MM.txt         (예: 2025-04.txt)
 *  - Yearly:  YYYY.txt            (예: 2024.txt)
 */
export function parseBackupFilename(filename: string): ImportFileMeta | null {
  // 확장자 제거 (.txt / .md 모두 허용)
  const base = filename.replace(/\.(txt|md)$/i, '')

  // ── Daily: YYYYMMDD ──────────────────────────────────────────────────────
  if (/^\d{8}$/.test(base)) {
    const y = base.slice(0, 4)
    const m = base.slice(4, 6)
    const d = base.slice(6, 8)
    const date = `${y}-${m}-${d}`
    return { type: 'daily', date, filePath: `Calendar/${base}.md`, title: date }
  }

  // ── Weekly: YYYY-WNN ─────────────────────────────────────────────────────
  const weekMatch = base.match(/^(\d{4})-W(\d{1,2})$/)
  if (weekMatch) {
    const year = parseInt(weekMatch[1])
    const week = parseInt(weekMatch[2])
    // ISO 주: 1월 4일이 항상 1주차 → 1주차 월요일 + (N-1)*7일
    const startOfWeek1 = startOfISOWeek(new Date(year, 0, 4))
    const weekStart = addDays(startOfWeek1, (week - 1) * 7)
    const date = format(weekStart, 'yyyy-MM-dd')
    return { type: 'weekly', date, filePath: `Calendar/${base}.md`, title: base }
  }

  // ── Monthly: YYYY-MM ─────────────────────────────────────────────────────
  const monthMatch = base.match(/^(\d{4})-(\d{2})$/)
  if (monthMatch) {
    const date = `${monthMatch[1]}-${monthMatch[2]}-01`
    return { type: 'monthly', date, filePath: `Calendar/${base}.md`, title: base }
  }

  // ── Yearly: YYYY ─────────────────────────────────────────────────────────
  if (/^\d{4}$/.test(base)) {
    return {
      type: 'yearly',
      date: `${base}-01-01`,
      filePath: `Calendar/${base}.md`,
      title: base,
    }
  }

  return null
}

/** 파일명 + 내용 → Note 객체 변환 */
export function parseBackupFile(filename: string, content: string): Note | null {
  const meta = parseBackupFilename(filename)
  if (!meta) return null
  const now = Date.now()
  return {
    id: uuidv4(),
    type: meta.type,
    title: meta.title,
    content,
    date: meta.date,
    filePath: meta.filePath,
    tags: extractTags(content),
    mentions: extractMentions(content),
    backlinks: extractBacklinks(content),
    createdAt: now,
    updatedAt: now,
  }
}

/** File[] → Note[] (파싱 불가 파일은 skip) */
export async function readFilesAsNotes(
  files: File[]
): Promise<{ notes: Note[]; skippedFilenames: string[] }> {
  const notes: Note[] = []
  const skippedFilenames: string[] = []

  await Promise.all(
    files.map(async file => {
      const content = await file.text()
      const note = parseBackupFile(file.name, content)
      if (note) notes.push(note)
      else skippedFilenames.push(file.name)
    })
  )

  // 날짜 오름차순 정렬
  notes.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  return { notes, skippedFilenames }
}

/** 노트 타입별 집계 */
export function countByType(notes: Note[]): Record<NoteType, number> {
  const counts: Record<NoteType, number> = {
    daily: 0, weekly: 0, monthly: 0, yearly: 0, project: 0,
  }
  for (const n of notes) counts[n.type]++
  return counts
}
