import { create } from 'zustand'

// pointer 드래그(pointerLineDrag) → DayTimeline 미리보기 블록 공유.
// 드래그 중 타임라인 슬롯 위에 점선 미리보기(시작시각 + 길이)를 표시하기 위함.
export interface TimelineDragPreview {
  date: string
  hour: number
  minute: number
  duration: number
}

interface TimelineDragState {
  preview: TimelineDragPreview | null
  setPreview: (p: TimelineDragPreview | null) => void
}

export const useTimelineDragStore = create<TimelineDragState>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
}))
