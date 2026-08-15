/**
 * #태그 / @멘션 검색 — 사이드바와 검색 결과 페이지가 공유한다.
 *
 * 매칭 규칙을 한 곳에 두는 이유: 예전엔 사이드바 안에 사본이 있었는데,
 * 계층 매칭(#a 가 #a/b 도 잡는다)이나 한글 처리 같은 게 한쪽만 바뀌면
 * 같은 태그를 눌러도 결과가 달라진다.
 */
import { extractTags, extractMentions } from '@/lib/parser/noteParser'
import type { Note, NoteType } from '@/types/note'

export type FacetKind = 'tag' | 'mention'

export const KO_RANGE = '가-힣ㄱ-ㅎㅏ-ㅣ'

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `#value` 와 그 하위(`#value/sub`)를 잡는 정규식 */
export function facetTokenRegex(kind: FacetKind, value: string): RegExp {
  const sigil = kind === 'tag' ? '#' : '@'
  return new RegExp(`(${sigil}${escapeRegExp(value)}[\\w/${KO_RANGE}]*)`, 'g')
}

/** 한 줄이 해당 태그(또는 그 하위)를 포함하는지 */
export function lineHasFacet(line: string, kind: FacetKind, value: string): boolean {
  const tokens = kind === 'tag' ? extractTags(line) : extractMentions(line)
  return tokens.some(t => t === value || t.startsWith(value + '/'))
}

export interface FacetMatch {
  noteId: string
  noteType: NoteType
  date?: string
  title: string
  folder?: string
  updatedAt: number
  lineText: string
  /** 노트 안에서 몇 번째 줄인지 (1-based) — 결과 순서 유지용 */
  lineNumber: number
}

/** 노트 하나로 묶인 결과 (구글 검색처럼 노트 단위로 그룹) */
export interface FacetGroup {
  noteId: string
  noteType: NoteType
  date?: string
  title: string
  folder?: string
  updatedAt: number
  lines: FacetMatch[]
}

/** 태그/멘션이 등장하는 모든 줄을 노트별로 묶어 최신순으로 돌려준다 */
export function collectFacetGroups(
  notes: Note[],
  kind: FacetKind,
  value: string,
): FacetGroup[] {
  const groups: FacetGroup[] = []
  for (const n of notes) {
    const lines = (n.content ?? '').split('\n')
    const hits: FacetMatch[] = []
    lines.forEach((raw, i) => {
      const line = raw.trim()
      if (!line) return
      if (!lineHasFacet(line, kind, value)) return
      hits.push({
        noteId: n.id, noteType: n.type, date: n.date, title: n.title,
        folder: n.folder, updatedAt: n.updatedAt ?? 0,
        lineText: line, lineNumber: i + 1,
      })
    })
    if (hits.length === 0) continue
    groups.push({
      noteId: n.id, noteType: n.type, date: n.date, title: n.title,
      folder: n.folder, updatedAt: n.updatedAt ?? 0, lines: hits,
    })
  }
  groups.sort((a, b) => b.updatedAt - a.updatedAt)
  return groups
}

/**
 * 폴더(+하위 폴더)에 속한 노트들. 최신순.
 * NotePlan의 폴더 뷰가 하위 폴더까지 포함하므로 그에 맞춘다.
 */
export function notesInFolder(notes: Note[], folderPath: string): Note[] {
  const prefix = folderPath + '/'
  return notes
    .filter(n => n.folder === folderPath || (n.folder ?? '').startsWith(prefix))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** 캘린더 노트는 날짜가, 일반 노트는 제목이 이름 역할을 한다 */
export function noteRefLabel(n: { noteType: NoteType; date?: string; title: string }): string {
  if (n.noteType === 'daily' && n.date) return n.date
  if (n.noteType === 'weekly' && n.date) return `Week of ${n.date}`
  if (n.noteType === 'monthly' && n.date) return n.date
  return n.title
}

export function isCalendarNote(t: NoteType): boolean {
  return t === 'daily' || t === 'weekly' || t === 'monthly' || t === 'yearly'
}

/** 헤딩 마커(#, ##…)는 본문에서 떼고 굵게 표시하기 위한 분해 */
export function stripHeading(line: string): { text: string; isHeading: boolean } {
  const m = line.match(/^(#{1,6})\s+(.*)$/)
  return m ? { text: m[2], isHeading: true } : { text: line, isHeading: false }
}

/** 노트 본문에서 제목/빈 줄을 뺀 첫 문장 — 폴더 뷰의 미리보기 */
export function noteExcerpt(content: string, max = 160): string {
  for (const raw of (content ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) continue        // 제목 줄
    if (/^(-{3,}|={3,})$/.test(line)) continue  // 구분선
    return line.length > max ? line.slice(0, max) + '…' : line
  }
  return ''
}
