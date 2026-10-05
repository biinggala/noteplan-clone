export type TaskOutlineType = 'open' | 'done' | 'cancelled' | 'scheduled' | 'checklist' | 'checklist-done'

export interface TaskOutlineTask {
  raw: string   // 원본 라인 (find/replace 매칭용)
  type: TaskOutlineType
  text: string  // 마커 뗀 표시용 텍스트
}

export interface TaskOutlineSection {
  header: string
  level: number
  tasks: TaskOutlineTask[]
}

// 타임블록 접두사: 줄 맨 앞의 "2:30 PM - 3:00 PM "
const TIME_PREFIX_RE = /^\d{1,2}:\d{2}\s*(?:AM|PM)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s+/i

/** 줄 맨 앞의 타임블록 접두사를 떼어 낸다 ("9:00 AM - 10:00 AM * 회의" → "* 회의") */
export function splitTimePrefix(line: string): { prefix: string; text: string } {
  const m = TIME_PREFIX_RE.exec(line)
  return m ? { prefix: m[0], text: line.slice(m[0].length) } : { prefix: '', text: line }
}

/**
 * 태스크 줄 판별 — 에디터 체크박스(taskCheckbox.ts)와 요약 패널이 함께 쓰는
 * 단 하나의 규칙. 타임블록 접두사가 있어도 태스크로 본다.
 */
export function classifyTaskLine(line: string): { type: TaskOutlineType; rest: string; prefix: string } | null {
  const { prefix, text } = splitTimePrefix(line)
  let m
  if ((m = text.match(/^\s*(- \[ \])\s(.*)$/))) return { type: 'open', rest: m[2], prefix }
  if ((m = text.match(/^\s*(- \[x\])\s(.*)$/i))) return { type: 'done', rest: m[2], prefix }
  if ((m = text.match(/^\s*(- \[-\])\s(.*)$/))) return { type: 'cancelled', rest: m[2], prefix }
  if ((m = text.match(/^\s*(- \[>\])\s(.*)$/))) return { type: 'scheduled', rest: m[2], prefix }
  if ((m = text.match(/^\s*(\* )(\S.*)$/))) return { type: 'open', rest: m[2], prefix }
  if ((m = text.match(/^\s*(\+ \[x\])\s(.*)$/i))) return { type: 'checklist-done', rest: m[2], prefix }
  if ((m = text.match(/^\s*(\+ )(\S.*)$/))) return { type: 'checklist', rest: m[2], prefix }
  return null
}

/** 클릭 토글 규칙 (에디터 체크박스·요약 패널 공통). 토글 불가(cancelled/scheduled)면 null */
export function toggleTaskLine(raw: string, type: TaskOutlineType): string | null {
  // 타임블록 접두사 뒤의 마커만 바꾼다 — 접두사째 ^ 로 매칭하면 "9:00 AM - … * 할일"
  // 같은 줄에서 아무것도 안 바뀐다.
  const { prefix, text } = splitTimePrefix(raw)
  let next: string
  if (type === 'done') next = text.replace(/^(\s*)- \[x\]/i, '$1- [ ]')
  else if (type === 'open') next = text.replace(/^(\s*)- \[ \]/, '$1- [x]').replace(/^(\s*)\* /, '$1- [x] ')
  else if (type === 'checklist') next = text.replace(/^(\s*)\+ (?:\[ \] )?/, '$1+ [x] ')
  else if (type === 'checklist-done') next = text.replace(/^(\s*)\+ \[x\] /i, '$1+ ')
  else return null
  return prefix + next
}

/** 노트 본문에서 task가 있는 헤더 섹션만 뽑아 목차 형태로 정리 (task가 없는 헤더/일반 불릿은 제외) */
export function parseTaskOutline(content: string): TaskOutlineSection[] {
  const lines = content.split('\n')
  const sections: TaskOutlineSection[] = []
  let current: TaskOutlineSection | null = null

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headerMatch) {
      current = { header: headerMatch[2].trim(), level: headerMatch[1].length, tasks: [] }
      sections.push(current)
      continue
    }
    if (!current) continue
    const task = classifyTaskLine(line)
    if (task) current.tasks.push({ raw: line, type: task.type, text: (task.prefix + task.rest).trim() })
  }

  return sections.filter(s => s.tasks.length > 0)
}
