import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { maskLinks, maskCode, matchFacets } from '@/lib/parser/noteParser'

// 태그·멘션 규칙(시길 앞 글자, 숫자뿐/색상 제외, 한글 포함)은 색인과 같아야 하므로
// noteParser.matchFacets 하나만 쓴다.

/** 코드 노드 — 이 안의 #, @ 는 태그·멘션이 아니다 (`#include`, `#fff` …) */
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock'])

/** [from, to) 안의 코드 범위들 (문서 기준, 정렬됨) */
function codeRanges(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  syntaxTree(state).iterate({
    from, to,
    enter(node) {
      if (CODE_NODES.has(node.name)) { out.push({ from: node.from, to: node.to }); return false }
    },
  })
  return out
}

function inCode(state: EditorState, pos: number): boolean {
  return codeRanges(state, pos, pos).some(r => r.from <= pos && pos < r.to)
}

export interface FacetHit {
  kind: 'tag' | 'mention'
  value: string      // sigil 뺀 값 (예: 'crng/이연주')
  from: number
  to: number
}

/** 한 줄에서 #태그 / @멘션 위치들을 찾는다 (문서 기준 절대 위치). 인라인 코드는 제외 */
export function findFacetsInLine(text: string, lineStart: number): FacetHit[] {
  // URL 안의 #, @ 는 태그가 아니다 — 하이라이팅과 같은 마스킹을 쓴다
  return matchFacets(maskLinks(maskCode(text))).map(f => ({
    kind: f.kind, value: f.value,
    from: lineStart + f.index,
    to: lineStart + f.index + f.length,
  }))
}

/**
 * ⌘/Ctrl+클릭으로 그 태그의 검색 결과를 연다.
 * 웹 주소(externalLink)와 같은 규칙 — 그냥 클릭은 커서 놓기가 우선이다.
 */
export function facetClickExtension(onOpenFacet: (kind: 'tag' | 'mention', value: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos == null) return false
      const line = view.state.doc.lineAt(pos)
      const hit = findFacetsInLine(line.text, line.from).find(h => pos >= h.from && pos <= h.to)
      if (!hit || inCode(view.state, hit.from)) return false
      // mousedown에서 막아야 커서가 옮겨가지 않는다
      e.preventDefault()
      e.stopPropagation()
      onOpenFacet(hit.kind, hit.value)
      return true
    },
  })
}

export function tagMentionExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view)
      }

      update(update: ViewUpdate) {
        // 구문 트리는 뒤늦게(백그라운드로) 완성되기도 한다 — 그때도 코드 범위를 다시 거른다
        if (update.docChanged || update.viewportChanged
            || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = this.buildDecorations(update.view)
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>()
        const { from, to } = view.viewport
        // 링크/URL/이메일 영역은 공백으로 마스킹(길이 보존) → 그 안의 #,@ 는 매칭 안 됨
        const text = maskLinks(view.state.doc.sliceString(from, to))
        // 코드 스팬·코드 블록은 구문 트리로 거른다 (뷰포트가 펜스 중간에서 시작해도 정확)
        const code = codeRanges(view.state, from, to)
        let ci = 0

        for (const f of matchFacets(text)) {       // index 순으로 정렬돼 있다
          const start = from + f.index
          const end = start + f.length
          while (ci < code.length && code[ci].to <= start) ci++
          if (ci < code.length && code[ci].from < end) continue
          builder.add(start, end, Decoration.mark({ class: f.kind === 'tag' ? 'cm-tag' : 'cm-mention' }))
        }

        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations }
  )
}
