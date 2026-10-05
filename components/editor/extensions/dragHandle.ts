import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  gutter,
  GutterMarker,
} from '@codemirror/view'
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state'
import { startLineDrag, wireReorderIndicator, isLineDragActive } from '@/lib/dnd/pointerLineDrag'

// ─── Drag payload ─────────────────────────────────────────────────────────────

export const DRAG_TYPE = 'application/noteplan-line'

export interface LineDragData {
  type: 'line'
  lineNumber: number  // 1-based
  content: string
}

// ─── StateFields ──────────────────────────────────────────────────────────────

const setHoverLine    = StateEffect.define<number>()
const setDragOverLine = StateEffect.define<number>()

/** Line number currently under mouse (-1 = none) */
const hoverLineField = StateField.define<number>({
  create: () => -1,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setHoverLine)) return e.value
    return val
  },
})

/** Line number being dragged over (-1 = none) */
const dragOverLineField = StateField.define<number>({
  create: () => -1,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setDragOverLine)) return e.value
    return val
  },
})

// ─── GutterMarker ─────────────────────────────────────────────────────────────

class DragHandleMarker extends GutterMarker {
  constructor(private readonly lineFrom: number, private readonly active: boolean) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof DragHandleMarker &&
      this.lineFrom === other.lineFrom &&
      this.active === other.active
    )
  }

  toDOM(view: EditorView): Node {
    const el = document.createElement('div')
    el.className = this.active ? 'cm-drag-handle cm-drag-handle--on' : 'cm-drag-handle'
    el.setAttribute('title', '드래그: 줄 이동 / 타임라인에 드롭: 시간 블록 추가')

    el.innerHTML = `<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
      <circle cx="3" cy="2.5"  r="1.2"/>
      <circle cx="7" cy="2.5"  r="1.2"/>
      <circle cx="3" cy="7"    r="1.2"/>
      <circle cx="7" cy="7"    r="1.2"/>
      <circle cx="3" cy="11.5" r="1.2"/>
      <circle cx="7" cy="11.5" r="1.2"/>
    </svg>`

    // mouseenter on the element itself is reliable even in the gutter area
    // where posAtCoords() can return null (bypasses the mousemove snapping issue)
    el.addEventListener('mouseenter', () => {
      if (isLineDragActive()) return
      try {
        const line = view.state.doc.lineAt(this.lineFrom)
        if (line.number !== view.state.field(hoverLineField)) {
          view.dispatch({ effects: setHoverLine.of(line.number) })
        }
      } catch { /* lineFrom may be stale after doc change */ }
    })

    // pointer 기반 드래그 (HTML5 DnD는 WKWebView에서 동작 안 함)
    // 핸들 위 mousedown 은 CodeMirror 의 '드래그로 글자 선택'을 시작하지 않게 막는다
    el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    el.setAttribute('draggable', 'false')
    el.addEventListener('pointerdown', (e) => {
      try {
        const line = view.state.doc.lineAt(this.lineFrom)
        // 여러 줄을 선택해 둔 상태에서 그 안의 핸들을 잡으면 선택 전체를 옮긴다.
        // 선택 밖의 핸들이면 평소대로 그 한 줄만.
        const sel = view.state.selection.main
        let fromLine = line.number
        let toLine = line.number
        if (!sel.empty) {
          const a = view.state.doc.lineAt(sel.from).number
          const b = view.state.doc.lineAt(sel.to).number
          if (line.number >= a && line.number <= b) { fromLine = a; toLine = b }
        }
        startLineDrag(e, view, fromLine, toLine)
      } catch { /* lineFrom may be stale after doc change */ }
    })

    return el
  }
}

class SpacerMarker extends GutterMarker {
  toDOM(): Node {
    const el = document.createElement('div')
    el.style.width = '18px'
    return el
  }
}
const SPACER = new SpacerMarker()

// ─── Drop-target line indicator ───────────────────────────────────────────────

const dropIndicatorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = this.build(view) }
    update(u: ViewUpdate) {
      const changed =
        u.state.field(dragOverLineField) !== u.startState.field(dragOverLineField)
      if (u.docChanged || changed) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const lineNum = view.state.field(dragOverLineField)
      if (lineNum < 1) return Decoration.none
      try {
        const line = view.state.doc.line(lineNum)
        const builder = new RangeSetBuilder<Decoration>()
        builder.add(line.from, line.from, Decoration.line({ class: 'cm-drop-target' }))
        return builder.finish()
      } catch {
        return Decoration.none
      }
    }
  },
  { decorations: (v) => v.decorations },
)

// ─── Mouse tracking ────────────────────────────────────────────────────────────

function mouseTrackingHandlers() {
  return EditorView.domEventHandlers({
    mousemove(e, view) {
      // 줄을 끄는 동안엔 hover 를 바꾸지 않는다 — 바꾸면 잡고 있는 핸들 DOM 이 다시
      // 그려지고, WebKit(맥 앱)은 그때 pointer 이벤트를 끊어 드롭이 안 됐다
      if (isLineDragActive()) return false
      const contentLeft = view.contentDOM.getBoundingClientRect().left + 4
      const x = Math.max(e.clientX, contentLeft)
      const pos = view.posAtCoords({ x, y: e.clientY })
      const lineNum = pos != null ? view.state.doc.lineAt(pos).number : -1
      if (lineNum !== view.state.field(hoverLineField)) {
        view.dispatch({ effects: setHoverLine.of(lineNum) })
      }
      return false
    },
    mouseleave(_e, view) {
      if (isLineDragActive()) return false
      if (view.state.field(hoverLineField) !== -1) {
        view.dispatch({ effects: setHoverLine.of(-1) })
      }
      return false
    },
  })
}

// 줄 재정렬/타임라인 드롭은 이제 pointerLineDrag.ts(pointer 이벤트)가 처리.
// (HTML5 DnD 핸들러는 WKWebView에서 동작 안 해 제거)

// ─── Public extension ──────────────────────────────────────────────────────────

export function dragHandleExtension() {
  // 재정렬 인디케이터를 pointer 드래그 모듈에 연결
  wireReorderIndicator(
    (n) => setDragOverLine.of(n),
    (view) => view.dispatch({ effects: setDragOverLine.of(-1) }),
  )
  return [
    hoverLineField,
    dragOverLineField,
    gutter({
      class: 'cm-drag-handle-gutter',
      lineMarker(view, line) {
        const hoveredLine = view.state.field(hoverLineField)
        const lineNum = view.state.doc.lineAt(line.from).number
        return new DragHandleMarker(line.from, lineNum === hoveredLine)
      },
      lineMarkerChange: (update) =>
        update.docChanged ||
        update.state.field(hoverLineField) !== update.startState.field(hoverLineField),
      initialSpacer: () => SPACER,
    }),
    dropIndicatorPlugin,
    mouseTrackingHandlers(),
  ]
}
