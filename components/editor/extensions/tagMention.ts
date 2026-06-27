import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { maskLinks } from '@/lib/parser/noteParser'

// Korean syllable range added so #한글태그 / @한글멘션 are highlighted
const KO = '\uAC00-\uD7A3\u3131-\u314E\u314F-\u3163'
const TAG_RE = new RegExp(`#([\\w${KO}/]+)`, 'g')
const MENTION_RE = new RegExp(`@([\\w${KO}/]+)`, 'g')

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
