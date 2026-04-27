'use client'
import { useEffect } from 'react'
import { useThemeStore } from '@/lib/stores/themeStore'
import { getTheme } from '@/lib/themes/themes'

export default function ThemeProvider() {
  const { themeId } = useThemeStore()

  useEffect(() => {
    const theme = getTheme(themeId)
    const root  = document.documentElement

    // Apply all CSS variables to :root
    Object.entries(theme.vars).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })

    // data-theme for any CSS selectors that need it
    root.setAttribute('data-theme', themeId)
    root.setAttribute('data-dark', theme.dark ? 'true' : 'false')
  }, [themeId])

  return null
}
