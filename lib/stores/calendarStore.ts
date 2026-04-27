'use client'
import { create } from 'zustand'
import { format } from 'date-fns'

interface CalendarStore {
  selectedDate: string  // YYYY-MM-DD
  today: string
  setSelectedDate: (date: string) => void
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  selectedDate: format(new Date(), 'yyyy-MM-dd'),
  today: format(new Date(), 'yyyy-MM-dd'),
  setSelectedDate: (date) => set({ selectedDate: date }),
}))
