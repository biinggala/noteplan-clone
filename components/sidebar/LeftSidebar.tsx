'use client'
import { useEffect, useState, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
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

const NAV_ICON = {
  calendar: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
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
  const { activeTab, setActiveTab, setCommandBarOpen } = useUIStore()
  const { selectedDate, today } = useCalendarStore()
  const { notes, setNotes, activeNote } = useNoteStore()
  const [projectNotes, setProjectNotes] = useState<Note[]>([])

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
  const tomorrowStr = format(addDays(todayDate, 1), 'yyyy-MM-dd')

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
    const isActive = mounted && pathname === path
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
    <div className="flex flex-col h-full p-2 gap-1">
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
        {navItem('Today', `/daily/${today}`, NAV_ICON.calendar)}
        {navItem('Yesterday', `/daily/${yesterdayStr}`, NAV_ICON.calendar)}
        {navItem('Tomorrow', `/daily/${tomorrowStr}`, NAV_ICON.calendar)}
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
        <div className="flex flex-col gap-1 flex-1 overflow-y-auto px-1">
          {allTags.length === 0 && allMentions.length === 0 && (
            <div className="px-2 py-1 text-xs text-[var(--text-muted)]">태그가 없습니다</div>
          )}
          {allTags.map(tag => (
            <div key={`tag-${tag}`}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm text-[var(--text-secondary)] hover:bg-white/5 cursor-default">
              {NAV_ICON.tag}
              <span className="text-blue-400">#{tag}</span>
            </div>
          ))}
          {allMentions.map(mention => (
            <div key={`mention-${mention}`}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm text-[var(--text-secondary)] hover:bg-white/5 cursor-default">
              <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207" />
              </svg>
              <span className="text-purple-400">@{mention}</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'review' && (
        <div className="flex flex-col gap-1 flex-1 overflow-y-auto px-1">
          <div className="text-xs text-[var(--text-muted)] px-2 py-1">기한 지난 Task</div>
        </div>
      )}

      {/* Bottom: New Note Button + User */}
      <div className="border-t border-[var(--border)] pt-2 mt-auto">
        <button
          onClick={() => router.push('/notes/new')}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm
            text-[var(--text-secondary)] hover:bg-white/5 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 4v16m8-8H4" />
          </svg>
          New Note
        </button>

        {/* Theme Picker */}
        <div className="px-2 py-1">
          <ThemePicker />
        </div>

        <UserFooter />
      </div>
    </div>
  )
}

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
