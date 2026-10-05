/**
 * 노트의 '## Tasks' 목록 끝에 할 일 한 줄을 넣는다 (없으면 노트 끝에).
 * 데일리 템플릿은 '## Tasks' 아래에 할 일을 모으므로 같은 자리에 붙인다.
 */
export function insertUnderTasks(content: string, line: string): string {
  const lines = content.split('\n')
  const h = lines.findIndex(l => /^##\s+Tasks\s*$/i.test(l))
  if (h < 0) return `${content.replace(/\s+$/, '')}\n${line}\n`
  // ## Tasks 아래, 다음 머리말 앞의 마지막 내용 줄 다음
  let at = h + 1
  while (at < lines.length && !/^#{1,6}\s/.test(lines[at])) at++
  while (at > h + 1 && lines[at - 1].trim() === '') at--
  lines.splice(at, 0, line)
  return lines.join('\n')
}

/** 타임라인에서 만든 할 일을 열린 데일리 노트에 넣어 달라는 요청 (window 이벤트) */
export interface AppendTaskDetail { date: string; line: string; handled: boolean }
export const APPEND_TASK_EVENT = 'np:append-task'
