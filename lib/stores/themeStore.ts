import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_THEME_ID } from '@/lib/themes/themes'

interface ThemeStore {
  themeId: string
  setThemeId: (id: string) => void
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME_ID,
      setThemeId: (id) => set({ themeId: id }),
    }),
    { name: 'noteplan-theme' }
  )
)
