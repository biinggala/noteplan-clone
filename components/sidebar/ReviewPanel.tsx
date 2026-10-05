'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format, parseISO, subDays, differenceInCalendarDays } from 'date-fns'
import { getNoteSummariesByDateRange, getOrCreateDailyNote, updateNoteContentSafely } from '@/lib/db/noteRepository'
import { useCalendarStore } from '@/lib/stores/calendarStore'

/**
 * Review — 지난 30일 데일리 노트에 남아 있는 '안 끝낸 할 일'을 한곳에 모은다.
 * (예전엔 '기한 지난 Task' 라는 제목만 있고 비어 있었다)
 *
 *  - 체크: 그 날 노트에서 완료 처리
 *  - →   : 오늘로 옮기기 — 원래 줄은 NotePlan 규칙대로 '[>] … >오늘' 로 표시하고,
 *          오늘 노트의 할 일 목록에 같은 할 일을 새로 넣는다
 */
interface OpenTask { date: string; raw: string; text: string }

const OPEN_RE = /^(\s*)(?:- \[ \]|\*) (?!\[)(.*\S.*)$/
const DAYS = 30

function collect(rows: Array<{ date: string; content: string }>, today: string): OpenTask[] {
  const out: OpenTask[] = []
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date >= today) continue
    for (const line of (r.content ?? '').split('\n')) {
      const m = line.match(OPEN_RE)
      if (m) out.push({ date: r.date, raw: line, text: m[2].trim() })
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date))
}

export default function ReviewPanel() {
  const router = useRouter()
  const { today } = useCalendarStore()
  const [tasks, setTasks] = useState<OpenTask[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const start = format(subDays(parseISO(today), DAYS), 'yyyy-MM-dd')
    const end = format(subDays(parseISO(today), 1), 'yyyy-MM-dd')
    const rows = await getNoteSummariesByDateRange(start, end)
    setTasks(collect(rows, today))
  }, [today])

  useEffect(() => { void load() }, [load])

  const editLine = async (t: OpenTask, replace: (raw: string) => string) => {
    const day = await getOrCreateDailyNote(t.date)
    await updateNoteContentSafely(day.id, c => {
      const lines = c.split('\n')
      const i = lines.indexOf(t.raw)
      if (i < 0) return null
      lines[i] = replace(t.raw)
      return lines.join('\n')
    })
  }

  const done = async (t: OpenTask) => {
    setBusy(t.date + t.raw)
    try {
      await editLine(t, raw => raw.replace(/^(\s*)(?:- \[ \]|\*) /, '$1- [x] '))
      setTasks(prev => prev?.filter(x => x !== t) ?? null)
    } finally { setBusy(null) }
  }

  const moveToToday = async (t: OpenTask) => {
    setBusy(t.date + t.raw)
    try {
      await editLine(t, raw => `${raw.replace(/^(\s*)(?:- \[ \]|\*) /, '$1- [>] ')} >${today}`)
      const todayNote = await getOrCreateDailyNote(today)
      await updateNoteContentSafely(todayNote.id, c => {
        const lines = c.split('\n')
        const h = lines.findIndex(l => /^##\s+Tasks\s*$/i.test(l))
        const item = `- [ ] ${t.text}`
        if (h < 0) return `${c.replace(/\s+$/, '')}\n${item}\n`
        // ## Tasks 아래, 다음 머리말 앞의 마지막 줄 다음에 넣는다
        let at = h + 1
        while (at < lines.length && !/^#{1,6}\s/.test(lines[at])) at++
        while (at > h + 1 && lines[at - 1].trim() === '') at--
        lines.splice(at, 0, item)
        return lines.join('\n')
      })
      setTasks(prev => prev?.filter(x => x !== t) ?? null)
    } finally { setBusy(null) }
  }

  if (tasks === null) {
    return <div className="px-3 py-2 text-xs text-[var(--text-muted)]">불러오는 중…</div>
  }
  if (tasks.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)] leading-relaxed">
        지난 {DAYS}일 동안 남은 할 일이 없습니다.<br />깔끔하네요.
      </div>
    )
  }

  // 날짜별로 묶기
  const groups: Array<{ date: string; items: OpenTask[] }> = []
  for (const t of tasks) {
    const g = groups[groups.length - 1]
    if (g && g.date === t.date) g.items.push(t)
    else groups.push({ date: t.date, items: [t] })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto px-1 pb-2">
      <div className="px-2 pb-1 text-[11px] text-[var(--text-muted)]">
        지난 {DAYS}일 · 남은 할 일 {tasks.length}개
      </div>
      {groups.map(g => {
        const ago = differenceInCalendarDays(parseISO(today), parseISO(g.date))
        return (
          <div key={g.date} className="mt-1.5">
            <button
              onClick={() => router.push(`/daily?date=${g.date}`)}
              className="w-full text-left px-2 py-0.5 text-[11px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] tabular"
            >
              {ago === 1 ? '어제' : `${ago}일 전`} · {format(parseISO(g.date), 'M/d EEE')}
            </button>
            {g.items.map((t, i) => {
              const key = t.date + t.raw
              return (
                <div key={key + i} className={`group flex items-start gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--hover-bg)] ${busy === key ? 'opacity-50' : ''}`}>
                  <button
                    role="checkbox" aria-checked={false} aria-label={`완료: ${t.text}`}
                    onClick={() => void done(t)} disabled={busy === key}
                    className="mt-[3px] w-3.5 h-3.5 flex-shrink-0 rounded-full border border-[var(--text-muted)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  />
                  <button
                    onClick={() => router.push(`/daily?date=${t.date}`)}
                    className="flex-1 min-w-0 text-left text-[13px] leading-snug text-[var(--text-secondary)] hover:text-[var(--text-primary)] break-words"
                  >
                    {t.text}
                  </button>
                  <button
                    onClick={() => void moveToToday(t)} disabled={busy === key}
                    title="오늘로 옮기기" aria-label={`오늘로 옮기기: ${t.text}`}
                    className="md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  >
                    → 오늘
                  </button>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
