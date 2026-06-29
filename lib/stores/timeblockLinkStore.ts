'use client'
import { create } from 'zustand'

// 타임블록 ↔ 생성된 Google Calendar 이벤트 링크.
// 타임블록은 노트 라인에서 재파생(ephemeral)되므로, 완료 동기화(✓) 등을 위해
// 안정적 키(date|HH:MM|content)로 eventId/calendarId를 별도 보관.
export interface GcalLink { eventId: string; calendarId: string }

export const tbKey = (date: string, hour: number, minute: number, content: string) =>
  `${date}|${hour}:${minute}|${content.trim()}`

interface TimeblockLinkStore {
  links: Record<string, GcalLink>
  setLink: (key: string, link: GcalLink) => void
  getLink: (key: string) => GcalLink | undefined
  removeLink: (key: string) => void
}

export const useTimeblockLinkStore = create<TimeblockLinkStore>((set, get) => ({
  links: {},
  setLink: (key, link) => set((s) => ({ links: { ...s.links, [key]: link } })),
  getLink: (key) => get().links[key],
  removeLink: (key) => set((s) => {
    const next = { ...s.links }
    delete next[key]
    return { links: next }
  }),
}))
