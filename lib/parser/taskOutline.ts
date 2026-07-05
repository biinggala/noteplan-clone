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

/** components/editor/extensions/taskCheckbox.ts의 getTaskType과 동일한 규칙 */
function classify(text: string): { type: TaskOutlineType; rest: string } | null {
  let m
  if ((m = text.match(/^\s*(- \[ \])\s(.*)$/))) return { type: 'open', rest: m[2] }
  if ((m = text.match(/^\s*(- \[x\])\s(.*)$/i))) return { type: 'done', rest: m[2] }
  if ((m = text.match(/^\s*(- \[-\])\s(.*)$/))) return { type: 'cancelled', rest: m[2] }
  if ((m = text.match(/^\s*(- \[>\])\s(.*)$/))) return { type: 'scheduled', rest: m[2] }
  if ((m = text.match(/^\s*(\* )(\S.*)$/))) return { type: 'open', rest: m[2] }
  if ((m = text.match(/^\s*(\+ \[x\])\s(.*)$/i))) return { type: 'checklist-done', rest: m[2] }
  if ((m = text.match(/^\s*(\+ )(\S.*)$/))) return { type: 'checklist', rest: m[2] }
  return null
}

/** components/editor/extensions/taskCheckbox.ts의 클릭 토글 규칙과 동일. 토글 불가(cancelled/scheduled)면 null */
export function toggleTaskLine(raw: string, type: TaskOutlineType): string | null {
  if (type === 'done') return raw.replace(/- \[x\]/i, '- [ ]')
  if (type === 'open') return raw.replace('- [ ]', '- [x]').replace(/^(\s*)\* /, '$1- [x] ')
  if (type === 'checklist') return raw.replace(/^(\s*)\+ /, '$1+ [x] ')
  if (type === 'checklist-done') return raw.replace(/^(\s*)\+ \[x\] /i, '$1+ ')
  return null
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
    const task = classify(line)
    if (task) current.tasks.push({ raw: line, type: task.type, text: task.rest.trim() })
  }

  return sections.filter(s => s.tasks.length > 0)
}
