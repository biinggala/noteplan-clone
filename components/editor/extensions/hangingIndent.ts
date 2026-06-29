import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

// 리스트/태스크 라인(- [ ] / - / * / + / 1.)이 줄바꿈될 때, 이어지는 줄을
// 텍스트 시작 위치에 맞춰 들여쓰기(hanging indent). 앞 들여쓰기(탭)도 반영.
const LIST_RE = /^(\s*)(- \[.\] |[-*+] |\d+\. )/

function buildHangingIndent(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const m = LIST_RE.exec(line.text)
      if (m) {
        // 들여쓰기 + 마커 폭(문자 수)을 ch 단위로 hanging indent
        const w = m[0].length
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: { style: `padding-left:${w}ch;text-indent:-${w}ch;` },
          }),
        )
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

export function hangingIndentExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = buildHangingIndent(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = buildHangingIndent(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}
