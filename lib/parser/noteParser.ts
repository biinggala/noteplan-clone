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

// #태그, @멘션 — 가-힣 가-힣, ㄱ-ㅎ ㄱ-ㅎ, ㅏ-ㅣ ㅏ-ㅣ
//
// 시길(#, @)은 줄 맨 앞이거나 공백·여는 괄호/따옴표 뒤에 있어야 한다 — 자동완성
// 트리거(tagMentionComplete)와 같은 규칙. `foo#bar`, `C#x`, `a@b` 같은 건
// 태그가 아니다. 제목(`# 제목`)은 # 뒤가 공백이라 원래 매칭되지 않는다.
const KO = '가-힣ㄱ-ㅎㅏ-ㅣ'
const SIGIL_BEFORE = `(?<![^\\s(\\[{"'])`
const TAG_PATTERN = new RegExp(`${SIGIL_BEFORE}#([\\w${KO}/]+)`, 'g')
const MENTION_PATTERN = new RegExp(`${SIGIL_BEFORE}@([\\w${KO}/]+)`, 'g')

// #fff, #1e90ff 같은 CSS 색상 — 숫자가 섞였거나, 6/8자리이거나, 한 글자 반복(#eee)인
// 16진수만 색상으로 본다. #add, #cafe, #face 같은 영단어 태그는 살린다.
const HEX_COLOR = /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
function isHexColor(v: string): boolean {
  if (!HEX_COLOR.test(v)) return false
  return /\d/.test(v) || v.length >= 6 || /^(.)\1+$/i.test(v)
}

/** 태그/멘션 값으로 인정하는지 — 숫자뿐(#123)이거나 색상(#fff)이면 아니다 */
export function isFacetValue(v: string, kind: 'tag' | 'mention'): boolean {
  if (!/[^\d/]/.test(v)) return false
  if (kind === 'tag' && isHexColor(v)) return false
  return true
}

export interface FacetMatch {
  kind: 'tag' | 'mention'
  value: string   // 시길 뺀 값
  index: number   // 시길 위치 (text 기준)
  length: number  // 시길 포함 길이
}

/**
 * 이미 마스킹된 텍스트(maskLinks/maskCode)에서 #태그·@멘션을 찾는다.
 * 에디터 하이라이트와 색인이 같은 규칙을 쓰도록 여기 하나만 둔다.
 */
export function matchFacets(masked: string): FacetMatch[] {
  const out: FacetMatch[] = []
  for (const [re, kind] of [[TAG_PATTERN, 'tag'], [MENTION_PATTERN, 'mention']] as const) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      if (isFacetValue(m[1], kind)) out.push({ kind, value: m[1], index: m.index, length: m[0].length })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

// [[백링크]]
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g

// 링크/URL/이메일 영역 — 이 안의 #, @ 는 태그·멘션이 아니다.
// 마크다운 링크/이미지 `[text](url)`, raw URL, 이메일 주소를 모두 포함.
const LINK_MASK_PATTERN = new RegExp(
  [
    // 마크다운 링크/이미지. 링크 텍스트에 '['·줄바꿈을 허용하지 않는다 — 허용하면
    // 닫히지 않은 '['가 많은 줄에서 시작점마다 끝까지 훑어 O(n²)이 된다.
    '!?\\[[^\\][\\n]*\\]\\([^)\\n]*\\)',
    '(?:https?:\\/\\/|www\\.)[^\\s)]+',           // raw URL
    // 이메일 — 로컬 파트 시작을 lookbehind로 고정한다. 없으면 긴 토큰(공백 없는
    // 4만 자)에서 모든 시작점마다 끝까지 훑어 O(n²)이 된다 (1.4초).
    '(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
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

const blank = (s: string) => s.replace(/[^\n]/g, ' ')

/** 한 줄 안의 인라인 코드(`...`, ``...``)를 공백으로 (길이 보존) */
function maskInlineCode(line: string): string {
  if (!line.includes('`')) return line
  // 백틱 덩어리들을 모은 뒤, 같은 길이의 다음 덩어리와 짝짓는다 (CommonMark 코드 스팬)
  const runs: { pos: number; len: number }[] = []
  for (let i = 0; i < line.length;) {
    if (line[i] !== '`') { i++; continue }
    let j = i
    while (j < line.length && line[j] === '`') j++
    runs.push({ pos: i, len: j - i })
    i = j
  }
  // nextSame[k] = k 뒤에서 같은 길이를 가진 첫 덩어리 (선형)
  const nextSame = new Array<number>(runs.length).fill(-1)
  const seen = new Map<number, number>()
  for (let k = runs.length - 1; k >= 0; k--) {
    nextSame[k] = seen.get(runs[k].len) ?? -1
    seen.set(runs[k].len, k)
  }
  let out = ''
  let last = 0
  for (let k = 0; k < runs.length;) {
    const close = nextSame[k]
    if (close < 0) { k++; continue }
    const from = runs[k].pos, to = runs[close].pos + runs[close].len
    out += line.slice(last, from) + ' '.repeat(to - from)
    last = to
    k = close + 1
  }
  return out + line.slice(last)
}

/**
 * 코드 블록(``` / ~~~ 펜스, 들여쓰기 0~3칸)과 인라인 코드를 같은 길이의 공백으로
 * 바꾼다. 코드 안의 `#include`, `#fff` 같은 건 태그·멘션이 아니다.
 * 닫히지 않은 펜스는 문서 끝까지 코드다 (CommonMark와 동일).
 */
export function maskCode(text: string): string {
  if (!text.includes('`') && !text.includes('~~~')) return text
  const lines = text.split('\n')
  let fence: { ch: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !line.slice(m[0].length).trim()) fence = null
      lines[i] = blank(line)
      continue
    }
    if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length }
      lines[i] = blank(line)
      continue
    }
    lines[i] = maskInlineCode(line)
  }
  return lines.join('\n')
}

/** 태그·멘션 추출용 마스킹: 코드 + 링크/URL/이메일 */
export function maskForFacets(text: string): string {
  return maskLinks(maskCode(text))
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
        const facets = matchFacets(maskForFacets(taskContent))
        const tags = facets.filter(f => f.kind === 'tag').map(f => f.value)
        const mentions = facets.filter(f => f.kind === 'mention').map(f => f.value)

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

function extractFacets(content: string, kind: 'tag' | 'mention'): string[] {
  const values = matchFacets(maskForFacets(content)).filter(f => f.kind === kind).map(f => normalizeKey(f.value))
  return [...new Set(values)]
}

export function extractTags(content: string): string[] {
  return extractFacets(content, 'tag')
}

export function extractMentions(content: string): string[] {
  return extractFacets(content, 'mention')
}

export function extractBacklinks(content: string): string[] {
  return [...new Set([...content.matchAll(WIKILINK_PATTERN)].map(m => normalizeKey(m[1].trim())))]
}

/**
 * `supersedes:: [[옛 노트]]` — 이 노트가 저 노트를 갈아치웠다는 선언.
 *
 * 노트의 시효성을 프로즈가 아니라 데이터로 만들기 위한 유일한 링크 타입이다.
 * 이게 있으면 "6월에 쓴 방향성 노트"를 지금도 유효한 근거로 인용하는 사고를
 * 구조적으로 막을 수 있다.
 *
 * 줄 맨 앞(들여쓰기 허용)에 와야 하고 한 줄에 여러 개 써도 된다.
 * `::` 는 Dataview 관례 — 마크다운 렌더링과 충돌하지 않고(>는 인용구가 됨)
 * 평문으로 읽어도 뜻이 통한다.
 */
const SUPERSEDES_LINE = /^[ \t]*supersedes::[ \t]*(.+)$/gim

export function extractSupersedes(content: string): string[] {
  const out: string[] = []
  SUPERSEDES_LINE.lastIndex = 0
  let line: RegExpExecArray | null
  while ((line = SUPERSEDES_LINE.exec(content))) {
    for (const m of line[1].matchAll(/\[\[([^\]]+)\]\]/g)) {
      out.push(normalizeKey(m[1].trim()))
    }
  }
  return [...new Set(out)]
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
