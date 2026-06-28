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

export interface GoogleCalendarEvent {
  id: string
  calendarId: string        // 어느 캘린더 소속인지
  calendarColor: string     // 캘린더 색상 (상속)
  summary: string
  description?: string
  colorId?: string
  start: { dateTime?: string; date?: string }
  end:   { dateTime?: string; date?: string }
  htmlLink: string
}

// ── 캘린더 목록 fetch ─────────────────────────────────────────────────────────

export async function fetchCalendarList(accessToken: string): Promise<GoogleCalendar[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) {
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    throw new Error(`CalendarList API error: ${res.status}`)
  }
  const data = await res.json()
  return (data.items ?? []) as GoogleCalendar[]
}

// ── 이벤트 fetch (단일 캘린더) ────────────────────────────────────────────────

export async function fetchCalendarEvents(
  accessToken: string,
  calendarId: string,
  calendarColor: string,
  date: string,             // 'YYYY-MM-DD'
): Promise<GoogleCalendarEvent[]> {
  const timeMin = new Date(`${date}T00:00:00`).toISOString()
  const timeMax = new Date(`${date}T23:59:59`).toISOString()

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  )
  url.searchParams.set('timeMin', timeMin)
  url.searchParams.set('timeMax', timeMax)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '50')

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    throw new Error(`Calendar API error: ${res.status}`)
  }

  const data = await res.json()
  return ((data.items ?? []) as Record<string, unknown>[]).map(item => ({
    ...(item as object),
    calendarId,
    calendarColor,
  })) as GoogleCalendarEvent[]
}

// ── 날짜 범위 이벤트 fetch (단일 캘린더) ─────────────────────────────────────

export async function fetchCalendarEventsForRange(
  accessToken: string,
  calendarId: string,
  calendarColor: string,
  startDate: string,   // 'YYYY-MM-DD'
  endDate: string,     // 'YYYY-MM-DD' (inclusive)
): Promise<GoogleCalendarEvent[]> {
  const timeMin = new Date(`${startDate}T00:00:00`).toISOString()
  const timeMax = new Date(`${endDate}T23:59:59`).toISOString()

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  )
  url.searchParams.set('timeMin', timeMin)
  url.searchParams.set('timeMax', timeMax)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '500')

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    if (res.status === 401) throw new Error('GOOGLE_TOKEN_EXPIRED')
    throw new Error(`Calendar API error: ${res.status}`)
  }
  const data = await res.json()
  return ((data.items ?? []) as Record<string, unknown>[]).map(item => ({
    ...(item as object),
    calendarId,
    calendarColor,
  })) as GoogleCalendarEvent[]
}

// ── 날짜 범위 이벤트 fetch (모든 활성 캘린더) → 날짜별로 그룹화 ──────────────

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
  const allEvents = results
    .filter((r): r is PromiseFulfilledResult<GoogleCalendarEvent[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  // 날짜별 그룹화 (start.date 또는 start.dateTime의 날짜 부분 사용)
  const grouped: Record<string, GoogleCalendarEvent[]> = {}
  for (const ev of allEvents) {
    const d = ev.start.date ?? ev.start.dateTime?.split('T')[0]
    if (!d) continue
    if (!grouped[d]) grouped[d] = []
    grouped[d].push(ev)
  }
  return grouped
}

// ── 활성화된 모든 캘린더에서 이벤트 fetch ────────────────────────────────────

export async function fetchAllCalendarEvents(
  accessToken: string,
  calendars: GoogleCalendar[],
  enabledIds: Set<string>,
  date: string,
): Promise<GoogleCalendarEvent[]> {
  const active = calendars.filter(c => enabledIds.has(c.id))
  const results = await Promise.allSettled(
    active.map(c => fetchCalendarEvents(accessToken, c.id, c.backgroundColor, date))
  )
  return results
    .filter((r): r is PromiseFulfilledResult<GoogleCalendarEvent[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
}

// ── 이벤트 생성 ───────────────────────────────────────────────────────────────

export interface CreateEventPayload {
  calendarId: string
  summary: string
  description?: string
  startDateTime: string   // ISO 8601, e.g. "2026-04-26T09:00:00"
  endDateTime:   string
  timeZone?:     string
}

export async function createCalendarEvent(
  accessToken: string,
  payload: CreateEventPayload,
): Promise<GoogleCalendarEvent & { calendarId: string; calendarColor: string }> {
  const tz = payload.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const body = {
    summary: payload.summary,
    description: payload.description,
    start: { dateTime: payload.startDateTime, timeZone: tz },
    end:   { dateTime: payload.endDateTime,   timeZone: tz },
  }
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
  const next = new Date(`${payload.date}T00:00:00`)
  next.setDate(next.getDate() + 1)
  const endDate = next.toISOString().slice(0, 10)
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

// ── 이벤트 수정 (시간 변경) ───────────────────────────────────────────────────

export async function updateCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  patch: {
    startDateTime?: string
    endDateTime?:   string
    summary?:       string
    timeZone?:      string
  },
): Promise<void> {
  const tz = patch.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const body: Record<string, unknown> = {}
  if (patch.summary) body.summary = patch.summary
  if (patch.startDateTime) body.start = { dateTime: patch.startDateTime, timeZone: tz }
  if (patch.endDateTime)   body.end   = { dateTime: patch.endDateTime,   timeZone: tz }

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
    throw new Error(`Delete event error ${res.status}`)
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

export function eventToTimeRange(event: GoogleCalendarEvent): {
  startHour: number; startMinute: number
  endHour: number;   endMinute: number
  allDay: boolean
} {
  if (event.start.date && !event.start.dateTime) {
    return { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, allDay: true }
  }
  const start = new Date(event.start.dateTime!)
  const end   = new Date(event.end.dateTime!)
  return {
    startHour:   start.getHours(),
    startMinute: start.getMinutes(),
    endHour:     end.getHours(),
    endMinute:   end.getMinutes(),
    allDay:      false,
  }
}
