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
import { getNotesByTag, getNotesByMention, getFolders, upsertNote } from '@/lib/db/noteRepository'
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

  // Merge tags/mentions from all saved notes + the currently-editing activeNote
  // so the Tags tab updates in real-time as the user types.
  const allTags = useMemo(() => {
    const fromNotes = notes.flatMap(n => n.tags)
    const fromActive = activeNote?.tags ?? []
    return [...new Set([...fromNotes, ...fromActive])].sort()
  }, [notes, activeNote?.tags])

  const allMentions = useMemo(() => {
    const fromNotes = notes.flatMap(n => n.mentions)
    const fromActive = activeNote?.mentions ?? []
    return [...new Set([...fromNotes, ...fromActive])].sort()
  }, [notes, activeNote?.mentions])

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
      {activeTab === 'notes' && (
        <FolderTree />
      )}

      {activeTab === 'tags' && (
        <TagsPanel
          allTags={allTags}
          allMentions={allMentions}
          tagIcon={NAV_ICON.tag}
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

// ── TagsPanel ─────────────────────────────────────────────────────────────────

interface TagNote { id: string; title: string; type: string; date?: string }

function TagsPanel({
  allTags,
  allMentions,
  tagIcon,
}: {
  allTags: string[]
  allMentions: string[]
  tagIcon: React.ReactNode
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<{ kind: 'tag' | 'mention'; value: string } | null>(null)
  const [tagNotes, setTagNotes] = useState<TagNote[]>([])
  const [loading, setLoading] = useState(false)

  const handleSelect = async (kind: 'tag' | 'mention', value: string) => {
    if (selected?.kind === kind && selected.value === value) {
      setSelected(null)
      setTagNotes([])
      return
    }
    setSelected({ kind, value })
    setLoading(true)
    try {
      const notes = kind === 'tag'
        ? await getNotesByTag(value)
        : await getNotesByMention(value)
      setTagNotes(notes.map(n => ({ id: n.id, title: n.title, type: n.type, date: n.date })))
    } finally {
      setLoading(false)
    }
  }

  const noteLabel = (n: TagNote) =>
    n.type === 'daily' && n.date ? n.date :
    n.type === 'weekly' && n.date ? `Week of ${n.date}` :
    n.title

  const noteIcon = (n: TagNote) => {
    if (n.type === 'daily' || n.type === 'weekly' || n.type === 'monthly')
      return '📅'
    return '📄'
  }

  return (
    <div className="flex flex-col flex-1 overflow-y-auto px-1 min-h-0">
      {allTags.length === 0 && allMentions.length === 0 && (
        <div className="px-2 py-1 text-xs text-[var(--text-muted)]">태그가 없습니다</div>
      )}

      {/* Tags */}
      {allTags.map(tag => {
        const isOpen = selected?.kind === 'tag' && selected.value === tag
        return (
          <div key={`tag-${tag}`}>
            <button
              onClick={() => handleSelect('tag', tag)}
              className={`flex items-center gap-2 w-full px-2 py-1 rounded text-sm transition-colors
                ${isOpen
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'text-[var(--text-secondary)] hover:bg-white/5'
                }`}
            >
              {tagIcon}
              <span className="text-blue-400">#{tag}</span>
              {isOpen && (
                <svg className="w-3 h-3 ml-auto text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </button>

            {isOpen && (
              <div className="ml-4 mb-1 flex flex-col gap-0.5">
                {loading && (
                  <div className="px-2 py-1 text-xs text-[var(--text-muted)]">로딩 중...</div>
                )}
                {!loading && tagNotes.length === 0 && (
                  <div className="px-2 py-1 text-xs text-[var(--text-muted)]">노트 없음</div>
                )}
                {!loading && tagNotes.map(n => (
                  <button
                    key={n.id}
                    onClick={() => n.type === 'daily' && n.date
                      ? router.push(`/daily?date=${n.date}`)
                      : router.push(`/notes?id=${n.id}`)
                    }
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[var(--text-muted)]
                      hover:bg-white/5 hover:text-[var(--text-secondary)] text-left w-full transition-colors"
                  >
                    <span className="text-[10px]">{noteIcon(n)}</span>
                    <span className="truncate">{noteLabel(n)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Mentions */}
      {allMentions.map(mention => {
        const isOpen = selected?.kind === 'mention' && selected.value === mention
        return (
          <div key={`mention-${mention}`}>
            <button
              onClick={() => handleSelect('mention', mention)}
              className={`flex items-center gap-2 w-full px-2 py-1 rounded text-sm transition-colors
                ${isOpen
                  ? 'bg-purple-500/20 text-purple-300'
                  : 'text-[var(--text-secondary)] hover:bg-white/5'
                }`}
            >
              <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207" />
              </svg>
              <span className="text-purple-400">@{mention}</span>
              {isOpen && (
                <svg className="w-3 h-3 ml-auto text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </button>

            {isOpen && (
              <div className="ml-4 mb-1 flex flex-col gap-0.5">
                {loading && (
                  <div className="px-2 py-1 text-xs text-[var(--text-muted)]">로딩 중...</div>
                )}
                {!loading && tagNotes.length === 0 && (
                  <div className="px-2 py-1 text-xs text-[var(--text-muted)]">노트 없음</div>
                )}
                {!loading && tagNotes.map(n => (
                  <button
                    key={n.id}
                    onClick={() => n.type === 'daily' && n.date
                      ? router.push(`/daily?date=${n.date}`)
                      : router.push(`/notes?id=${n.id}`)
                    }
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[var(--text-muted)]
                      hover:bg-white/5 hover:text-[var(--text-secondary)] text-left w-full transition-colors"
                  >
                    <span className="text-[10px]">{noteIcon(n)}</span>
                    <span className="truncate">{noteLabel(n)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
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
