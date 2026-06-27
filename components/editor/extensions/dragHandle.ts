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
import { startLineDrag, wireReorderIndicator } from '@/lib/dnd/pointerLineDrag'

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
      try {
        const line = view.state.doc.lineAt(this.lineFrom)
        if (line.number !== view.state.field(hoverLineField)) {
          view.dispatch({ effects: setHoverLine.of(line.number) })
        }
      } catch { /* lineFrom may be stale after doc change */ }
    })

    // pointer 기반 드래그 (HTML5 DnD는 WKWebView에서 동작 안 함)
    el.addEventListener('pointerdown', (e) => {
      try {
        const line = view.state.doc.lineAt(this.lineFrom)
        startLineDrag(e, view, line.number, line.text)
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
