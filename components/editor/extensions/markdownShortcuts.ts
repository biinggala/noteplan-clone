import { EditorSelection, RangeSetBuilder } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, KeyBinding, ViewUpdate } from '@codemirror/view'

// 선택 영역을 open/close 마커로 감싸기(토글). 선택이 없으면 마커만 넣고 커서를 사이에 둠.
// 이미 마커로 감싸진 선택이면 해제.
function wrapSelection(open: string, close: string) {
  return (view: EditorView): boolean => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const selected = view.state.sliceDoc(range.from, range.to)
        const wrapped =
          selected.length >= open.length + close.length &&
          selected.startsWith(open) &&
          selected.endsWith(close)

        if (wrapped) {
          // 마커 제거
          const inner = selected.slice(open.length, selected.length - close.length)
          return {
            changes: { from: range.from, to: range.to, insert: inner },
            range: EditorSelection.range(range.from, range.from + inner.length),
          }
        }
        // 마커 추가 (선택 텍스트는 그대로 선택 유지, 빈 선택이면 커서를 사이에)
        const insert = open + selected + close
        const innerStart = range.from + open.length
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.range(innerStart, innerStart + selected.length),
        }
      }),
      { scrollIntoView: true, userEvent: 'input.wrap' },
    )
    return true
  }
}

// Cmd/Ctrl + B / I / U 마크다운 단축키
export const markdownShortcuts: KeyBinding[] = [
  { key: 'Mod-b', preventDefault: true, run: wrapSelection('**', '**') },
  { key: 'Mod-i', preventDefault: true, run: wrapSelection('*', '*') },
  { key: 'Mod-u', preventDefault: true, run: wrapSelection('<u>', '</u>') },
]

// ── <u>밑줄</u> 렌더 ────────────────────────────────────────────────────────
// 마크다운엔 밑줄 문법이 없어 <u> 태그를 쓰되, 에디터에선 밑줄로 표시하고
// 커서가 없는 영역의 <u>/</u> 태그는 숨김 (WYSIWYG와 동일한 cursor-reveal 방식).
const UNDERLINE_RE = /<u>([\s\S]*?)<\/u>/g

function buildUnderline(view: EditorView): DecorationSet {
  const { from, to } = view.viewport
  const text = view.state.doc.sliceString(from, to)
  const sel = view.state.selection.main
  const ranges: { from: number; to: number; deco: Decoration }[] = []
  UNDERLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = UNDERLINE_RE.exec(text)) !== null) {
    const start = from + m.index
    const end = start + m[0].length
    const openEnd = start + 3      // '<u>'
    const closeStart = end - 4     // '</u>'
    if (closeStart <= openEnd) continue
    // 내용 밑줄
    ranges.push({ from: openEnd, to: closeStart, deco: Decoration.mark({ class: 'cm-underline' }) })
    // 커서가 이 영역 밖이면 태그 숨김
    const cursorInside = sel.from <= end && sel.to >= start
    if (!cursorInside) {
      ranges.push({ from: start, to: openEnd, deco: Decoration.replace({}) })
      ranges.push({ from: closeStart, to: end, deco: Decoration.replace({}) })
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, r.deco)
  return builder.finish()
}

export function underlineExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = buildUnderline(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = buildUnderline(u.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
}
