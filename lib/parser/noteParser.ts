import type { Task, TaskStatus } from '@/types/task'
import { v4 as uuidv4 } from 'uuid'

// Task 마커
const TASK_PATTERNS = {
  open: /^(\s*)-\s\[ \]\s(.+)$/,
  done: /^(\s*)-\s\[x\]\s(.+)$/i,
  cancelled: /^(\s*)-\s\[-\]\s(.+)$/,
  scheduled: /^(\s*)-\s\[>\]\s(.+)$/,
}

// >YYYY-MM-DD 또는 >tomorrow 등 파싱
const SCHEDULE_DATE_PATTERN = />((\d{4}-\d{2}-\d{2})|tomorrow|today|yesterday)/gi

// #태그, @멘션 — \uAC00-\uD7A3 가-힣, \u3131-\u314E ㄱ-ㅎ, \u314F-\u3163 ㅏ-ㅣ
const KO = '\uAC00-\uD7A3\u3131-\u314E\u314F-\u3163'
const TAG_PATTERN = new RegExp(`#([\\w${KO}/]+)`, 'g')
const MENTION_PATTERN = new RegExp(`@([\\w${KO}/]+)`, 'g')

// [[백링크]]
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g

// 링크/URL/이메일 영역 — 이 안의 #, @ 는 태그·멘션이 아니다.
// 마크다운 링크/이미지 `[text](url)`, raw URL, 이메일 주소를 모두 포함.
const LINK_MASK_PATTERN = new RegExp(
  [
    '!?\\[[^\\]]*\\]\\([^)]*\\)',                 // 마크다운 링크/이미지
    '(?:https?:\\/\\/|www\\.)[^\\s)]+',           // raw URL
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', // 이메일
  ].join('|'),
  'g'
)

/**
 * 링크/URL/이메일 영역을 같은 길이의 공백으로 치환한다.
 * 길이를 보존하므로 마스킹 후에도 문자 오프셋이 그대로라 에디터 하이라이트에서도 재사용 가능.
 */
export function maskLinks(text: string): string {
  return text.replace(LINK_MASK_PATTERN, m => ' '.repeat(m.length))
}

export function parseTasks(content: string, noteId: string): Task[] {
  const lines = content.split('\n')
  const tasks: Task[] = []

  lines.forEach((line, lineNumber) => {
    for (const [statusKey, pattern] of Object.entries(TASK_PATTERNS)) {
      const match = line.match(pattern)
      if (match) {
        const indent = match[1] ?? ''
        const taskContent = match[2]

        const scheduledMatch = taskContent.match(SCHEDULE_DATE_PATTERN)
        const masked = maskLinks(taskContent)
        const tags = [...masked.matchAll(TAG_PATTERN)].map(m => m[1])
        const mentions = [...masked.matchAll(MENTION_PATTERN)].map(m => m[1])

        tasks.push({
          id: uuidv4(),
          noteId,
          content: taskContent,
          status: statusKey as TaskStatus,
          scheduledDate: scheduledMatch?.[0]?.replace('>', ''),
          tags,
          mentions,
          lineNumber,
          indentLevel: indent.length,
        })
        break
      }
    }
  })

  return tasks
}

export function extractTags(content: string): string[] {
  return [...new Set([...maskLinks(content).matchAll(TAG_PATTERN)].map(m => m[1]))]
}

export function extractMentions(content: string): string[] {
  return [...new Set([...maskLinks(content).matchAll(MENTION_PATTERN)].map(m => m[1]))]
}

export function extractBacklinks(content: string): string[] {
  return [...new Set([...content.matchAll(WIKILINK_PATTERN)].map(m => m[1]))]
}

export function toggleTaskStatus(
  content: string,
  lineNumber: number,
  currentStatus: TaskStatus
): string {
  const lines = content.split('\n')
  const line = lines[lineNumber]
  if (!line) return content

  let newLine = line
  if (currentStatus === 'open') {
    newLine = line.replace('- [ ]', '- [x]')
  } else if (currentStatus === 'done') {
    newLine = line.replace('- [x]', '- [ ]').replace('- [X]', '- [ ]')
  }

  lines[lineNumber] = newLine
  return lines.join('\n')
}
