'use client'
import { useRef, useCallback } from 'react'
import { useUIStore } from '@/lib/stores/uiStore'
import { motion, AnimatePresence } from 'framer-motion'

interface ThreePanelLayoutProps {
  left: React.ReactNode
  center: React.ReactNode
  right: React.ReactNode
}

export default function ThreePanelLayout({ left, center, right }: ThreePanelLayoutProps) {
  const {
    leftSidebarWidth, rightSidebarWidth,
    leftSidebarVisible, rightSidebarVisible,
    setLeftSidebarWidth, setRightSidebarWidth,
  } = useUIStore()

  const isResizingLeft = useRef(false)
  const isResizingRight = useRef(false)

  const startResizeLeft = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingLeft.current = true
    const startX = e.clientX
    const startW = leftSidebarWidth

    const onMove = (ev: MouseEvent) => {
      if (!isResizingLeft.current) return
      const delta = ev.clientX - startX
      const newW = Math.min(400, Math.max(180, startW + delta))
      setLeftSidebarWidth(newW)
    }
    const onUp = () => {
      isResizingLeft.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [leftSidebarWidth, setLeftSidebarWidth])

  const startResizeRight = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRight.current = true
    const startX = e.clientX
    const startW = rightSidebarWidth

    const onMove = (ev: MouseEvent) => {
      if (!isResizingRight.current) return
      const delta = startX - ev.clientX
      const newW = Math.min(400, Math.max(200, startW + delta))
      setRightSidebarWidth(newW)
    }
    const onUp = () => {
      isResizingRight.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [rightSidebarWidth, setRightSidebarWidth])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Left Sidebar */}
      <AnimatePresence initial={false}>
        {leftSidebarVisible && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: leftSidebarWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="flex-shrink-0 h-full overflow-hidden border-r border-[var(--border)]"
            style={{ width: leftSidebarWidth }}
          >
            <div className="h-full w-full overflow-y-auto sidebar-glass">
              {left}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Left Resize Handle */}
      {leftSidebarVisible && (
        <div
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
          onMouseDown={startResizeLeft}
        />
      )}

      {/* Center Panel */}
      <main className="flex-1 h-full overflow-hidden flex flex-col">
        {center}
      </main>

      {/* Right Resize Handle */}
      {rightSidebarVisible && (
        <div
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
          onMouseDown={startResizeRight}
        />
      )}

      {/* Right Sidebar */}
      <AnimatePresence initial={false}>
        {rightSidebarVisible && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: rightSidebarWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="flex-shrink-0 h-full overflow-hidden border-l border-[var(--border)]"
            style={{ width: rightSidebarWidth }}
          >
            <div className="h-full w-full overflow-y-auto sidebar-glass">
              {right}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}
