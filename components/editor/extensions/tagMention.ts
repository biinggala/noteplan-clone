import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { maskLinks } from '@/lib/parser/noteParser'

// Korean syllable range added so #한글태그 / @한글멘션 are highlighted
const KO = '\uAC00-\uD7A3\u3131-\u314E\u314F-\u3163'
const TAG_RE = new RegExp(`#([\\w${KO}/]+)`, 'g')
const MENTION_RE = new RegExp(`@([\\w${KO}/]+)`, 'g')

export interface FacetHit {
  kind: 'tag' | 'mention'
  value: string      // sigil 뺀 값 (예: 'crng/이연주')
  from: number
  to: number
}

/** 한 줄에서 #태그 / @멘션 위치들을 찾는다 (문서 기준 절대 위치) */
export function findFacetsInLine(text: string, lineStart: number): FacetHit[] {
  // URL 안의 #, @ 는 태그가 아니다 — 하이라이팅과 같은 마스킹을 쓴다
  const masked = maskLinks(text)
  const hits: FacetHit[] = []
  for (const [re, kind] of [[TAG_RE, 'tag'], [MENTION_RE, 'mention']] as const) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      hits.push({
        kind, value: m[1],
        from: lineStart + m.index,
        to: lineStart + m.index + m[0].length,
      })
    }
  }
  return hits.sort((a, b) => a.from - b.from)
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
      if (!hit) return false
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
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view)
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>()
        const { from, to } = view.viewport
        // 링크/URL/이메일 영역은 공백으로 마스킹(길이 보존) → 그 안의 #,@ 는 매칭 안 됨
        const text = maskLinks(view.state.doc.sliceString(from, to))

        const addMatches = (regex: RegExp, className: string) => {
          regex.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = regex.exec(text)) !== null) {
            const start = from + match.index
            const end = start + match[0].length
            builder.add(start, end, Decoration.mark({ class: className }))
          }
        }

        // Note: ranges must be added in order
        const ranges: { start: number; end: number; class: string }[] = []

        for (const regex of [TAG_RE, MENTION_RE]) {
          regex.lastIndex = 0
          let match: RegExpExecArray | null
          const cls = regex === TAG_RE ? 'cm-tag' : 'cm-mention'
          while ((match = regex.exec(text)) !== null) {
            ranges.push({
              start: from + match.index,
              end: from + match.index + match[0].length,
              class: cls,
            })
          }
        }

        ranges.sort((a, b) => a.start - b.start)
        for (const r of ranges) {
          builder.add(r.start, r.end, Decoration.mark({ class: r.class }))
        }

        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations }
  )
}
