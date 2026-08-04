import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { LinkTarget } from '@/lib/db/noteRepository'
import { rankLinkTargets } from '@/lib/parser/linkRanking'

const TYPE_LABEL: Record<string, string> = {
  daily: '데일리', weekly: '주간', monthly: '월간', yearly: '연간', project: '노트',
}

/**
 * `[[` 입력 시 노트 제목 자동완성 소스.
 * getTargets는 최신 목록을 돌려주는 함수(에디터 생성 시점에 고정되지 않도록 ref 패턴).
 *
 * autocompletion() 자체는 NoteEditor에서 한 번만 등록한다 — 여러 번 등록하면
 * 서로 다른 설정이 충돌해 한쪽 소스가 죽는다.
 */
export function wikiLinkCompletionSource(getTargets: () => LinkTarget[]): CompletionSource {
  return function source(ctx: CompletionContext): CompletionResult | null {
    // 커서 앞에서 "[[" 이후 아직 "]]"로 닫히지 않은 부분을 잡는다
    const before = ctx.state.doc.sliceString(ctx.state.doc.lineAt(ctx.pos).from, ctx.pos)
    const open = before.lastIndexOf('[[')
    if (open === -1) return null
    const typed = before.slice(open + 2)
    if (typed.includes(']')) return null           // 이미 닫힌 링크
    if (!ctx.explicit && typed.length === 0 && !before.endsWith('[[')) return null

    // 랭킹: 접두어 일치 > 부분일치, 피참조(허브) 가중, 캘린더 노트 감점
    const options = rankLinkTargets(getTargets(), typed)
      .map(t => ({
        label: t.title,
        detail: t.inbound > 0
          ? `${t.folder ?? TYPE_LABEL[t.type] ?? t.type} · ↩${t.inbound}`
          : (t.folder ?? TYPE_LABEL[t.type] ?? t.type),
        // 선택 시 "[[제목]]" 으로 완성 (여는 괄호부터 교체)
        apply: (view: import('@codemirror/view').EditorView, _c: unknown, from: number, to: number) => {
          // 커서 뒤에 이미 닫는 괄호가 있으면 같이 먹는다.
          // '/' 메뉴의 '노트 링크'·'이전 노트 대체'는 [[]] 를 통째로 넣고 커서를
          // 가운데 두므로, 이걸 안 하면 [[제목]]]] 처럼 괄호가 겹친다.
          const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to
          view.dispatch({
            changes: { from, to: end, insert: `[[${t.title}]]` },
            selection: { anchor: from + t.title.length + 4 },
          })
        },
      }))

    if (!options.length) return null
    return {
      from: ctx.state.doc.lineAt(ctx.pos).from + open,
      to: ctx.pos,
      options,
      filter: false,   // 위에서 이미 필터링함 (한글 부분일치 유지)
    }
  }
}
