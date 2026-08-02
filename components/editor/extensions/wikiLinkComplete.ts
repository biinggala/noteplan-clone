import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import type { LinkTarget } from '@/lib/db/noteRepository'

const TYPE_LABEL: Record<string, string> = {
  daily: '데일리', weekly: '주간', monthly: '월간', yearly: '연간', project: '노트',
}

/**
 * `[[` 입력 시 노트 제목 자동완성.
 * getTargets는 최신 목록을 돌려주는 함수(에디터 생성 시점에 고정되지 않도록 ref 패턴).
 */
export function wikiLinkCompleteExtension(getTargets: () => LinkTarget[]) {
  function source(ctx: CompletionContext): CompletionResult | null {
    // 커서 앞에서 "[[" 이후 아직 "]]"로 닫히지 않은 부분을 잡는다
    const before = ctx.state.doc.sliceString(ctx.state.doc.lineAt(ctx.pos).from, ctx.pos)
    const open = before.lastIndexOf('[[')
    if (open === -1) return null
    const typed = before.slice(open + 2)
    if (typed.includes(']')) return null           // 이미 닫힌 링크
    if (!ctx.explicit && typed.length === 0 && !before.endsWith('[[')) return null

    const q = typed.toLowerCase()
    const seen = new Set<string>()
    const options = getTargets()
      .filter(t => {
        if (!t.title || seen.has(t.title)) return false
        if (q && !t.title.toLowerCase().includes(q)) return false
        seen.add(t.title)
        return true
      })
      .slice(0, 30)
      .map(t => ({
        label: t.title,
        detail: t.folder ?? TYPE_LABEL[t.type] ?? t.type,
        // 선택 시 "[[제목]]" 으로 완성 (여는 괄호부터 교체)
        apply: (view: import('@codemirror/view').EditorView, _c: unknown, from: number, to: number) => {
          view.dispatch({
            changes: { from, to, insert: `[[${t.title}]]` },
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

  return autocompletion({
    override: [source],
    icons: false,
    closeOnBlur: true,
    activateOnTyping: true,
  })
}
