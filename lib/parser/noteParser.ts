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

/**
 * 한글 유니코드 정규화(NFC).
 * macOS 파일명은 자모 분해형(NFD)이라 "비주얼"이 눈엔 같아도 바이트가 달라
 * 제목 매칭이 실패한다. 태그/멘션/백링크는 전부 매칭 키로 쓰이므로 NFC로 통일한다.
 */
export function normalizeKey(s: string): string {
  return s.normalize('NFC')
}

export function extractTags(content: string): string[] {
  return [...new Set([...maskLinks(content).matchAll(TAG_PATTERN)].map(m => normalizeKey(m[1])))]
}

export function extractMentions(content: string): string[] {
  return [...new Set([...maskLinks(content).matchAll(MENTION_PATTERN)].map(m => normalizeKey(m[1])))]
}

export function extractBacklinks(content: string): string[] {
  return [...new Set([...content.matchAll(WIKILINK_PATTERN)].map(m => normalizeKey(m[1].trim())))]
}

/**
 * 본문의 [[옛 제목]]을 [[새 제목]]으로 바꾼다 (노트 이름 변경 시 링크 따라가기).
 * 대소문자·앞뒤 공백·한글 NFC/NFD 차이는 무시하고 매칭한다.
 */
export function renameWikiLinks(content: string, from: string, to: string): string {
  const want = normalizeKey(from).trim().toLowerCase()
  if (!want) return content
  // WIKILINK_PATTERN은 /g라 lastIndex를 공유한다 — 여기선 새로 만들어 쓴다
  return content.replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) =>
    normalizeKey(inner).trim().toLowerCase() === want ? `[[${to}]]` : whole)
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
