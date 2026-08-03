import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { format } from 'date-fns'

/**
 * `/` 를 치면 마크다운 요소를 골라 넣는 삽입 메뉴 (Notion / NotePlan 방식).
 *
 * - `block: true` 인 항목은 줄 맨 앞에 와야 의미가 있다. 줄 중간에서 고르면
 *   앞에 줄바꿈을 하나 넣어 새 줄에서 시작하게 한다.
 * - `cursor` 는 삽입한 텍스트 안에서 커서가 놓일 오프셋(기본: 맨 끝).
 */
interface SlashItem {
  label: string
  keywords: string       // 검색어 (영문 별칭 포함 — "표"도 "table"도 잡히게)
  detail: string         // 우측에 보여줄 문법 미리보기
  insert: string | (() => string)
  cursor?: number
  block?: boolean
}

const TABLE_SKELETON =
  '| 제목 | 제목 |\n| --- | --- |\n|  |  |'

const ITEMS: SlashItem[] = [
  // ── 할 일 ──
  // 완료/취소/미룸 상태는 넣지 않는다. 생성은 '할 일'로만 하고 상태는 만든 뒤
  // 체크박스를 눌러 바꾼다. (취소·미룸은 아직 클릭 토글이 없어서 넣어두면
  // 되돌릴 방법이 없는 상태가 됨)
  { label: '할 일',      keywords: 'todo task 할일 태스크 체크', detail: '- [ ]', insert: '- [ ] ', block: true },
  { label: '체크리스트',  keywords: 'checklist 체크리스트',        detail: '+',     insert: '+ ',     block: true },

  // ── 제목 ──
  { label: '제목 1', keywords: 'heading h1 제목 title', detail: '#',   insert: '# ',   block: true },
  { label: '제목 2', keywords: 'heading h2 제목',       detail: '##',  insert: '## ',  block: true },
  { label: '제목 3', keywords: 'heading h3 제목',       detail: '###', insert: '### ', block: true },

  // ── 목록 ──
  { label: '글머리 기호', keywords: 'bullet list 불릿 목록',     detail: '-',  insert: '- ',  block: true },
  { label: '번호 목록',   keywords: 'number ordered 번호 목록',  detail: '1.', insert: '1. ', block: true },
  { label: '인용',        keywords: 'quote blockquote 인용',     detail: '>',  insert: '> ',  block: true },

  // ── 블록 ──
  {
    label: '표', keywords: 'table 표 테이블', detail: '| … |',
    insert: TABLE_SKELETON, cursor: 2, block: true,   // 첫 셀 '제목'의 시작 위치
  },
  {
    label: '코드 블록', keywords: 'code 코드 블록', detail: '```',
    insert: '```\n\n```', cursor: 4, block: true,
  },
  { label: '구분선', keywords: 'divider separator hr 구분선 라인', detail: '---', insert: '---\n', block: true },

  // ── 인라인 ──
  // 태그(#)·멘션(@)은 넣지 않는다 — 한 글자라 직접 치는 게 더 빠르고,
  // 이미 각자의 자동완성이 붙어 있음
  { label: '노트 링크', keywords: 'link wikilink 링크 노트',  detail: '[[ ]]', insert: '[[]]', cursor: 2 },
  {
    label: '오늘 날짜', keywords: 'date today 오늘 날짜',
    detail: format(new Date(), 'yyyy-MM-dd'),
    insert: () => format(new Date(), 'yyyy-MM-dd'),
  },
  {
    label: '예정일', keywords: 'schedule due 예정일 마감',
    detail: '>YYYY-MM-DD',
    insert: () => `>${format(new Date(), 'yyyy-MM-dd')}`,
  },
  {
    label: '시간 블록', keywords: 'time block 시간 타임블록 일정',
    detail: '9:00 AM - 10:00 AM',
    insert: '9:00 AM - 10:00 AM ', block: true,
  },
]

export function slashInsertSource(): CompletionSource {
  return function source(ctx: CompletionContext): CompletionResult | null {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)

    // 줄 시작이나 공백 뒤의 '/' 만 트리거. 뒤따르는 글자에 공백/슬래시는 불가
    // → "http://" 나 "a/b" 같은 경로에서는 안 뜬다.
    const m = /(?:^|\s)\/([^\s/]*)$/.exec(before)
    if (!m) return null
    const typed = m[1].toLowerCase()

    const slashPos = line.from + before.length - typed.length - 1
    // '/' 앞에 실제 글자가 있는지 (블록 요소면 줄바꿈을 넣어야 함)
    const hasTextBefore = before.slice(0, before.length - typed.length - 1).trim().length > 0

    const options = ITEMS
      .filter(it => !typed
        || it.label.toLowerCase().includes(typed)
        || it.keywords.toLowerCase().includes(typed))
      .map(it => ({
        label: it.label,
        detail: it.detail,
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          const raw = typeof it.insert === 'function' ? it.insert() : it.insert
          const prefix = it.block && hasTextBefore ? '\n' : ''
          const text = prefix + raw
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + prefix.length + (it.cursor ?? raw.length) },
            scrollIntoView: true,
          })
        },
      }))

    if (!options.length) return null
    return {
      from: slashPos,
      to: ctx.pos,
      options,
      filter: false,   // 위에서 한글/영문 별칭까지 직접 필터링함
    }
  }
}
