import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

/** 주어진 문서 위치가 [[링크]] 안이면 그 링크 대상(제목)을 반환 */
function linkAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos)
  WIKILINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(line.text)) !== null) {
    const from = line.from + m.index
    const to = from + m[0].length
    if (pos >= from && pos <= to) return m[1].trim()
  }
  return null
}

export function wikiLinkExtension(onOpen?: (title: string) => void) {
  const plugin = ViewPlugin.fromClass(
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

  // 링크 클릭 → 해당 노트로 이동.
  // target의 class를 보는 대신 좌표→문서위치로 판정한다. CodeMirror가 문법
  // 하이라이팅 때문에 mark를 여러 span으로 쪼갤 수 있어, class 검사만으로는
  // 링크 중간을 눌렀을 때 놓치는 경우가 있음.
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!onOpen) return false
      if (event.button !== 0) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      const title = linkAt(view, pos)
      if (!title) return false
      event.preventDefault()
      onOpen(title)
      return true
    },
  })

  return [plugin, clickHandler]
}
