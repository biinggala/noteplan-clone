'use client'
import { useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { eventToTimeRange } from '@/lib/google/calendar'

const NOTIFY_BEFORE_MINS = 10   // 몇 분 전에 알림
const CHECK_INTERVAL_MS  = 60_000  // 1분마다 체크

/** 이미 알림을 보낸 이벤트 ID를 기억 (세션 동안만) */
const notifiedIds = new Set<string>()

const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// WKWebView(Tauri)에는 Web Notification API가 없어 플러그인을 사용
async function requestPermission(): Promise<boolean> {
  if (typeof window === 'undefined') return false

  if (isTauri()) {
    const { isPermissionGranted, requestPermission } =
      await import('@tauri-apps/plugin-notification')
    if (await isPermissionGranted()) return true
    return (await requestPermission()) === 'granted'
  }

  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const perm = await Notification.requestPermission()
  return perm === 'granted'
}

async function showNotification(title: string, body: string) {
  if (isTauri()) {
    const { sendNotification } = await import('@tauri-apps/plugin-notification')
    sendNotification({ title, body })
    return
  }
  new Notification(title, { body, icon: '/icon.png', silent: false })
}

export function useEventNotifications() {
  const { eventsByDate } = useCalendarEventStore()
  const eventsByDateRef = useRef(eventsByDate)
  eventsByDateRef.current = eventsByDate

  useEffect(() => {
    let permitted = false
    requestPermission().then(ok => { permitted = ok })

    function check() {
      if (!permitted) return

      const now = new Date()
      const todayStr = format(now, 'yyyy-MM-dd')
      const events = eventsByDateRef.current[todayStr] ?? []
      const nowMs = now.getTime()

      for (const ev of events) {
        const { startHour, startMinute, allDay } = eventToTimeRange(ev)
        if (allDay) continue

        // 오늘 날짜 기준으로 이벤트 시작 시각을 ms로 계산
        const startMs = new Date(
          now.getFullYear(), now.getMonth(), now.getDate(),
          startHour, startMinute, 0, 0
        ).getTime()
        const diffMin = (startMs - nowMs) / 60_000

        // NOTIFY_BEFORE_MINS±0.5분 윈도우 안에 들어오는 이벤트
        if (diffMin > 0 && diffMin <= NOTIFY_BEFORE_MINS && !notifiedIds.has(ev.id)) {
          notifiedIds.add(ev.id)
          const minutesLeft = Math.round(diffMin)
          showNotification(
            ev.summary ?? '이벤트',
            `${minutesLeft}분 후에 시작됩니다`
          )
        }
      }
    }

    // 즉시 1번 체크 후 1분 주기
    check()
    const id = setInterval(check, CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, []) // eventsByDate는 ref로 추적 — 재등록 없이 최신값 사용
}
