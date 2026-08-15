import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

// Matches lines that are purely a divider: ---, ***, ___, or ===
// setext 헤딩은 파서에서 꺼둬서(NoteEditor.tsx) --- 와 === 는 항상 구분선이다.
const HR_RE = /^\s*(?:---|\*\*\*|___|={3,})\s*$/

/**
 * Adds `cm-hr-rule` CSS class to every divider line (---, ***, ___, ===).
 * This applies regardless of cursor position (Decoration.line is never
 * removed by CodeMirror when the cursor enters the line, unlike
 * Decoration.replace + widget).
 *
 * All visual rendering is handled purely in CSS (globals.css):
 *   • font-size: 1px  →  text characters collapse to near-invisible
 *   • line-height: 1px + padding: 14px 0  →  same height as regular line
 *   • ::after pseudo-element  →  1px visual divider line
 */
function buildHRDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { from, to } = view.viewport

  for (let pos = from; pos <= to;) {
    const line = view.state.doc.lineAt(pos)

    if (HR_RE.test(line.text)) {
      builder.add(
        line.from,
        line.from,
        Decoration.line({ class: 'cm-hr-rule' }),
      )
    }

    pos = line.to + 1
  }

  return builder.finish()
}

export function hrRuleExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildHRDecorations(view)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = buildHRDecorations(u.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
}
