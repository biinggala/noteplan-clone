'use client'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { format, subDays, addDays, parseISO, getWeek, getWeekYear } from 'date-fns'
import { useUIStore } from '@/lib/stores/uiStore'
import { useCalendarStore } from '@/lib/stores/calendarStore'
import { useNoteStore } from '@/lib/stores/noteStore'
import { useAuthStore } from '@/lib/stores/authStore'
import { getAllNotes } from '@/lib/db/noteRepository'
import { createClient } from '@/lib/supabase/client'
import type { Note } from '@/types/note'
import FolderTree from './FolderTree'
import Portal from '@/components/ui/Portal'
import ReviewPanel from './ReviewPanel'
import { IconButton, SidebarIcon } from '@/components/layout/PageHeader'
import { useIsMobile } from '@/lib/hooks/useIsMobile'
import ThemePicker from '@/components/ThemePicker'
import ImportModal from '@/components/import/ImportModal'
import { routeForNote } from '@/lib/hooks/useWikiLink'
import { getFolders, upsertNote } from '@/lib/db/noteRepository'
import { extractTags, extractMentions } from '@/lib/parser/noteParser'
import { v4 as uuidv4 } from 'uuid'
import type { Folder } from '@/types/note'

// 미니 캘린더·주간 노트와 같은 CW 규칙
const WK = { weekStartsOn: 0 as const, firstWeekContainsDate: 4 as const }

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
  const { activeTab, setActiveTab, setCommandBarOpen, toggleLeftSidebar } = useUIStore()
  const { selectedDate, today, refreshToday } = useCalendarStore()
  const { notes, setNotes, activeNote } = useNoteStore()
  const [projectNotes, setProjectNotes] = useState<Note[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [newNoteOpen, setNewNoteOpen] = useState(false)

  // 태그/멘션은 노트 content에서 직접 재파싱한다.
  // (저장된 n.tags/n.mentions는 과거 정규식으로 파싱돼 #a/b 같은 계층 경로가
  //  잘려 있을 수 있으므로, 항상 현재 파서로 content를 다시 읽어 단일 진실원천으로 삼음)
  // 목록은 최신순 — 각 태그/멘션이 쓰인 노트 중 가장 최근 updatedAt을 기준으로 삼는다.
  // (정렬 자체는 buildTagTree가 계층 레벨마다 수행하므로 여기선 순서 대신 기준값을 넘긴다)
  // 노트마다 파싱 결과를 기억한다 — 내용이 그대로인 노트는 다시 훑지 않는다
  // (예전엔 한 노트만 바뀌어도 수천 개 노트를 전부 다시 정규식으로 훑었다)
  const collectFacets = (pick: (text: string) => string[], cache: Map<string, { content: string; names: string[] }>) => {
    const recency = new Map<string, number>()
    const bump = (name: string, at: number) => {
      const prev = recency.get(name)
      if (prev === undefined || at > prev) recency.set(name, at)
    }
    const namesOf = (id: string, content: string) => {
      const hit = cache.get(id)
      if (hit && hit.content === content) return hit.names
      const names = pick(content)
      cache.set(id, { content, names })
      return names
    }
    for (const n of notes) {
      for (const name of namesOf(n.id, n.content ?? '')) bump(name, n.updatedAt ?? 0)
    }
    // 열려 있는 노트는 아직 저장 전일 수 있어 store의 notes보다 내용이 앞선다
    if (activeNote?.content) {
      for (const name of namesOf('active:' + activeNote.id, activeNote.content)) bump(name, activeNote.updatedAt ?? 0)
    }
    return { names: [...recency.keys()], recency }
  }
  const tagCache = useRef(new Map<string, { content: string; names: string[] }>()).current
  const mentionCache = useRef(new Map<string, { content: string; names: string[] }>()).current

  const { names: allTags, recency: tagRecency } = useMemo(
    () => collectFacets(extractTags, tagCache),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, activeNote?.content, activeNote?.updatedAt],
  )

  const { names: allMentions, recency: mentionRecency } = useMemo(
    () => collectFacets(extractMentions, mentionCache),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, activeNote?.content, activeNote?.updatedAt],
  )

  // Today/Yesterday/Tomorrow는 같은 기준일에서 파생돼야 한다.
  // 예전엔 today만 스토어(모듈 로드 시점 고정)에서 오고 나머지는 렌더 시점
  // new Date()에서 와서, 자정을 넘기면 Today와 Yesterday가 같은 날짜를
  // 가리켜 둘 다 활성으로 보였다.
  const todayDate = parseISO(today)
  const yesterdayStr = format(subDays(todayDate, 1), 'yyyy-MM-dd')
  const tomorrowStr  = format(addDays(todayDate, 1), 'yyyy-MM-dd')
  const thisMonthStr = format(todayDate, 'yyyy-MM')   // e.g. "2026-05"

  // 앱을 켜둔 채 날이 바뀌는 경우를 위해 today를 살아있게 유지한다
  // (탭 복귀 시 + 1분마다 — 값이 그대로면 스토어는 갱신하지 않으므로 리렌더 없음)
  useEffect(() => {
    refreshToday()
    const onFocus = () => refreshToday()
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    const id = setInterval(refreshToday, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
      clearInterval(id)
    }
  }, [refreshToday])

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

  // 노트 '목록'을 실시간으로 따라간다.
  // useNoteRealtime은 열려 있는 노트 하나의 '내용'만 구독하므로, Claude(MCP)가
  // 새 노트를 만들면 사이드바에는 안 나타났다(마운트 때 읽은 목록 그대로).
  // CMD+J는 매번 새로 쿼리해서 찾아지는 바람에 더 헷갈렸다.
  useEffect(() => {
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | undefined
    // 한 번에 여러 행이 바뀔 수 있어 살짝 모아서 한 번만 재조회
    const refresh = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        getAllNotes().then(allNotes => {
          setNotes(allNotes)
          setProjectNotes(allNotes.filter(n => n.type === 'project'))
        }).catch(console.error)
      }, 300)
    }
    // 내 행만 구독한다. 필터가 없으면 RLS 가 적용되지 않는 DELETE 이벤트로
    // 다른 사용자의 노트 id 가 흘러 들어오고, 그때마다 목록을 다시 받았다.
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user.id
      if (cancelled || !uid) return
      channel = supabase
        .channel(`notes-list:${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${uid}` }, refresh)
        .subscribe()
    })
    return () => { cancelled = true; clearTimeout(timer); if (channel) supabase.removeChannel(channel) }
  }, [setNotes])

  const navItem = (label: string, path: string, icon: React.ReactNode, trailing?: React.ReactNode) => {
    const isActive = mounted && currentUrl === path
    return (
      <button
        onClick={() => router.push(path)}
        aria-current={isActive ? 'page' : undefined}
        className={`group flex items-center gap-2.5 w-full h-10 md:h-8 px-2.5 rounded-md text-[15px] md:text-[13px] transition-colors
          ${isActive
            ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
            : 'text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-primary)]'
          }`}
      >
        <span className={isActive ? '' : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]'}>{icon}</span>
        <span className="flex-1 text-left truncate">{label}</span>
        {trailing}
      </button>
    )
  }

  // ⌘N (레이아웃이 보내는 이벤트) → 새 노트 창
  useEffect(() => {
    const open = () => setNewNoteOpen(true)
    window.addEventListener('np:new-note', open)
    return () => window.removeEventListener('np:new-note', open)
  }, [])

  const thisWeekKey = `${getWeekYear(todayDate, WK)}-W${getWeek(todayDate, WK).toString().padStart(2, '0')}`
  const isMobile = useIsMobile()
  const macTitlebar = useMacTitlebar()

  return (
    <div className="flex flex-col h-full">
      {/* ── 머리줄: 맥 앱은 신호등 버튼 자리(왼쪽 76px)를 비우고, 오른쪽에 새 노트·접기 ── */}
      <div
        data-tauri-drag-region className="electron-drag flex-shrink-0 flex items-center gap-1 px-2"
        style={{ height: 'var(--header-h)', paddingLeft: macTitlebar ? 80 : 12 }}
      >
        {!macTitlebar && (
          <span className="text-[13px] font-semibold tracking-tight text-[var(--text-secondary)] select-none">NotePlan</span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 titlebar-no-drag">
          <IconButton label="새 노트 (⌘N)" onClick={() => setNewNoteOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </IconButton>
          {!isMobile && (
            <IconButton label="사이드바 닫기 (⌘\\)" onClick={toggleLeftSidebar}>
              <SidebarIcon side="left" />
            </IconButton>
          )}
        </div>
      </div>

      {/* ── 본문 ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-h-0 px-2 pb-2 gap-0.5">

      {/* Search / Command Bar */}
      <button
        onClick={() => setCommandBarOpen(true)}
        className="flex items-center gap-2 w-full h-8 px-2.5 mb-2 rounded-md text-[13px]
          text-[var(--text-muted)] bg-[var(--hover-bg)] hover:bg-[var(--active-bg)] transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span>Search</span>
        <kbd className="ml-auto inline-flex items-center gap-px text-[10px] leading-none px-1.5 h-[18px] rounded border border-[var(--border)] opacity-70 whitespace-nowrap" style={{ fontFamily: 'inherit' }}>⌘J</kbd>
      </button>

      {/* Calendar Section */}
      <SectionLabel>Calendar</SectionLabel>
      {navItem('Today', `/daily?date=${today}`, NAV_ICON.calendar,
        <span className="text-[11px] tabular text-[var(--text-muted)]">{format(todayDate, 'M/d')}</span>)}
      {navItem('Yesterday', `/daily?date=${yesterdayStr}`, NAV_ICON.calendar)}
      {navItem('Tomorrow', `/daily?date=${tomorrowStr}`, NAV_ICON.calendar)}
      {navItem('This Week', `/weekly?week=${thisWeekKey}`, NAV_ICON.monthly)}
      {navItem('This Month', `/monthly?month=${thisMonthStr}`, NAV_ICON.monthly)}

      {/* Tab Switcher — 세그먼트 컨트롤 */}
      <div role="tablist" aria-label="사이드바 보기" className="mt-3 mb-1.5 grid grid-cols-3 p-0.5 rounded-lg bg-[var(--hover-bg)]">
        {(['notes', 'tags', 'review'] as const).map(tab => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`h-6 rounded-md text-xs font-medium capitalize transition-all
              ${activeTab === tab
                ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {/* FolderTree는 언마운트하지 않고 숨김만 → 탭 재방문 시 폴더 재요청 없이 즉시 표시 */}
      <div className={`flex-1 min-h-0 overflow-y-auto ${activeTab === 'notes' ? 'flex flex-col' : 'hidden'}`}>
        <FolderTree />
      </div>

      {activeTab === 'tags' && (
        <TagsPanel
          allTags={allTags}
          allMentions={allMentions}
          tagRecency={tagRecency}
          mentionRecency={mentionRecency}
        />
      )}

      {activeTab === 'review' && (
        <div className="flex-1 min-h-0 flex flex-col"><ReviewPanel /></div>
      )}

      {/* Bottom: 가져오기 · 테마 · 사용자 */}
      <div className="border-t border-[var(--border)] pt-1.5 mt-1 flex-shrink-0">
        <div className="flex items-center gap-1">
          <ThemePicker />
          <div className="flex-1" />
          <IconButton label="NotePlan 백업 가져오기" onClick={() => setImportOpen(true)}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </IconButton>
        </div>
        <UserFooter />
      </div>
      </div>  {/* 본문 */}

      {/* Import Modal */}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}

      {/* New Note Modal */}
      {newNoteOpen && <NewNoteModal onClose={() => setNewNoteOpen(false)} />}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-1 pb-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider select-none">
      {children}
    </div>
  )
}

/** 맥 데스크톱 앱(Tauri, 신호등 버튼이 창 안에 그려짐)인지 */
function useMacTitlebar(): boolean {
  const [mac, setMac] = useState(false)
  useEffect(() => {
    const tauri = '__TAURI_INTERNALS__' in window
    setMac(tauri && /Mac/i.test(navigator.platform || navigator.userAgent))
  }, [])
  return mac
}

// ── TagsPanel (계층 태그/멘션 트리) ──────────────────────────────────────────

// 결과는 노트 단위가 아니라 키워드가 포함된 "라인" 단위 (실제 NotePlan 방식)
interface TagTreeNode {
  name: string       // 마지막 세그먼트 (예: "reflection")
  fullPath: string   // 전체 경로 (예: "journal/reflection")
  isReal: boolean    // 실제 노트에 쓰인 태그인지 (네임스페이스만이 아니라)
  children: TagTreeNode[]
}

// "/"로 구분된 태그 경로 목록 → 계층 트리
/**
 * `#a/b` 경로들을 트리로 만든다.
 * recency를 주면 각 레벨을 최신순으로 정렬한다 — 중간 노드는 자기 자신과
 * 하위 전체 중 가장 최근 값을 쓴다(부모가 자식보다 뒤로 밀리지 않도록).
 * 값이 같거나 recency가 없으면 이름순으로 떨어진다.
 */
function buildTagTree(paths: string[], recency?: Map<string, number>): TagTreeNode[] {
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

  // 하위 전체를 포함한 최신값 (자식이 최근이면 부모도 위로 올라온다)
  const subtreeRecency = new Map<string, number>()
  const walk = (node: TagTreeNode): number => {
    let newest = recency?.get(node.fullPath) ?? 0
    for (const c of node.children) newest = Math.max(newest, walk(c))
    subtreeRecency.set(node.fullPath, newest)
    return newest
  }
  roots.forEach(walk)

  const sortNodes = (nodes: TagTreeNode[]) => {
    nodes.sort((a, b) => {
      const diff = (subtreeRecency.get(b.fullPath) ?? 0) - (subtreeRecency.get(a.fullPath) ?? 0)
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })
    nodes.forEach(n => sortNodes(n.children))
  }
  sortNodes(roots)
  return roots
}

function TagsPanel({
  allTags,
  allMentions,
  tagRecency,
  mentionRecency,
}: {
  allTags: string[]
  allMentions: string[]
  tagRecency: Map<string, number>
  mentionRecency: Map<string, number>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const tagTree = useMemo(() => buildTagTree(allTags, tagRecency), [allTags, tagRecency])
  const mentionTree = useMemo(() => buildTagTree(allMentions, mentionRecency), [allMentions, mentionRecency])

  // 지금 보고 있는 검색 결과가 어떤 태그인지 (사이드바에서 강조 표시용)
  const active = pathname === '/search'
    ? (searchParams.get('tag')
        ? { kind: 'tag' as const, value: searchParams.get('tag')! }
        : searchParams.get('mention')
          ? { kind: 'mention' as const, value: searchParams.get('mention')! }
          : null)
    : null

  const toggleExpand = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // 좁은 사이드바에 접어 넣는 대신 메인 영역의 검색 결과 페이지로 보낸다.
  const handleSelect = (kind: 'tag' | 'mention', value: string) => {
    router.push(`/search?${kind}=${encodeURIComponent(value)}`)
  }

  // 한 노드(+하위) 재귀 렌더
  const renderNode = (node: TagTreeNode, kind: 'tag' | 'mention', depth: number): React.ReactNode => {
    const key = `${kind}:${node.fullPath}`
    const isOpen = active?.kind === kind && active.value === node.fullPath
    const isExpanded = expanded.has(key)
    const hasChildren = node.children.length > 0
    const accent = kind === 'tag' ? 'text-blue-400' : 'text-purple-400'
    const sel = kind === 'tag' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'

    // chevron = 펼침/접힘, 이름 = 그 태그의 노트 목록 (중간 노드도 클릭 시 목록 표시)
    return (
      <div key={key}>
        <div
          onClick={() => handleSelect(kind, node.fullPath)}
          className={`flex items-center gap-1 rounded text-sm cursor-pointer transition-colors pr-2 py-1
            ${isOpen ? sel : 'text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]'}`}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {/* chevron (자식 있을 때만) — 클릭 시 펼침만 */}
          <span
            className="w-3.5 flex-shrink-0 flex items-center justify-center"
            onClick={(e) => { if (hasChildren) { e.stopPropagation(); toggleExpand(key) } }}
          >
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

        {/* 결과 목록은 메인 영역(/search)에 뜬다 — 여기선 계층만 보여준다 */}

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
    // 같은 기기에서 다음에 로그인하는 사람에게 이전 사용자의 캘린더 목록·
    // 진행 중이던 OAuth 표식이 남지 않게 지운다 (구글 토큰은 signOut 이벤트에서 비워진다)
    useCalendarEventStore.persist.clearStorage()
    try {
      for (const k of ['np-oauth-started', 'np-oauth-with-calendar', 'auth-google-token']) localStorage.removeItem(k)
    } catch { /* storage 를 못 써도 로그아웃은 진행 */ }
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
    // getFolders는 조회 실패 시 throw → 목록 없이 모달을 띄운다 (미분류로 생성 가능)
    getFolders().then(setFolders).catch((e) => console.error('[NewNoteModal] 폴더 로드 실패', e))
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
      supersedes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await upsertNote(note)
    router.push(`/notes?id=${note.id}`)
    onClose()
  }

  return (
    <Portal>
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
          className="w-full px-3 py-2 rounded-lg border border-[var(--border)]
            text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
            focus:outline-none focus:border-[var(--accent)]"
          style={{ backgroundColor: 'var(--hover-bg)' }}
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--text-muted)]">저장 위치</label>
          <select
            value={folder}
            onChange={e => setFolder(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border)]
              text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]
              cursor-pointer"
            style={{ backgroundColor: 'var(--hover-bg)' }}
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
            className="flex-1 py-2 rounded-lg hover:bg-[var(--active-bg)] text-sm text-[var(--text-muted)] transition-colors"
            style={{ backgroundColor: 'var(--hover-bg)' }}
          >
            취소
          </button>
          <button
            onClick={handleCreate}
            className="flex-1 py-2 rounded-lg hover:opacity-90 text-sm text-white font-medium transition-colors"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            만들기
          </button>
        </div>
      </div>
    </div>
    </Portal>
  )
}
