'use client'
import { create } from 'zustand'
import { format, parseISO, isValid, isSameMonth } from 'date-fns'

interface CalendarStore {
  selectedDate: string        // YYYY-MM-DD
  selectedWeek: string | null // YYYY-Wnn — 주간 노트를 보는 중이면 그 주 행 전체를 강조
  today: string
  viewMonthDate: Date         // 미니 캘린더가 현재 보여주는 월
  /** 특정 날짜 선택 (해당 월로 자동 이동 + 주 선택 해제) */
  setSelectedDate: (date: string) => void
  /** 주간 노트 선택 — 그 주 행 전체 강조 + 해당 월로 이동 */
  setSelectedWeek: (weekKey: string, weekStart: Date) => void
  setViewMonthDate: (date: Date) => void
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  selectedDate: format(new Date(), 'yyyy-MM-dd'),
  selectedWeek: null,
  today: format(new Date(), 'yyyy-MM-dd'),
  viewMonthDate: new Date(),

  // 노트로 이동하면 미니 캘린더도 그 달을 보여줘야 한다.
  // (검색으로 옛 노트를 열었는데 캘린더는 원래 달에 머물러 선택일이 안 보이던 문제)
  // 단, 같은 달이면 viewMonthDate 객체를 그대로 둔다 — 새 Date를 만들면 이걸
  // deps로 쓰는 미니 캘린더 effect들이 매 이동마다 재조회를 돌린다.
  setSelectedDate: (date) => set((s) => {
    const d = parseISO(date)
    const sameMonth = isValid(d) && isSameMonth(d, s.viewMonthDate)
    return {
      selectedDate: date,
      selectedWeek: null,
      ...(isValid(d) && !sameMonth ? { viewMonthDate: d } : {}),
    }
  }),

  setSelectedWeek: (weekKey, weekStart) => set((s) => ({
    selectedWeek: weekKey,
    selectedDate: format(weekStart, 'yyyy-MM-dd'),
    ...(isSameMonth(weekStart, s.viewMonthDate) ? {} : { viewMonthDate: weekStart }),
  })),

  setViewMonthDate: (date) => set({ viewMonthDate: date }),
}))
