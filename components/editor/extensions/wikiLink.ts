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
  //
  // 좌표→문서위치(posAtCoords)만으로 판정하면 안 된다. 줄 오른쪽 빈 여백이나
  // 문단 아래를 클릭해도 "가장 가까운" 위치(= 줄 끝)를 돌려주기 때문에,
  // 줄이 [[링크]]로 끝나면 엉뚱한 빈 공간 클릭에도 이동해버린다.
  // 그래서 실제로 링크 span 위를 눌렀는지(DOM)부터 확인한 뒤,
  // 어떤 링크인지는 위치로 특정한다(마크가 여러 span으로 쪼개져도 안전).
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!onOpen) return false
      if (event.button !== 0) return false
      const el = event.target as HTMLElement | null
      if (!el?.closest?.('.cm-wikilink')) return false
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
