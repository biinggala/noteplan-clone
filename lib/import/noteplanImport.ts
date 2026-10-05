import { format } from 'date-fns'
import { v4 as uuidv4 } from 'uuid'
import type { Note, NoteType } from '@/types/note'
import { extractTags, extractMentions, extractBacklinks, extractSupersedes } from '@/lib/parser/noteParser'

export interface ImportFileMeta {
  type: NoteType
  date: string         // 앱의 날짜 키: daily YYYY-MM-DD / weekly YYYY-WNN / monthly YYYY-MM / yearly YYYY
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
  // 앱이 주간 노트를 찾는 키('YYYY-WNN', 두 자리)와 같게 저장한다. 예전엔 그 주
  // 월요일 날짜(YYYY-MM-DD)로 저장해서, 가져온 주간 노트가 주간 화면에 안 뜨고
  // 대신 그 월요일 '데일리' 화면에서 열려 거기에 적히는 문제가 있었다.
  // 주 번호는 NotePlan 파일 이름 그대로 쓴다 (앱의 CW 번호 규칙과 같은 번호).
  const weekMatch = base.match(/^(\d{4})-W(\d{1,2})$/)
  if (weekMatch) {
    const year = weekMatch[1]
    const week = parseInt(weekMatch[2])
    const key = `${year}-W${String(week).padStart(2, '0')}`
    return { type: 'weekly', date: key, filePath: `Calendar/${key}.md`, title: `Week ${week}, ${year}` }
  }

  // ── Monthly: YYYY-MM ─────────────────────────────────────────────────────
  const monthMatch = base.match(/^(\d{4})-(\d{2})$/)
  if (monthMatch) {
    const key = `${monthMatch[1]}-${monthMatch[2]}`
    const title = format(new Date(parseInt(monthMatch[1]), parseInt(monthMatch[2]) - 1, 1), 'MMMM yyyy')
    return { type: 'monthly', date: key, filePath: `Calendar/${key}.md`, title }
  }

  // ── Yearly: YYYY ─────────────────────────────────────────────────────────
  if (/^\d{4}$/.test(base)) {
    return { type: 'yearly', date: base, filePath: `Calendar/${base}.md`, title: base }
  }

  return null
}

// NotePlan PARA 폴더명 → 클론 PARA 폴더명
const PARA_MAP: Record<string, string> = {
  '10 - Projects': 'Projects',
  '20 - Areas': 'Areas',
  '30 - Resources': 'Resources',
  '40 - Archive': 'Archive',
}

/**
 * 폴더 구조(webkitRelativePath)로부터 프로젝트 노트를 파싱.
 * 예: "Notes/10 - Projects/Cringe Friends/방향성.txt"
 *   → folder="Projects/Cringe Friends", title="방향성", type=project
 * PARA 폴더(10-Projects 등)가 아닌 경로(@Trash/@Templates/Calendar)는 null.
 */
export function parseProjectFile(relativePath: string, content: string): Note | null {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts[0] === 'Notes') parts.shift()      // 백업 루트가 Notes/ 일 때
  if (parts.length < 1) return null
  const para = PARA_MAP[parts[0]]
  if (!para) return null                         // PARA 폴더 아님 → skip
  const fileName = parts[parts.length - 1]
  if (!/\.(txt|md)$/i.test(fileName)) return null
  const subSegs = parts.slice(1, -1)             // 하위 폴더들
  const folder = [para, ...subSegs].join('/')
  const base = fileName.replace(/\.(txt|md)$/i, '')
  const now = Date.now()
  return {
    id: uuidv4(),
    type: 'project',
    title: base,
    content,
    filePath: `Notes/${folder}/${base}.md`,
    folder,
    tags: extractTags(content),
    mentions: extractMentions(content),
    backlinks: extractBacklinks(content), supersedes: extractSupersedes(content),
    createdAt: now,
    updatedAt: now,
  }
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
    backlinks: extractBacklinks(content), supersedes: extractSupersedes(content),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * File[] → Note[] (파싱 불가 파일은 skip)
 * Calendar 노트(파일명 기반) + PARA 프로젝트 노트(폴더경로 기반) 모두 처리.
 * 폴더 선택 시 file.webkitRelativePath로 하위 폴더 구조를 보존.
 * folderPaths: 프로젝트 노트가 필요로 하는 폴더 경로(중간 단계 포함) 목록.
 */
export async function readFilesAsNotes(
  files: File[]
): Promise<{ notes: Note[]; skippedFilenames: string[]; folderPaths: string[] }> {
  const notes: Note[] = []
  const skippedFilenames: string[] = []
  const folderSet = new Set<string>()

  await Promise.all(
    files.map(async file => {
      const content = await file.text()
      const rel = (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || file.name
      // 1) PARA 프로젝트 (폴더 경로) → 2) Calendar (파일명)
      // 프로젝트 폴더 안의 '2024.md' 같은 파일을 연간 노트로 오인하지 않도록
      // 폴더 경로가 PARA 면 먼저 프로젝트로 본다.
      const note = parseProjectFile(rel, content) ?? parseBackupFile(file.name, content)
      if (note) {
        notes.push(note)
        if (note.type === 'project' && note.folder) {
          const segs = note.folder.split('/')
          for (let i = 1; i <= segs.length; i++) folderSet.add(segs.slice(0, i).join('/'))
        }
      } else {
        skippedFilenames.push(rel)
      }
    })
  )

  // Calendar는 날짜순, 프로젝트는 제목순
  notes.sort((a, b) => (a.date ?? a.title).localeCompare(b.date ?? b.title))
  return { notes, skippedFilenames, folderPaths: [...folderSet] }
}

/** 노트 타입별 집계 */
export function countByType(notes: Note[]): Record<NoteType, number> {
  const counts: Record<NoteType, number> = {
    daily: 0, weekly: 0, monthly: 0, yearly: 0, project: 0,
  }
  for (const n of notes) counts[n.type]++
  return counts
}
