import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { FacetItem } from '@/lib/db/noteRepository'
import { normalizeKey } from '@/lib/parser/noteParser'

/**
 * `#태그` / `@멘션` 자동완성.
 *
 * 계층(슬래시)을 이해한다:
 *   `@cr`    → crng, crng/이연주, crng/정세운 … (상위를 먼저)
 *   `@crng/` → crng/이연주, crng/정세운 (그 아래만)
 *
 * autocompletion() 자체는 NoteEditor에서 한 번만 등록한다 — 소스만 넘긴다.
 */

// noteParser의 TAG/MENTION 패턴과 같은 한글 범위
const KO = '가-힣ㄱ-ㅎㅏ-ㅣ'
// 줄 시작이나 공백/여는 괄호 뒤의 # @ 만 트리거 → URL의 #fragment, 이메일 주소는 제외
const TRIGGER = new RegExp(`(?:^|[\\s([{"'])([#@])([\\w${KO}/]*)$`)

const depthOf = (v: string) => v.split('/').length

function score(value: string, typed: string, uses: number): number | null {
  const v = value.toLowerCase()

  let lexical: number
  if (!typed) {
    // 빈 쿼리: 최상위를 먼저 보여준다
    lexical = depthOf(value) === 1 ? 40 : 0
  } else if (typed.endsWith('/')) {
    // `crng/` → 그 아래 항목만
    if (!v.startsWith(typed) || v === typed) return null
    lexical = 80 - (depthOf(value) - depthOf(typed)) * 10
  } else {
    if (v === typed) lexical = 100
    else if (v.startsWith(typed)) lexical = 70
    // 세그먼트 시작 일치: 'crng/이' 처럼 슬래시 뒤부터 맞는 경우
    else if (v.split('/').some(seg => seg.startsWith(typed))) lexical = 45
    else if (v.includes(typed)) lexical = 20
    else return null
  }

  // 많이 쓴 값일수록 위로 (0회여도 후보로는 남는 중간 노드가 있음)
  return lexical + Math.min(24, Math.log2(1 + uses) * 8) - depthOf(value) * 2
}

/**
 * @param getFacets 최신 후보 목록을 돌려주는 함수
 *   (에디터는 한 번만 생성되므로 ref 패턴으로 최신값을 읽는다)
 */
export function tagMentionCompletionSource(
  getFacets: () => { tags: FacetItem[]; mentions: FacetItem[] },
): CompletionSource {
  return function source(ctx: CompletionContext): CompletionResult | null {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)
    const m = TRIGGER.exec(before)
    if (!m) return null

    const sigil = m[1]
    const typed = normalizeKey(m[2]).toLowerCase()
    // 아무것도 안 친 상태에서 저절로 뜨는 건 성가시다 — 명시 호출일 때만
    if (!typed && !ctx.explicit) return null

    const facets = getFacets()
    const pool = sigil === '#' ? facets.tags : facets.mentions

    const scored = pool
      .map(f => ({ f, s: score(f.value, typed, f.uses) }))
      .filter((x): x is { f: FacetItem; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s || a.f.value.localeCompare(b.f.value))
      .slice(0, 30)

    if (!scored.length) return null

    const sigilPos = line.from + before.length - m[2].length - 1

    return {
      from: sigilPos,
      to: ctx.pos,
      filter: false,   // 위에서 한글/계층까지 직접 랭킹함
      options: scored.map(({ f }) => ({
        label: sigil + f.value,
        detail: f.uses > 0 ? `${f.uses}` : undefined,
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          view.dispatch({
            changes: { from, to, insert: sigil + f.value },
            selection: { anchor: from + sigil.length + f.value.length },
          })
        },
      })),
    }
  }
}
