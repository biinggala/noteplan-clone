'use client'
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { THEMES } from '@/lib/themes/themes'
import { useThemeStore } from '@/lib/stores/themeStore'

export default function ThemePicker() {
  const { themeId, setThemeId } = useThemeStore()
  const [open, setOpen]         = useState(false)
  const [pos, setPos]           = useState({ bottom: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPos({ bottom: window.innerHeight - r.top + 6, left: r.left })
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current  && !btnRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = THEMES.find(t => t.id === themeId) ?? THEMES[0]

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        title="테마 변경"
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs
                   text-[var(--text-muted)] hover:text-[var(--text-primary)]
                   hover:bg-white/5 transition-colors"
      >
        {/* Color swatch of current theme */}
        <span
          className="w-3 h-3 rounded-full border border-white/20 flex-shrink-0"
          style={{ backgroundColor: current.swatch }}
        />
        <span>{current.name}</span>
        <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && typeof window !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[300] w-52 rounded-xl border border-[var(--border)]
                     shadow-2xl overflow-hidden py-1.5"
          style={{
            bottom: pos.bottom,
            left:   pos.left,
            backgroundColor: 'var(--bg-secondary)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <div className="px-3 pb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            테마
          </div>
          {THEMES.map(theme => {
            const active = theme.id === themeId
            return (
              <button
                key={theme.id}
                onClick={() => { setThemeId(theme.id); setOpen(false) }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm
                           transition-colors text-left"
                style={{
                  backgroundColor: active ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : undefined,
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                onMouseEnter={e => {
                  if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--bg-tertiary)'
                }}
                onMouseLeave={e => {
                  if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = ''
                }}
              >
                {/* Swatch */}
                <span
                  className="w-4 h-4 rounded-full flex-shrink-0 border border-white/10"
                  style={{ backgroundColor: theme.swatch }}
                />
                <span className="flex-1">{theme.name}</span>
                {/* Dark/Light badge */}
                <span className="text-[10px] opacity-50">
                  {theme.dark ? '🌙' : '☀️'}
                </span>
                {/* Checkmark */}
                {active && (
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </>
  )
}
