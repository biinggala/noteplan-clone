import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

export function wikiLinkExtension() {
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
        const text = view.state.doc.sliceString(from, to)

        WIKILINK_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = WIKILINK_RE.exec(text)) !== null) {
          const start = from + match.index
          const end = start + match[0].length
          builder.add(start, end, Decoration.mark({ class: 'cm-wikilink' }))
        }

        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations }
  )
}
