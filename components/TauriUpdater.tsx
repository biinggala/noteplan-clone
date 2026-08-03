'use client'
import { useCallback, useEffect, useState } from 'react'
import { isTauri } from '@/lib/auth/googleOAuth'

type Phase = 'idle' | 'found' | 'downloading' | 'ready' | 'error'

interface Found {
  version: string
  notes?: string
}

/**
 * 새 버전 알림 (데스크톱 전용).
 *
 * 앱을 켤 때 한 번 확인하고, 있으면 우측 하단에 배너를 띄운다.
 * 자동으로 받지는 않는다 — 쓰던 중에 재시작을 강요하지 않으려고.
 *
 * ⚠️ 지금 빌드는 ad-hoc 서명(signingIdentity "-")에 공증도 안 돼 있다.
 * 그래서 설치 단계에서 macOS가 막을 수 있다. 그 경우를 대비해 실패하면
 * 릴리즈 페이지를 직접 열 수 있게 해둔다.
 */
export default function TauriUpdater() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [found, setFound] = useState<Found | null>(null)
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  // update 객체는 렌더와 무관하므로 state 대신 클로저로 들고 있는다
  const [updateRef, setUpdateRef] = useState<{ downloadAndInstall: (cb: (e: unknown) => void) => Promise<void> } | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false

    ;(async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (cancelled || !update) return
        setUpdateRef(update as never)
        setFound({ version: update.version, notes: update.body })
        setPhase('found')
      } catch (e) {
        // 네트워크가 없거나 매니페스트가 아직 없을 수 있다 — 조용히 넘어간다
        console.warn('[updater] check failed', e)
      }
    })()

    return () => { cancelled = true }
  }, [])

  const install = useCallback(async () => {
    if (!updateRef) return
    setPhase('downloading')
    setProgress(0)
    try {
      let total = 0, got = 0
      await updateRef.downloadAndInstall((ev: unknown) => {
        const e = ev as { event: string; data?: { contentLength?: number; chunkLength?: number } }
        if (e.event === 'Started') total = e.data?.contentLength ?? 0
        else if (e.event === 'Progress') {
          got += e.data?.chunkLength ?? 0
          if (total > 0) setProgress(Math.round((got / total) * 100))
        }
      })
      setPhase('ready')
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [updateRef])

  if (phase === 'idle' || !found) return null

  return (
    <div className="fixed bottom-4 right-4 z-[9999] w-72 rounded-lg border border-[var(--border)]
      bg-[var(--bg-secondary)] shadow-xl p-3 text-[var(--text-primary)]">
      {phase === 'found' && (
        <>
          <div className="text-sm font-semibold mb-1">새 버전 {found.version}</div>
          {found.notes && (
            <div className="text-[11px] text-[var(--text-muted)] mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
              {found.notes}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={install}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-[var(--accent)] text-white font-medium"
            >
              업데이트
            </button>
            <button
              onClick={() => setPhase('idle')}
              className="px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              나중에
            </button>
          </div>
        </>
      )}

      {phase === 'downloading' && (
        <>
          <div className="text-sm font-semibold mb-2">내려받는 중… {progress}%</div>
          <div className="h-1 rounded bg-[var(--bg-tertiary)] overflow-hidden">
            <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${progress}%` }} />
          </div>
        </>
      )}

      {phase === 'ready' && <div className="text-sm">설치 완료. 재시작합니다…</div>}

      {phase === 'error' && (
        <>
          <div className="text-sm font-semibold mb-1">업데이트 실패</div>
          <div className="text-[11px] text-[var(--text-muted)] mb-2 break-words">{errorMsg}</div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                const { openUrl } = await import('@tauri-apps/plugin-opener')
                await openUrl('https://github.com/biinggala/noteplan-clone/releases/latest')
              }}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-[var(--bg-tertiary)]"
            >
              직접 받기
            </button>
            <button
              onClick={() => setPhase('idle')}
              className="px-2 py-1.5 text-xs text-[var(--text-muted)]"
            >
              닫기
            </button>
          </div>
        </>
      )}
    </div>
  )
}
