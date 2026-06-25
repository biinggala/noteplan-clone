'use client'
import { useEffect } from 'react'

const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Tauri 전용: 드래그 영역(.electron-drag / [data-tauri-drag-region]) 어디를 잡아도
// 창이 이동되도록 명시적으로 startDragging() 호출.
// (data-tauri-drag-region 자동 감지는 요소를 "직접" 클릭할 때만 동작해서
//  텍스트/자식 위를 클릭하면 드래그가 안 되는 한계가 있음)
export default function TauriTitlebarDrag() {
  useEffect(() => {
    if (!isTauri()) return

    const onMouseDown = async (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      // 드래그 영역 안인지
      if (!target.closest('.electron-drag, [data-tauri-drag-region]')) return
      // 인터랙티브 요소 위면 드래그 금지
      if (target.closest('button, input, a, select, textarea, label, [role="button"], .cm-editor')) return

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().startDragging()
      } catch { /* 무시 */ }
    }

    // 더블클릭 → 창 최대화 토글 (macOS 기본 타이틀바 동작 재현)
    const onDblClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.electron-drag, [data-tauri-drag-region]')) return
      if (target.closest('button, input, a, select, textarea, label, [role="button"], .cm-editor')) return
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().toggleMaximize()
      } catch { /* 무시 */ }
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('dblclick', onDblClick)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('dblclick', onDblClick)
    }
  }, [])

  return null
}
