// 타임블록(노트 줄) ↔ 구글 캘린더 이벤트 연결과, 블록 쪽 변경을 이벤트에 옮기는 일.
// DayTimeline(블록 이동·리사이즈·삭제)과 pointerLineDrag(줄 드롭)가 같이 쓴다.
//
// 연결 기준: 이벤트의 private 속성 npTimeblock + '시작일(기기 시간대)'이 블록 날짜.
//  1) 시작 시각 + npContent 가 같은 것
//  2) 없으면 시작 시각만 같은 것 (노트에서 줄 내용을 고친 직후 — 곧 내용을 이벤트에 맞춰 PATCH)
// 예전엔 1)만 봐서, 줄 내용을 고치면 연결이 끊겨 블록을 지워도 이벤트가 남았다
// (그 이벤트는 npTimeblock 이라 타임라인에 그려지지도 않아 보이지 않는 고아가 됐다).

import { useAuthStore } from '@/lib/stores/authStore'
import { useCalendarEventStore } from '@/lib/stores/calendarEventStore'
import { useTimeBlockStore, type TimeBlock } from '@/lib/stores/timeBlockStore'
import { withGoogleToken, reportGoogleError } from '@/lib/google/withToken'
import {
  createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  dateAtMinutes, eventInterval, eventStartDay, eventTimeFor, toRfc3339,
  type GoogleCalendarEvent,
} from '@/lib/google/calendar'

export const blockStartMins = (b: Pick<TimeBlock, 'startHour' | 'startMinute'>) => b.startHour * 60 + b.startMinute

function eventStartMins(ev: GoogleCalendarEvent): number | null {
  const iv = eventInterval(ev)
  return iv ? iv.start.getHours() * 60 + iv.start.getMinutes() : null
}

/** 블록 id → 연결된 이벤트. 이벤트 하나는 블록 하나에만 연결된다. */
export function linkTimeblocks(
  blocks: TimeBlock[],
  eventsByDate: Record<string, GoogleCalendarEvent[]>,
): Map<string, GoogleCalendarEvent> {
  const out = new Map<string, GoogleCalendarEvent>()
  const byDate = new Map<string, TimeBlock[]>()
  for (const b of blocks) {
    const list = byDate.get(b.date)
    if (list) list.push(b)
    else byDate.set(b.date, [b])
  }
  for (const [date, dayBlocks] of byDate) {
    const cands = (eventsByDate[date] ?? []).filter(ev =>
      !!ev.extendedProperties?.private?.npTimeblock && eventStartDay(ev) === date && eventStartMins(ev) !== null)
    if (cands.length === 0) continue
    const used = new Set<string>()
    const pending: TimeBlock[] = []
    for (const b of dayBlocks) {
      const ev = cands.find(e => !used.has(e.id) && eventStartMins(e) === blockStartMins(b)
        && (e.extendedProperties?.private?.npContent ?? '') === b.content)
      if (ev) { used.add(ev.id); out.set(b.id, ev) } else pending.push(b)
    }
    for (const b of pending) {
      const ev = cands.find(e => !used.has(e.id) && eventStartMins(e) === blockStartMins(b))
      if (ev) { used.add(ev.id); out.set(b.id, ev) }
    }
  }
  return out
}

export function linkedEventFor(block: TimeBlock): GoogleCalendarEvent | undefined {
  const sameDay = useTimeBlockStore.getState().timeBlocks.filter(b => b.date === block.date)
  return linkTimeblocks(sameDay, useCalendarEventStore.getState().eventsByDate).get(block.id)
}

function isDoneOrCancelled(linePrefix?: string) {
  return !!linePrefix && (/\[x\]/i.test(linePrefix) || /\[-\]/.test(linePrefix))
}

/** 블록 상태로 본 이벤트 제목 (완료/취소면 ✓) */
export function desiredSummary(b: TimeBlock): string {
  return isDoneOrCancelled(b.linePrefix) ? `✓ ${b.content}` : b.content
}

/** 블록을 옮기거나 늘렸을 때 연결된 이벤트 시각도 같이. 실패하면 되돌리고 알린다. */
export async function moveTimeblockEvent(
  ev: GoogleCalendarEvent | null | undefined,
  date: string, startMins: number, duration: number,
) {
  if (!ev || !useAuthStore.getState().googleAccessToken) return
  const start = dateAtMinutes(date, startMins)
  const end = dateAtMinutes(date, startMins + duration)   // 자정을 넘으면 다음날로 (T24:00 X)
  const prev = { start: ev.start, end: ev.end }
  const store = useCalendarEventStore.getState()
  store.updateEvent(ev.id, {
    start: eventTimeFor(start, ev.start.timeZone),
    end: eventTimeFor(end, ev.end.timeZone),
  })
  try {
    await withGoogleToken(token => updateCalendarEvent(token, ev.calendarId, ev.id, {
      start, end, startTimeZone: ev.start.timeZone, endTimeZone: ev.end.timeZone,
    }))
  } catch (err) {
    useCalendarEventStore.getState().updateEvent(ev.id, prev)
    reportGoogleError(err, 'timeblock → gcal 시간 동기화')
  }
}

/** 블록 내용·완료 상태를 이벤트 제목/npContent 에 반영. 실패하면 되돌린다. */
export async function syncTimeblockSummary(ev: GoogleCalendarEvent, summary: string, content: string) {
  const prevSummary = ev.summary
  const prevExt = ev.extendedProperties
  const privateProps = { ...(ev.extendedProperties?.private ?? {}), npTimeblock: '1', npContent: content }
  useCalendarEventStore.getState().updateEvent(ev.id, {
    summary, extendedProperties: { ...(ev.extendedProperties ?? {}), private: privateProps },
  })
  try {
    await withGoogleToken(token => updateCalendarEvent(token, ev.calendarId, ev.id, { summary, privateProps }))
  } catch (err) {
    useCalendarEventStore.getState().updateEvent(ev.id, { summary: prevSummary, extendedProperties: prevExt })
    reportGoogleError(err, 'timeblock 내용 → gcal')
  }
}

/** 블록을 지울 때 연결된 이벤트도. 실패하면 화면에 되돌린다. */
export async function deleteTimeblockEvent(ev: GoogleCalendarEvent | null | undefined) {
  if (!ev || !useAuthStore.getState().googleAccessToken) return
  useCalendarEventStore.getState().removeEvent('', ev.id)
  try {
    await withGoogleToken(token => deleteCalendarEvent(token, ev.calendarId, ev.id))
  } catch (err) {
    useCalendarEventStore.getState().restoreEvent(ev)
    reportGoogleError(err, 'timeblock 삭제 → gcal')
  }
}

/** 새 타임블록에 대응하는 구글 이벤트 생성 (마커로 타임라인 중복 표시 방지) */
export async function createTimeblockEvent(date: string, startMins: number, duration: number, content: string) {
  // 캘린더를 연결 안 한 사용자는 노트 타임블록만으로 충분 — 조용히 넘어간다
  if (!useAuthStore.getState().googleAccessToken) return
  const start = dateAtMinutes(date, startMins)
  const end = dateAtMinutes(date, startMins + duration)
  try {
    const ev = await withGoogleToken(token => createCalendarEvent(token, {
      calendarId: 'primary',
      summary: content,
      startDateTime: toRfc3339(start),
      endDateTime: toRfc3339(end),
      extendedProperties: { private: { npTimeblock: '1', npContent: content } },
    }))
    // eventsByDate에 추가(블록과 연결돼 렌더는 스킵) → 즉시 재검색으로 삭제/완료 동기화 가능.
    // 다음 fetch 시 Google에서 마커 이벤트로 다시 받아오므로 재시작·기기 무관.
    useCalendarEventStore.getState().addEvent(date, ev)
  } catch (err) {
    reportGoogleError(err, 'timeblock → gcal')
  }
}
