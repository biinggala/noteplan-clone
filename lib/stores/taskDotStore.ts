import { create } from 'zustand'

/**
 * 날짜별 미완료 태스크(- [ ]) 존재 여부를 캐시
 * - daily page: 노트 로드/변경 시 실시간 업데이트
 * - MiniCalendar: 월 단위 Supabase fetch로 초기 로드
 */
interface TaskDotStore {
  /** date(YYYY-MM-DD) → 미완료 태스크 있음? */
  taskDates: Record<string, boolean>
  setTaskDate:  (date: string, hasTasks: boolean) => void
  setTaskDates: (entries: Record<string, boolean>) => void
}

export const useTaskDotStore = create<TaskDotStore>((set) => ({
  taskDates: {},
  setTaskDate: (date, hasTasks) =>
    set(state => ({ taskDates: { ...state.taskDates, [date]: hasTasks } })),
  setTaskDates: (entries) =>
    set(state => ({ taskDates: { ...state.taskDates, ...entries } })),
}))

/** content에 미완료 태스크가 있는지 확인 */
export function hasOpenTask(content: string): boolean {
  return /^- \[ \]/m.test(content)
}
