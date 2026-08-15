'use client'
/**
 * 검색 결과 페이지 — 태그/멘션/폴더를 고르면 메인 영역에 결과가 깔린다.
 *
 * 예전엔 태그를 누르면 좁은 사이드바 안에서 목록이 펼쳐져서, 줄 하나가
 * 두세 줄로 접히고 노트가 어디 있는 건지도 안 보였다. NotePlan처럼
 * 넓은 화면에 구글 검색 결과 형태로 깐다.
 *
 *   ?tag=crng          → #crng (및 #crng/하위)가 있는 '줄'을 노트별로 묶어서
 *   ?mention=이연주     → @멘션도 동일
 *   ?folder=Areas/블랙페이퍼 → 그 폴더(+하위)의 노트 목록
 */
import { Suspense, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useNoteStore } from '@/lib/stores/noteStore'
import { routeForNote } from '@/lib/hooks/useWikiLink'
import {
  collectFacetGroups, notesInFolder, facetTokenRegex, noteRefLabel,
  isCalendarNote, stripHeading, noteExcerpt,
  type FacetKind, type FacetGroup,
} from '@/lib/search/facetSearch'
import type { Note, NoteType } from '@/types/note'

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-[var(--text-muted)]">Loading...</div>}>
      <SearchInner />
    </Suspense>
  )
}

type SortKey = 'recent' | 'oldest'

function SearchInner() {
  const params = useSearchParams()
  const { notes } = useNoteStore()
  const [sort, setSort] = useState<SortKey>('recent')

  const tag     = params.get('tag')     ?? undefined
  const mention = params.get('mention') ?? undefined
  const folder  = params.get('folder')  ?? undefined

  const kind: FacetKind | null = tag ? 'tag' : mention ? 'mention' : null
  const value = tag ?? mention

  const groups = useMemo(() => {
    if (!kind || !value) return []
    const g = collectFacetGroups(notes, kind, value)
    return sort === 'recent' ? g : [...g].reverse()
  }, [notes, kind, value, sort])

  const folderNotes = useMemo(() => {
    if (!folder) return []
    const list = notesInFolder(notes, folder)
    return sort === 'recent' ? list : [...list].reverse()
  }, [notes, folder, sort])

  const isFolderView = !!folder
  const total = isFolderView
    ? folderNotes.length
    : groups.reduce((sum, g) => sum + g.lines.length, 0)

  const heading = isFolderView
    ? folder!.split('/').filter(Boolean)
    : null

  return (
    <div className="flex flex-col h-full">
      {/* ── 헤더 ── */}
      <div data-tauri-drag-region
        className="electron-drag px-12 py-3 border-b border-[var(--border)] flex-shrink-0
                   flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-baseline gap-1.5 min-w-0">
          {isFolderView ? (
            heading!.map((seg, i) => (
              <span key={i} className="flex items-baseline gap-1.5 min-w-0">
                {i > 0 && <span aria-hidden className="text-sm text-[var(--text-muted)] opacity-50">›</span>}
                <span className={i === heading!.length - 1 ? 'truncate' : 'text-sm font-normal text-[var(--text-muted)] truncate'}>
                  {seg}
                </span>
              </span>
            ))
          ) : (
            <span className={kind === 'tag' ? 'text-blue-400' : 'text-purple-400'}>
              {kind === 'tag' ? '#' : '@'}{value}
            </span>
          )}
        </h1>

        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-xs text-[var(--text-muted)]">
            {isFolderView ? `노트 ${total}개` : `${total}개 결과 · 노트 ${groups.length}개`}
          </span>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            className="text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)]
                       border border-[var(--border)] rounded px-1.5 py-1 outline-none"
          >
            <option value="recent">최신순</option>
            <option value="oldest">오래된순</option>
          </select>
        </div>
      </div>

      {/* ── 결과 ── */}
      <div className="flex-1 overflow-y-auto px-12 py-4">
        {!kind && !isFolderView && (
          <Empty>사이드바에서 태그를 누르거나, 노트 상단 경로에서 폴더를 선택하세요.</Empty>
        )}
        {(kind || isFolderView) && total === 0 && (
          <Empty>결과가 없습니다.</Empty>
        )}

        {isFolderView
          ? <div className="flex flex-col gap-1 max-w-3xl">
              {folderNotes.map(n => <FolderRow key={n.id} note={n} />)}
            </div>
          : <div className="flex flex-col gap-5 max-w-3xl">
              {groups.map(g => <Group key={g.noteId} group={g} kind={kind!} value={value!} />)}
            </div>}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-[var(--text-muted)] py-8 text-center">{children}</div>
}

/** 노트 아이콘 — 캘린더 노트와 일반 노트 구분 */
function NoteIcon({ type }: { type: NoteType }) {
  return <span className="flex-shrink-0">{isCalendarNote(type) ? '📅' : '📄'}</span>
}

/** 폴더 경로를 'Areas › 블랙페이퍼' 로 */
function FolderPath({ folder }: { folder?: string }) {
  if (!folder) return null
  return (
    <span className="text-[11px] text-[var(--text-muted)] truncate">
      {folder.split('/').filter(Boolean).join(' › ')}
    </span>
  )
}

function relDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days === 0) return '오늘'
  if (days === 1) return '어제'
  if (days < 30) return `${days}일 전`
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

/** 태그 토큰만 강조 (구글 결과의 굵은 키워드처럼) */
function highlight(line: string, kind: FacetKind, value: string): React.ReactNode[] {
  const re = facetTokenRegex(kind, value)
  const accent = kind === 'tag' ? 'text-blue-400' : 'text-purple-400'
  const parts: React.ReactNode[] = []
  let last = 0, m: RegExpExecArray | null, i = 0
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index))
    parts.push(<span key={i++} className={`${accent} font-medium`}>{m[0]}</span>)
    last = m.index + m[0].length
  }
  if (last < line.length) parts.push(line.slice(last))
  return parts.length ? parts : [line]
}

function Group({ group, kind, value }: { group: FacetGroup; kind: FacetKind; value: string }) {
  const router = useRouter()
  const open = () => router.push(routeForNote({ type: group.noteType, id: group.noteId, date: group.date }))

  return (
    <div>
      {/* 노트 헤더 — 구글 결과의 제목 줄 */}
      <div className="flex items-baseline gap-2 mb-1 min-w-0">
        <NoteIcon type={group.noteType} />
        <button
          onClick={open}
          className="text-[15px] font-medium text-[var(--accent)] hover:underline truncate text-left"
        >
          {noteRefLabel(group)}
        </button>
        <FolderPath folder={group.folder} />
        <span className="text-[11px] text-[var(--text-muted)] flex-shrink-0 ml-auto">
          {relDate(group.updatedAt)}
        </span>
      </div>

      {/* 매칭된 줄들 */}
      <div className="flex flex-col gap-0.5 pl-6 border-l border-[var(--border)]">
        {group.lines.map(m => {
          const { text, isHeading } = stripHeading(m.lineText)
          return (
            <button
              key={m.lineNumber}
              onClick={open}
              className="text-left px-2 py-1 rounded hover:bg-[var(--hover-bg)] transition-colors"
            >
              <span className={`text-[13px] leading-snug line-clamp-2 ${
                isHeading ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
              }`}>
                {highlight(text, kind, value)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FolderRow({ note }: { note: Note }) {
  const router = useRouter()
  const excerpt = noteExcerpt(note.content ?? '')
  return (
    <button
      onClick={() => router.push(routeForNote({ type: note.type, id: note.id, date: note.date }))}
      className="flex flex-col gap-0.5 px-3 py-2 rounded text-left hover:bg-[var(--hover-bg)] transition-colors"
    >
      <span className="flex items-baseline gap-2 min-w-0">
        <NoteIcon type={note.type} />
        <span className="text-[15px] font-medium text-[var(--accent)] truncate">
          {noteRefLabel({ noteType: note.type, date: note.date, title: note.title })}
        </span>
        <FolderPath folder={note.folder} />
        <span className="text-[11px] text-[var(--text-muted)] flex-shrink-0 ml-auto">
          {relDate(note.updatedAt ?? 0)}
        </span>
      </span>
      {excerpt && (
        <span className="text-[13px] text-[var(--text-secondary)] line-clamp-2 leading-snug pl-6">
          {excerpt}
        </span>
      )}
    </button>
  )
}
