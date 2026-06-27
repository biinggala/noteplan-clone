'use client'
import { useEffect } from 'react'

// service worker 등록 (PWA 설치 가능 + 오프라인 셸). Tauri/SSR 환경에선 무시.
export default function PWARegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if ('__TAURI_INTERNALS__' in window) return // 데스크톱 앱에선 불필요
    if (!('serviceWorker' in navigator)) return
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* 무시 */ })
    }
    window.addEventListener('load', onLoad)
    return () => window.removeEventListener('load', onLoad)
  }, [])
  return null
}
