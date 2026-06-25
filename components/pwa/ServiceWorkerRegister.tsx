'use client'
import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export default function ServiceWorkerRegister() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState(false)

  // Register the service worker (production only — dev has no /sw.js build step).
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    if (process.env.NODE_ENV !== 'production') return
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[PWA] SW registration failed', err)
      })
    }
    window.addEventListener('load', onLoad)
    return () => window.removeEventListener('load', onLoad)
  }, [])

  // Capture the install prompt so we can surface a custom "Add to Home Screen" CTA.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setDeferred(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    if (sessionStorage.getItem('np-install-dismissed')) setDismissed(true)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!deferred || dismissed) return null

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[300] flex items-center gap-3
                 rounded-full border border-[var(--border)] bg-[var(--bg-secondary)]/95
                 px-4 py-2 shadow-2xl backdrop-blur"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
    >
      <img src="/icons/icon-192.png" alt="" className="w-7 h-7 rounded-lg" />
      <span className="text-sm text-[var(--text-primary)] whitespace-nowrap">
        홈 화면에 앱 설치
      </span>
      <button
        onClick={async () => {
          await deferred.prompt()
          await deferred.userChoice
          setDeferred(null)
        }}
        className="text-sm font-medium rounded-full bg-[var(--accent)] text-white px-3 py-1"
      >
        설치
      </button>
      <button
        onClick={() => {
          setDismissed(true)
          sessionStorage.setItem('np-install-dismissed', '1')
        }}
        aria-label="닫기"
        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
      >
        ✕
      </button>
    </div>
  )
}
