import { addDays, addMinutes, format, parseISO } from 'date-fns'

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface GoogleCalendar {
  id: string
  summary: string
  description?: string
  backgroundColor: string   // e.g. "#0B8043"
  foregroundColor: string
  primary?: boolean
  selected?: boolean
  /** "owner" | "writer" | "reader" | "freeBusyReader" */
  accessRole?: string
}

export interface EventTime {
  dateTime?: string
  date?: string
  /** 이벤트에 지정된 시간대. 수정할 때 그대로 돌려보낸다 (브라우저 시간대로 덮지 않는다) */
  timeZone?: string
}

export interface GoogleCalendarEvent {
  id: string
  calendarId: string        // 어느 캘린더 소속인지
  calendarColor: string     // 캘린더 색상 (상속)
  summary: string
  description?: string
  colorId?: string
  start: EventTime
  end:   EventTime
  htmlLink: string
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> }
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[]
  organizer?: { email?: string; self?: boolean }
  guestsCanModify?: boolean
  locked?: boolean
}

// ── 캘린더 목록 fetch ─────────────────────────────────────────────────────────

export async function fetchCalendarList(accessToken: string): Promise<GoogleCalendar[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) {
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    // 403 = 토큰은 살아있는데 캘린더 권한이 없음. 로그인은 email/profile만
    // 받으므로, 캘린더 연결을 한 번도 안 했거나 로그인 토큰이 캘린더 토큰을
    // 덮어쓴 경우 여기로 온다. 만료와 구분해야 안내 문구가 맞다.
    if (res.status === 403) throw new Error('GOOGLE_CALENDAR_SCOPE_MISSING')
    throw new Error(`CalendarList API error: ${res.status}`)
  }
  const data = await res.json()
  return (data.items ?? []) as GoogleCalendar[]
}

// ── 날짜 범위 이벤트 fetch (단일 캘린더) ─────────────────────────────────────

export async function fetchCalendarEventsForRange(
  accessToken: string,
  calendarId: string,
  calendarColor: string,
  startDate: string,   // 'YYYY-MM-DD'
  endDate: string,     // 'YYYY-MM-DD' (inclusive)
): Promise<GoogleCalendarEvent[]> {
  // 기기 시간대의 자정 ~ 마지막 날 다음 자정 (배타적)
  const timeMin = parseISO(startDate).toISOString()
  const timeMax = addDays(parseISO(endDate), 1).toISOString()

  const items: Record<string, unknown>[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    )
    url.searchParams.set('timeMin', timeMin)
    url.searchParams.set('timeMax', timeMax)
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '500')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
      throw new Error(`Calendar API error: ${res.status}`)
    }
    const data = await res.json()
    items.push(...((data.items ?? []) as Record<string, unknown>[]))
    pageToken = data.nextPageToken
    if (!pageToken) break
  }
  return items
    // 취소된 일정(singleEvents 예외 등)은 보이지 않아야 한다
    .filter(item => item.status !== 'cancelled')
    .map(item => ({ ...(item as object), calendarId, calendarColor })) as GoogleCalendarEvent[]
}

// ── 날짜 범위 이벤트 fetch (모든 활성 캘린더) → 날짜별로 그룹화 ──────────────

/**
 * 일부 캘린더만 실패했을 때. 받은 만큼은 partial에 들어 있다.
 * 예전엔 실패한 캘린더를 조용히 빼고 '그 날은 일정 없음'으로 캐시해서,
 * 다시 불러오지도 않고 에러도 안 보였다.
 */
export class CalendarFetchError extends Error {
  partial: Record<string, GoogleCalendarEvent[]>
  constructor(message: string, partial: Record<string, GoogleCalendarEvent[]>) {
    super(message)
    this.name = 'CalendarFetchError'
    this.partial = partial
  }
}

export async function fetchAllCalendarEventsForRange(
  accessToken: string,
  calendars: GoogleCalendar[],
  enabledIds: Set<string>,
  startDate: string,
  endDate: string,
): Promise<Record<string, GoogleCalendarEvent[]>> {
  const active = calendars.filter(c => enabledIds.has(c.id))
  const results = await Promise.allSettled(
    active.map(c =>
      fetchCalendarEventsForRange(accessToken, c.id, c.backgroundColor, startDate, endDate)
    )
  )
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  // 토큰 만료는 호출한 쪽이 갱신 후 다시 부를 수 있게 그대로 올린다
  if (failed.some(r => r.reason instanceof Error && r.reason.message === 'GOOGLE_TOKEN_EXPIRED')) {
    throw new Error('GOOGLE_TOKEN_EXPIRED')
  }
  const allEvents = results
    .filter((r): r is PromiseFulfilledResult<GoogleCalendarEvent[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  // 날짜별 그룹화 — 며칠에 걸친 일정은 걸친 모든 날짜에 추가 (시작일만 X)
  const grouped: Record<string, GoogleCalendarEvent[]> = {}
  for (const ev of allEvents) {
    for (const d of eventCoveredDates(ev)) {
      if (!grouped[d]) grouped[d] = []
      grouped[d].push(ev)
    }
  }
  if (failed.length > 0) {
    const reason = failed[0].reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    throw new CalendarFetchError(`${failed.length}개 캘린더를 불러오지 못했습니다: ${msg}`, grouped)
  }
  return grouped
}

// ── 날짜/시각 유틸 (모두 '기기 시간대' 기준) ──────────────────────────────────

const dayKey = (d: Date) => format(d, 'yyyy-MM-dd')

/** 구글에 보낼 RFC3339 (오프셋 포함, 예: 2026-10-05T09:00:00+09:00) */
export function toRfc3339(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm:ssxxx")
}

/** 'YYYY-MM-DD' 날짜의 자정에서 mins분 뒤 (mins ≥ 1440 이면 다음날로 넘어간다) */
export function dateAtMinutes(date: string, mins: number): Date {
  return addMinutes(parseISO(date), mins)
}

export function isAllDayEvent(ev: GoogleCalendarEvent): boolean {
  return !!ev.start.date && !ev.start.dateTime
}

/** 시간 지정 이벤트의 시작/끝 (Date). 종일 일정이면 null */
export function eventInterval(ev: GoogleCalendarEvent): { start: Date; end: Date } | null {
  if (isAllDayEvent(ev) || !ev.start.dateTime) return null
  const start = new Date(ev.start.dateTime)
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : start
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null
  return { start, end: end < start ? start : end }
}

/**
 * 이벤트가 걸치는 모든 날짜(YYYY-MM-DD, 기기 시간대) 목록.
 * - 종일: end.date 가 배타적
 * - 시간 지정: 끝 시각이 배타적 → 자정에 딱 끝나는 일정은 다음날에 나오지 않는다.
 *   문자열의 날짜 부분이 아니라 실제 시각을 기기 시간대로 바꿔서 나눈다
 *   (다른 시간대로 만든 일정이 엉뚱한 날에 붙던 문제).
 */
export function eventCoveredDates(ev: GoogleCalendarEvent): string[] {
  const dates: string[] = []
  if (isAllDayEvent(ev)) {
    const startStr = ev.start.date!
    const endStr = ev.end?.date ?? startStr
    let cur = parseISO(startStr)
    const end = parseISO(endStr)
    while (cur < end && dates.length < 400) { dates.push(dayKey(cur)); cur = addDays(cur, 1) }
    return dates.length ? dates : [startStr]
  }
  const iv = eventInterval(ev)
  if (!iv) return []
  let cur = parseISO(dayKey(iv.start))
  while (cur < iv.end && dates.length < 400) { dates.push(dayKey(cur)); cur = addDays(cur, 1) }
  return dates.length ? dates : [dayKey(iv.start)]   // 길이 0 인 일정
}

/** 이벤트 시작의 기기 시간대 날짜 (종일이면 start.date) */
export function eventStartDay(ev: GoogleCalendarEvent): string | null {
  if (isAllDayEvent(ev)) return ev.start.date ?? null
  const iv = eventInterval(ev)
  return iv ? dayKey(iv.start) : null
}

export interface DaySegment {
  startMins: number      // 그 날 00:00 부터 (0..1440)
  endMins: number        // (0..1440), 다음날 자정까지면 1440
  startsBefore: boolean  // 전날부터 이어짐
  endsAfter: boolean     // 다음날로 이어짐
}

/** 시간 지정 이벤트를 date 칸의 [00:00, 다음날 00:00) 로 자른 구간. 그 날과 안 겹치면 null */
export function eventSegmentForDay(ev: GoogleCalendarEvent, date: string): DaySegment | null {
  const iv = eventInterval(ev)
  if (!iv) return null
  const dayStart = parseISO(date)
  const dayEnd = addDays(dayStart, 1)
  const zeroLen = iv.end.getTime() === iv.start.getTime()
  if (zeroLen ? !(iv.start >= dayStart && iv.start < dayEnd) : (iv.end <= dayStart || iv.start >= dayEnd)) return null
  const segStart = iv.start < dayStart ? dayStart : iv.start
  const segEnd = iv.end > dayEnd ? dayEnd : iv.end
  const minsOf = (d: Date) => (d.getTime() >= dayEnd.getTime() ? 1440 : d.getHours() * 60 + d.getMinutes())
  return {
    startMins: minsOf(segStart),
    endMins: Math.max(minsOf(segStart), minsOf(segEnd)),
    startsBefore: iv.start < dayStart,
    endsAfter: iv.end > dayEnd,
  }
}

/** 내가 거절한 일정 */
export function isDeclinedBySelf(ev: GoogleCalendarEvent): boolean {
  return !!ev.attendees?.some(a => a.self && a.responseStatus === 'declined')
}

// ── 이벤트 생성 ───────────────────────────────────────────────────────────────

export interface CreateEventPayload {
  calendarId: string
  summary: string
  description?: string
  startDateTime: string   // RFC3339 (toRfc3339 권장 — 끝이 다음날로 넘어가도 유효)
  endDateTime:   string
  timeZone?:     string
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> }
}

export async function createCalendarEvent(
  accessToken: string,
  payload: CreateEventPayload,
): Promise<GoogleCalendarEvent & { calendarId: string; calendarColor: string }> {
  const tz = payload.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const body: Record<string, unknown> = {
    summary: payload.summary,
    description: payload.description,
    start: { dateTime: payload.startDateTime, timeZone: tz },
    end:   { dateTime: payload.endDateTime,   timeZone: tz },
  }
  if (payload.extendedProperties) body.extendedProperties = payload.extendedProperties
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeCalId(payload.calendarId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) {
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    const text = await res.text()
    throw new Error(`Create event error ${res.status}: ${text}`)
  }
  const data = await res.json()
  return { ...data, calendarId: payload.calendarId, calendarColor: '' }
}

/** 종일(all-day) 이벤트 생성. Google은 end.date가 배타적(다음날)이어야 함. */
export async function createAllDayEvent(
  accessToken: string,
  payload: { calendarId: string; summary: string; date: string }, // date: 'YYYY-MM-DD'
): Promise<GoogleCalendarEvent & { calendarId: string; calendarColor: string }> {
  // toISOString() 은 UTC 라서 한국(UTC+9)에선 다음날 자정이 '오늘'로 찍혀
  // end == start → 구글이 400 으로 거절했다. 날짜 문자열끼리 계산한다.
  const endDate = format(addDays(parseISO(payload.date), 1), 'yyyy-MM-dd')
  const body = {
    summary: payload.summary,
    start: { date: payload.date },
    end: { date: endDate },
  }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeCalId(payload.calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) {
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    const text = await res.text()
    throw new Error(`Create all-day event error ${res.status}: ${text}`)
  }
  const data = await res.json()
  return { ...data, calendarId: payload.calendarId, calendarColor: '' }
}

// ── 이벤트 수정 ───────────────────────────────────────────────────────────────

export interface UpdateEventPatch {
  start?: Date
  end?: Date
  /** 원래 이벤트의 start.timeZone / end.timeZone — 있으면 그대로 유지 */
  startTimeZone?: string
  endTimeZone?: string
  summary?: string
  /** extendedProperties.private 전체 (덮어쓸 값 포함) */
  privateProps?: Record<string, string>
}

/** PATCH 에 실을 start/end 객체 (스토어 낙관적 반영에도 같은 값을 쓴다) */
export function eventTimeFor(d: Date, timeZone?: string): EventTime {
  return timeZone ? { dateTime: toRfc3339(d), timeZone } : { dateTime: toRfc3339(d) }
}

export async function updateCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  patch: UpdateEventPatch,
): Promise<void> {
  // 시각은 오프셋을 붙인 RFC3339 로 보내 '어느 시간대 기준인지'가 문자열에 들어 있게 한다.
  // timeZone 은 이벤트가 원래 갖고 있던 값만 돌려보낸다 — 예전엔 브라우저 시간대로
  // 덮어써서, 다른 시간대로 만든 일정을 한 번 옮기면 그 일정의 시간대가 바뀌었다.
  const body: Record<string, unknown> = {}
  if (patch.summary !== undefined) body.summary = patch.summary
  if (patch.start) body.start = eventTimeFor(patch.start, patch.startTimeZone)
  if (patch.end)   body.end   = eventTimeFor(patch.end, patch.endTimeZone)
  if (patch.privateProps) body.extendedProperties = { private: patch.privateProps }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeCalId(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) {
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    const text = await res.text()
    throw new Error(`Update event error ${res.status}: ${text}`)
  }
}

// ── 이벤트 삭제 ───────────────────────────────────────────────────────────────

export async function deleteCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeCalId(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  )
  if (!res.ok && res.status !== 410) {  // 410 = already deleted
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    const text = await res.text().catch(() => '')
    throw new Error(`Delete event error ${res.status}: ${text}`)
  }
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * Google Calendar API calendarId 인코딩 규칙:
 * - "primary" → 그대로
 * - "user@gmail.com" → 그대로 (이메일은 URL 경로에 raw로 전달)
 * - "abc@group.calendar.google.com" → encodeURIComponent 필요
 */
function encodeCalId(id: string): string {
  return id.includes('@group.calendar.google.com') ? encodeURIComponent(id) : id
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

/** 시작/끝의 기기 시간대 시·분 (표시용). 여러 날에 걸치면 eventSegmentForDay 를 쓴다. */
export function eventToTimeRange(event: GoogleCalendarEvent): {
  startHour: number; startMinute: number
  endHour: number;   endMinute: number
  allDay: boolean
} {
  const iv = eventInterval(event)
  if (!iv) {
    return { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, allDay: true }
  }
  return {
    startHour:   iv.start.getHours(),
    startMinute: iv.start.getMinutes(),
    endHour:     iv.end.getHours(),
    endMinute:   iv.end.getMinutes(),
    allDay:      false,
  }
}
