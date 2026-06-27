'use client'
import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { format, subDays, addDays } from 'date-fns'
import { useUIStore } from '@/lib/stores/uiStore'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { useNoteStore } from '@/lib/stores/noteStore'
import { useAuthStore } from '@/lib/stores/authStore'
import { getAllNotes } from '@/lib/db/noteRepository'
import { createClient } from '@/lib/supabase/client'
import type { Note } from '@/types/note'
import FolderTree from './FolderTree'
import ThemePicker from '@/components/ThemePicker'
import ImportModal from '@/components/import/ImportModal'
import { getFolders, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions } from '@/lib/parser/noteParser'
import { v4 as uuidv4 } from 'uuid'
import type { Folder } from '@/types/note'

const NAV_ICON = {
  calendar: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  monthly: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14h6" />
    </svg>
  ),
  note: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  tag: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
    </svg>
  ),
  review: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
}

export default function LeftSidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // 정적 SPA 라우팅: pathname + 쿼리스트링으로 현재 URL 재구성
  const search = searchParams.toString()
  const currentUrl = search ? `${pathname}?${search}` : pathname
  const { activeTab, setActiveTab, setCommandBarOpen } = useUIStore()
  const { selectedDate, today } = useCalendarStore()
  const { notes, setNotes, activeNote } = useNoteStore()
  const [projectNotes, setProjectNotes] = useState<Note[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [newNoteOpen, setNewNoteOpen] = useState(false)

  // 태그/멘션은 노트 content에서 직접 재파싱한다.
  // (저장된 n.tags/n.mentions는 과거 정규식으로 파싱돼 #a/b 같은 계층 경로가
  //  잘려 있을 수 있으므로, 항상 현재 파서로 content를 다시 읽어 단일 진실원천으로 삼음)
  const allTags = useMemo(() => {
    const fromNotes = notes.flatMap(n => extractTags(n.content ?? ''))
    const fromActive = activeNote?.content ? extractTags(activeNote.content) : []
    return [...new Set([...fromNotes, ...fromActive])].sort()
  }, [notes, activeNote?.content])

  const allMentions = useMemo(() => {
    const fromNotes = notes.flatMap(n => extractMentions(n.content ?? ''))
    const fromActive = activeNote?.content ? extractMentions(activeNote.content) : []
    return [...new Set([...fromNotes, ...fromActive])].sort()
  }, [notes, activeNote?.content])

  const todayDate = new Date()
  const yesterdayStr = format(subDays(todayDate, 1), 'yyyy-MM-dd')
  const tomorrowStr  = format(addDays(todayDate, 1), 'yyyy-MM-dd')
  const thisMonthStr = format(todayDate, 'yyyy-MM')   // e.g. "2026-05"

  // Delay active-state highlight until after hydration —
  // usePathname() returns null on the server so the className would mismatch.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    getAllNotes().then(allNotes => {
      setNotes(allNotes)
      setProjectNotes(allNotes.filter(n => n.type === 'project'))
    })
  }, [setNotes])

  const navItem = (label: string, path: string, icon: React.ReactNode) => {
    const isActive = mounted && currentUrl === path
    return (
      <button
        onClick={() => router.push(path)}
        className={`flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-sm transition-colors
          ${isActive
            ? 'bg-blue-500/20 text-blue-400'
            : 'text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]'
          }`}
      >
        {icon}
        {label}
      </button>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── macOS titlebar 영역 (y=0~52) ──────────────────────────────
          traffic light 3버튼이 x≈8–72, y≈8–20 에 macOS가 직접 그림.
          80px 왼쪽 여백을 비워두고 앱 이름을 표시.
          titlebar-drag CSS class → -webkit-app-region: drag 적용     */}
      {/* -webkit-app-region은 Electron insertCSS로만 주입 (CSS class 방식은 Electron에서 불안정) */}
      <div
        data-tauri-drag-region className="electron-drag flex-shrink-0 flex items-center border-b border-[var(--border)]"
        style={{ height: 52 }}
      >
        <span
          className="text-xs font-semibold select-none"
          style={{ marginLeft: 80, color: 'var(--text-muted)', opacity: 0.7 }}
        >
          NotePlan Clone
        </span>
      </div>

      {/* ── 콘텐츠 영역 (y=52~) ──────────────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-y-auto p-2 gap-1">

      {/* Search / Command Bar */}
      <button
        onClick={() => setCommandBarOpen(true)}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm
          text-[var(--text-muted)] bg-white/5 hover:bg-white/10 transition-colors mb-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span>Search</span>
        <span className="ml-auto text-xs opacity-50">⌘J</span>
      </button>

      {/* Calendar Section */}
      <div className="mb-2">
        <div className="px-3 py-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Calendar
        </div>
        {navItem('Today', `/daily?date=${today}`, NAV_ICON.calendar)}
        {navItem('Yesterday', `/daily?date=${yesterdayStr}`, NAV_ICON.calendar)}
        {navItem('Tomorrow', `/daily?date=${tomorrowStr}`, NAV_ICON.calendar)}
        {navItem('This Month', `/monthly?month=${thisMonthStr}`, NAV_ICON.monthly)}
      </div>

      {/* Divider */}
      <div className="border-t border-[var(--border)] my-1" />

      {/* Tab Switcher */}
      <div className="flex rounded-md overflow-hidden bg-white/5 mb-2">
        {(['notes', 'tags', 'review'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-1 text-xs font-medium capitalize transition-colors
              ${activeTab === tab
                ? 'bg-blue-500/30 text-blue-300'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {/* FolderTree는 언마운트하지 않고 숨김만 → 탭 재방문 시 폴더 재요청 없이 즉시 표시 */}
      <div className={`flex-1 min-h-0 ${activeTab === 'notes' ? 'flex flex-col' : 'hidden'}`}>
        <FolderTree />
      </div>

      {activeTab === 'tags' && (
        <TagsPanel
          allTags={allTags}
          allMentions={allMentions}
          notes={notes}
        />
      )}

      {activeTab === 'review' && (
        <div className="flex flex-col gap-1 flex-1 overflow-y-auto px-1">
          <div className="text-xs text-[var(--text-muted)] px-2 py-1">기한 지난 Task</div>
        </div>
      )}

      {/* Bottom: New Note Button + Import + User */}
      <div className="border-t border-[var(--border)] pt-2 mt-auto flex-shrink-0">
        <button
          onClick={() => setNewNoteOpen(true)}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm
            text-[var(--text-secondary)] hover:bg-white/5 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 4v16m8-8H4" />
          </svg>
          New Note
        </button>

        {/* Import Button */}
        <button
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm
            text-[var(--text-secondary)] hover:bg-white/5 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Import Notes
        </button>

        {/* Theme Picker */}
        <div className="px-2 py-1">
          <ThemePicker />
        </div>

        <UserFooter />
      </div>  {/* bottom buttons */}
      </div>  {/* 콘텐츠 wrapper */}

      {/* Import Modal */}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}

      {/* New Note Modal */}
      {newNoteOpen && <NewNoteModal onClose={() => setNewNoteOpen(false)} />}
    </div>
  )
}

// ── TagsPanel (계층 태그/멘션 트리) ──────────────────────────────────────────

interface TagNote { id: string; title: string; type: string; date?: string }

interface TagTreeNode {
  name: string       // 마지막 세그먼트 (예: "reflection")
  fullPath: string   // 전체 경로 (예: "journal/reflection")
  isReal: boolean    // 실제 노트에 쓰인 태그인지 (네임스페이스만이 아니라)
  children: TagTreeNode[]
}

// "/"로 구분된 태그 경로 목록 → 계층 트리
function buildTagTree(paths: string[]): TagTreeNode[] {
  const realSet = new Set(paths)
  const roots: TagTreeNode[] = []
  const map = new Map<string, TagTreeNode>()

  for (const path of paths) {
    const segs = path.split('/').filter(Boolean)
    let prefix = ''
    let siblings = roots
    for (let i = 0; i < segs.length; i++) {
      prefix = i === 0 ? segs[i] : `${prefix}/${segs[i]}`
      let node = map.get(prefix)
      if (!node) {
        node = { name: segs[i], fullPath: prefix, isReal: realSet.has(prefix), children: [] }
        map.set(prefix, node)
        siblings.push(node)
      }
      siblings = node.children
    }
  }

  const sortNodes = (nodes: TagTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    nodes.forEach(n => sortNodes(n.children))
  }
  sortNodes(roots)
  return roots
}

function TagsPanel({
  allTags,
  allMentions,
  notes,
}: {
  allTags: string[]
  allMentions: string[]
  notes: Note[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<{ kind: 'tag' | 'mention'; value: string } | null>(null)
  const [tagNotes, setTagNotes] = useState<TagNote[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const tagTree = useMemo(() => buildTagTree(allTags), [allTags])
  const mentionTree = useMemo(() => buildTagTree(allMentions), [allMentions])

  const toggleExpand = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // content를 직접 재파싱해 필터 (저장된 tags/mentions에 의존하지 않음 → 계층 경로 정확)
  const handleSelect = (kind: 'tag' | 'mention', value: string) => {
    if (selected?.kind === kind && selected.value === value) {
      setSelected(null); setTagNotes([]); return
    }
    setSelected({ kind, value })
    const matched = notes.filter(n => {
      const found = kind === 'tag'
        ? extractTags(n.content ?? '')
        : extractMentions(n.content ?? '')
      return found.includes(value)
    })
    setTagNotes(matched.map(n => ({ id: n.id, title: n.title, type: n.type, date: n.date })))
  }

  const noteLabel = (n: TagNote) =>
    n.type === 'daily' && n.date ? n.date :
    n.type === 'weekly' && n.date ? `Week of ${n.date}` :
    n.title
  const noteIcon = (n: TagNote) =>
    (n.type === 'daily' || n.type === 'weekly' || n.type === 'monthly') ? '📅' : '📄'

  // 한 노드(+하위) 재귀 렌더
  const renderNode = (node: TagTreeNode, kind: 'tag' | 'mention', depth: number): React.ReactNode => {
    const key = `${kind}:${node.fullPath}`
    const isOpen = selected?.kind === kind && selected.value === node.fullPath
    const isExpanded = expanded.has(key)
    const hasChildren = node.children.length > 0
    const accent = kind === 'tag' ? 'text-blue-400' : 'text-purple-400'
    const sel = kind === 'tag' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'

    // 자식 있는 노드 → 클릭 시 expand/collapse
    // 리프 노드 → 클릭 시 노트 목록 표시
    const handleRowClick = () => {
      if (hasChildren) {
        toggleExpand(key)
      } else {
        handleSelect(kind, node.fullPath)
      }
    }

    return (
      <div key={key}>
        <div
          onClick={handleRowClick}
          className={`flex items-center gap-1 rounded text-sm cursor-pointer transition-colors pr-2 py-1
            ${isOpen ? sel : 'text-[var(--text-secondary)] hover:bg-white/5'}`}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {/* chevron (자식 있을 때만) */}
          <span className="w-3.5 flex-shrink-0 flex items-center justify-center">
            {hasChildren && (
              <svg className={`w-2.5 h-2.5 text-[var(--text-muted)] transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </span>
          <span className={`flex-shrink-0 font-semibold ${accent}`}>{kind === 'tag' ? '#' : '@'}</span>
          <span className={`truncate ${accent}`}>{node.name}</span>
        </div>

        {/* 리프 노드 선택 시 노트 목록 (인라인) */}
        {isOpen && !hasChildren && (
          <div className="mb-1 flex flex-col gap-0.5" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
            {tagNotes.length === 0 && (
              <div className="px-2 py-1 text-xs text-[var(--text-muted)]">노트 없음</div>
            )}
            {tagNotes.map(n => (
              <button
                key={n.id}
                onClick={() => n.type === 'daily' && n.date
                  ? router.push(`/daily?date=${n.date}`)
                  : router.push(`/notes?id=${n.id}`)}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[var(--text-muted)]
                  hover:bg-white/5 hover:text-[var(--text-secondary)] text-left w-full transition-colors"
              >
                <span className="text-[10px]">{noteIcon(n)}</span>
                <span className="truncate">{noteLabel(n)}</span>
              </button>
            ))}
          </div>
        )}

        {/* 하위 태그 */}
        {hasChildren && isExpanded && node.children.map(c => renderNode(c, kind, depth + 1))}
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 overflow-y-auto px-1 min-h-0">
      {allTags.length === 0 && allMentions.length === 0 && (
        <div className="px-2 py-1 text-xs text-[var(--text-muted)]">태그가 없습니다</div>
      )}
      {tagTree.map(n => renderNode(n, 'tag', 0))}
      {mentionTree.length > 0 && tagTree.length > 0 && (
        <div className="border-t border-[var(--border)] my-1" />
      )}
      {mentionTree.map(n => renderNode(n, 'mention', 0))}
    </div>
  )
}

// ── UserFooter ────────────────────────────────────────────────────────────────

function UserFooter() {
  const { user } = useAuthStore()
  const supabase = createClient()

  if (!user) return null

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const avatarUrl = user.user_metadata?.avatar_url
  const name = user.user_metadata?.full_name ?? user.email ?? ''
  const initial = name[0]?.toUpperCase() ?? '?'

  return (
    <div className="flex items-center gap-2 px-3 py-2 mt-1">
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="w-6 h-6 rounded-full flex-shrink-0" />
      ) : (
        <div className="w-6 h-6 rounded-full bg-blue-500/30 flex items-center justify-center flex-shrink-0
          text-[10px] font-semibold text-blue-400">
          {initial}
        </div>
      )}
      <span className="text-xs text-[var(--text-muted)] truncate flex-1">{name}</span>
      <button
        onClick={handleLogout}
        title="로그아웃"
        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
      </button>
    </div>
  )
}

// ── NewNoteModal ───────────────────────────────────────────────────────────────

const PARA_FOLDERS = ['Projects', 'Areas', 'Resources', 'Archive']

function NewNoteModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState<string>('none')
  const [folders, setFolders] = useState<Folder[]>([])

  useEffect(() => {
    getFolders().then(setFolders)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const handleCreate = async () => {
    const noteTitle = title.trim() || 'Untitled'
    const selectedFolder = folder === 'none' ? undefined : folder
    const safeName = noteTitle.replace(/[^a-zA-Z0-9ㄱ-ㅎ가-힣 ._-]/g, '').trim() || 'Untitled'
    const filePath = selectedFolder
      ? `Notes/${selectedFolder}/${safeName}.md`
      : `Notes/${safeName}.md`

    const note = {
      id: uuidv4(),
      type: 'project' as const,
      title: noteTitle,
      content: `# ${noteTitle}\n\n`,
      filePath,
      folder: selectedFolder,
      tags: [],
      mentions: [],
      backlinks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await upsertNote(note)
    router.push(`/notes?id=${note.id}`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-80 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] shadow-2xl p-4 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">새 노트</h3>

        <input
          ref={inputRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') onClose() }}
          placeholder="제목 입력..."
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-[var(--border)]
            text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
            focus:outline-none focus:border-blue-400/50"
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--text-muted)]">저장 위치</label>
          <select
            value={folder}
            onChange={e => setFolder(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-[var(--border)]
              text-sm text-[var(--text-secondary)] focus:outline-none focus:border-blue-400/50
              cursor-pointer"
          >
            <option value="none">Unfiled (분류 없음)</option>
            {folders.map(f => (
              <option key={f.id} value={f.path}>{f.path}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-[var(--text-muted)] transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleCreate}
            className="flex-1 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-sm text-white font-medium transition-colors"
          >
            만들기
          </button>
        </div>
      </div>
    </div>
  )
}
