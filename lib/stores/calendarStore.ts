'use client'
import { create } from 'zustand'
import { format } from 'date-fns'

interface CalendarStore {
  selectedDate: string  // YYYY-MM-DD
  today: string
  viewMonthDate: Date   // 미니 캘린더가 현재 보여주는 월
  setSelectedDate: (date: string) => void
  setViewMonthDate: (date: Date) => void
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  selectedDate: format(new Date(), 'yyyy-MM-dd'),
  today: format(new Date(), 'yyyy-MM-dd'),
  viewMonthDate: new Date(),
  setSelectedDate: (date) => set({ selectedDate: date }),
  setViewMonthDate: (date) => set({ viewMonthDate: date }),
}))
