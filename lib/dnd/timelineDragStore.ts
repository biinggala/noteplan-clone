import { create } from 'zustand'
import { format, isValid, parseISO } from 'date-fns'

// pointer 드래그(pointerLineDrag) → DayTimeline 미리보기 블록 공유.
// 드래그 중 타임라인 슬롯 위에 점선 미리보기(시작시각 + 길이)를 표시하기 위함.
export interface TimelineDragPreview {
  date: string
  hour: number
  minute: number
  duration: number
  /** 이 칸에는 놓을 수 없음 (빨간 미리보기) */
  disabled?: boolean
  /** disabled 일 때 미리보기에 띄울 이유 */
  reason?: string
}

interface TimelineDragState {
  preview: TimelineDragPreview | null
  setPreview: (p: TimelineDragPreview | null) => void
}

export const useTimelineDragStore = create<TimelineDragState>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
}))

/**
 * 지금 열려 있는 일간 노트의 날짜 (일간 노트 화면이 아니면 null).
 * 일간 노트 화면과 같은 규칙: ?date= 가 없거나 이상하면 오늘.
 */
export function dailyNoteDateFrom(pathname: string | null, dateParam: string | null): string | null {
  if (!pathname) return null
  const p = pathname.replace(/\/+$/, '').replace(/\.html$/, '')
  if (!p.endsWith('/daily')) return null
  const d = dateParam ? parseISO(dateParam) : new Date()
  return format(isValid(d) ? d : new Date(), 'yyyy-MM-dd')
}

export function openDailyNoteDate(): string | null {
  if (typeof window === 'undefined') return null
  return dailyNoteDateFrom(window.location.pathname, new URLSearchParams(window.location.search).get('date'))
}
