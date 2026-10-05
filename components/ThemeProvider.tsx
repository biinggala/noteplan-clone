'use client'
import { useEffect, useState } from 'react'
import { useThemeStore } from '@/lib/stores/themeStore'
import { getTheme, resolveThemeId } from '@/lib/themes/themes'

export default function ThemeProvider() {
  const { themeId } = useThemeStore()
  const [prefersDark, setPrefersDark] = useState(true)

  // 'System' 이면 기기의 라이트/다크 전환을 실시간으로 따라간다
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setPrefersDark(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const resolved = resolveThemeId(themeId, prefersDark)
    const theme = getTheme(resolved)
    const root  = document.documentElement

    // Apply all CSS variables to :root
    Object.entries(theme.vars).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })

    // data-theme for any CSS selectors that need it
    root.setAttribute('data-theme', resolved)
    root.setAttribute('data-dark', theme.dark ? 'true' : 'false')
    root.style.colorScheme = theme.dark ? 'dark' : 'light'   // 스크롤바·폼 컨트롤도 테마에 맞춘다
  }, [themeId, prefersDark])

  return null
}
