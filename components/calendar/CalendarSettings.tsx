'use client'
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { createClient } from '@/lib/supabase/client'
import { startGoogleOAuth } from '@/lib/auth/googleOAuth'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useAuthStore } from '@/lib/stores/authStore'

export default function CalendarSettings() {
  const [open, setOpen] = useState(false)
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const { calendars, enabledCalendarIds, toggleCalendar } = useCalendarEventStore()
  // 로그인은 캘린더 권한 없이도 되므로, 아직 연결 안 한 사용자가 있을 수 있다
  const { googleAccessToken, setGoogleAuthError } = useAuthStore()
  const connected = !!googleAccessToken

  // 버튼 위치 기반으로 패널 위치 계산
  useEffect(() => {
    if (!open || !btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setPanelPos({
      top:  rect.bottom + 6,
      left: rect.left,
    })
  }, [open])

  async function handleReconnect() {
    setOpen(false)
    const supabase = createClient()
    // Tauri는 시스템 브라우저 + noteplan:// 딥링크, 웹은 같은 창 redirect
    // (콜백은 전역 TauriAuthDeepLink 핸들러가 처리)
    const { error } = await startGoogleOAuth(supabase, { withCalendar: true })
    // 여기서 나는 에러는 linkIdentity 요청 자체가 실패한 경우다(예: manual
    // linking 꺼짐) — 리다이렉트가 시작되기도 전이라 플랫폼 무관하게 바로 뜬다.
    // 리다이렉트 이후(코드 교환) 단계의 실패는 웹은 콜백 페이지가,
    // Tauri는 TauriAuthDeepLink가 각각 별도로 처리한다.
    if (error) setGoogleAuthError(error)
  }

  const panel = open && (
    <>
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      <div
        className="fixed z-50 w-64 rounded-lg border border-[var(--border)]
          bg-[var(--bg-secondary)] shadow-xl py-2"
        style={{ top: panelPos.top, left: panelPos.left }}
      >
        <div className="px-3 py-1.5 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          캘린더
        </div>
        {calendars.length === 0 && (
          <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
            {connected ? '캘린더를 불러오는 중...' : '아직 연결된 캘린더가 없습니다'}
          </div>
        )}
        {calendars.map(cal => {
          const enabled = enabledCalendarIds.has(cal.id)
          return (
            <button
              key={cal.id}
              onClick={() => toggleCalendar(cal.id)}
              className="flex items-center gap-2.5 w-full px-3 py-2 hover:bg-white/5 transition-colors text-left"
            >
              <div
                className="w-4 h-4 rounded flex-shrink-0 flex items-center justify-center"
                style={{
                  backgroundColor: enabled ? cal.backgroundColor : 'transparent',
                  border: `2px solid ${cal.backgroundColor}`,
                }}
              >
                {enabled && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <span className={`text-sm truncate ${enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                {cal.summary}
                {cal.primary && <span className="ml-1 text-[10px] text-[var(--text-muted)]">(기본)</span>}
              </span>
            </button>
          )
        })}

        {/* 재인증 구분선 + 버튼 */}
        <div className="border-t border-[var(--border)] mt-1 pt-1 px-3 pb-1">
          <button
            onClick={handleReconnect}
            className="flex items-center gap-2 w-full px-0 py-1.5 text-xs
              text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {connected ? 'Google 캘린더 재연결 (쓰기 권한)' : 'Google 캘린더 연결'}
          </button>
        </div>
      </div>
    </>
  )

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        title="캘린더 설정"
        className={`w-6 h-5 rounded flex items-center justify-center transition-colors
          ${open
            ? 'bg-white/10 text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-white/5'
          }`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {/* overflow 컨테이너를 탈출해 body에 직접 렌더 */}
      {typeof window !== 'undefined' && panel && createPortal(panel, document.body)}
    </>
  )
}
