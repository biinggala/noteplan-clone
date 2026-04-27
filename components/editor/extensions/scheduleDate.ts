import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

const SCHEDULE_RE = />(\d{4}-\d{2}-\d{2}|tomorrow|today|yesterday|next\s+\w+)/gi

export function scheduleDateExtension() {
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

        SCHEDULE_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = SCHEDULE_RE.exec(text)) !== null) {
          const start = from + match.index
          const end = start + match[0].length
          builder.add(start, end, Decoration.mark({ class: 'cm-schedule-date' }))
        }

        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations }
  )
}
