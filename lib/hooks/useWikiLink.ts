'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { v4 as uuidv4 } from 'uuid'
import {
  getLinkTargets, getNoteByTitle, upsertNote,
  type LinkTarget,
} from '@/lib/db/noteRepository'
import type { Note } from '@/types/note'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEK_RE = /^\d{4}-W\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

/** 노트 종류에 맞는 라우트 */
export function routeForNote(n: { type: string; id: string; date?: string }): string {
  if (n.type === 'daily'   && n.date) return `/daily?date=${n.date}`
  if (n.type === 'weekly'  && n.date) return `/weekly?week=${n.date}`
  if (n.type === 'monthly' && n.date) return `/monthly?month=${n.date}`
  return `/notes?id=${n.id}`
}

/**
 * [[위키링크]] 이동 + 자동완성 후보 제공.
 * 링크 대상이 없으면 그 제목으로 새 노트를 만들어 바로 이동한다
 * (Obsidian처럼 "생각의 흐름이 끊기지 않게").
 */
export function useWikiLink() {
  const router = useRouter()
  const [linkTargets, setLinkTargets] = useState<LinkTarget[]>([])

  useEffect(() => { getLinkTargets().then(setLinkTargets).catch(console.error) }, [])

  const openWikiLink = useCallback(async (rawTitle: string) => {
    const title = rawTitle.trim()
    if (!title) return

    // 1) 제목이 정확히 일치하는 노트
    const found = await getNoteByTitle(title)
    if (found) { router.push(routeForNote(found)); return }

    // 2) 날짜/주/월 형태면 해당 캘린더 노트로 (없으면 그 페이지가 알아서 생성)
    if (DATE_RE.test(title))  { router.push(`/daily?date=${title}`); return }
    if (WEEK_RE.test(title))  { router.push(`/weekly?week=${title}`); return }
    if (MONTH_RE.test(title)) { router.push(`/monthly?month=${title}`); return }

    // 3) 없는 링크 → 그 제목으로 새 노트 생성 후 이동
    const safe = title.replace(/[^a-zA-Z0-9ㄱ-ㅎ가-힣 ._-]/g, '').trim() || 'Untitled'
    const note: Note = {
      id: uuidv4(),
      type: 'project',
      title,
      content: `# ${title}\n\n`,
      filePath: `Notes/${safe}.md`,
      tags: [], mentions: [], backlinks: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    }
    await upsertNote(note)
    setLinkTargets(prev => [{ id: note.id, title, type: 'project' }, ...prev])
    router.push(`/notes?id=${note.id}`)
  }, [router])

  return { linkTargets, openWikiLink }
}
