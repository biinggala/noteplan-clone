'use client'
import { useEffect } from 'react'
import { addDays, format } from 'date-fns'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { eventInterval, isDeclinedBySelf, type GoogleCalendarEvent } from '@/lib/google/calendar'
import { useTodayEvents } from '@/lib/hooks/useTodayEvents'

const NOTIFY_BEFORE_MINS = 10   // 몇 분 전에 알림
const CHECK_INTERVAL_MS  = 60_000  // 1분마다 체크

/** 이미 알림을 보낸 (이벤트 ID + 시작 시각) — 일정을 옮기면 새 시각으로 다시 알린다 (세션 동안만) */
const notifiedKeys = new Set<string>()

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

/** 지금부터 NOTIFY_BEFORE_MINS 안에 '시작하는' 일정 (실제 시작 시각 기준) */
export function eventsStartingSoon(
  eventsByDate: Record<string, GoogleCalendarEvent[]>,
  now: Date,
): { ev: GoogleCalendarEvent; start: Date; minutesLeft: number }[] {
  const days = [format(now, 'yyyy-MM-dd'), format(addDays(now, 1), 'yyyy-MM-dd')]
  const seen = new Set<string>()
  const out: { ev: GoogleCalendarEvent; start: Date; minutesLeft: number }[] = []
  for (const d of days) {
    for (const ev of eventsByDate[d] ?? []) {
      if (seen.has(ev.id)) continue
      seen.add(ev.id)
      if (isDeclinedBySelf(ev)) continue          // 거절한 일정은 알리지 않는다
      const iv = eventInterval(ev)
      if (!iv) continue                            // 종일 일정
      // 시·분만 보고 '오늘 그 시각'으로 계산하면 어제 시작한 일정이 오늘 같은 시각에 또 울렸다
      const diffMin = (iv.start.getTime() - now.getTime()) / 60_000
      if (diffMin > 0 && diffMin <= NOTIFY_BEFORE_MINS) {
        out.push({ ev, start: iv.start, minutesLeft: Math.max(1, Math.round(diffMin)) })
      }
    }
  }
  return out
}

export function useEventNotifications() {
  // 오늘 일정은 화면과 상관없이 주기적으로 불러온다 (레이아웃에서 이 훅이 한 번 돈다)
  useTodayEvents()

  useEffect(() => {
    let permitted = false
    requestPermission().then(ok => { permitted = ok; if (ok) check() })

    function check() {
      if (!permitted) return
      for (const { ev, start, minutesLeft } of eventsStartingSoon(useCalendarEventStore.getState().eventsByDate, new Date())) {
        const key = `${ev.id}|${start.getTime()}`
        if (notifiedKeys.has(key)) continue
        notifiedKeys.add(key)
        void showNotification(ev.summary ?? '이벤트', `${minutesLeft}분 후에 시작됩니다`)
      }
    }

    // 즉시 1번 체크 후 1분 주기 + 일정을 새로 불러오면 바로 한 번 더
    check()
    const id = setInterval(check, CHECK_INTERVAL_MS)
    const unsub = useCalendarEventStore.subscribe((s, prev) => { if (s.eventsByDate !== prev.eventsByDate) check() })
    return () => { clearInterval(id); unsub() }
  }, []) // eventsByDate는 getState()로 최신값을 읽는다 — 재등록 없이
}
