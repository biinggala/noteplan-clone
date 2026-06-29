import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

// ─── Types ───────────────────────────────────────────────────────────────────

type TaskType = 'open' | 'done' | 'cancelled' | 'scheduled' | 'checklist' | 'checklist-done'

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Optional time-block prefix: "2:30 PM - 3:00 PM " at the start of a line
const TIME_PREFIX_RE = /^\d{1,2}:\d{2}\s*(?:AM|PM)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s+/i

/** Strip optional time-block prefix so task detection works for both formats */
function stripTimePrefix(lineText: string): { text: string; offset: number } {
  const m = TIME_PREFIX_RE.exec(lineText)
  return m
    ? { text: lineText.slice(m[0].length), offset: m[0].length }
    : { text: lineText, offset: 0 }
}

function getTaskType(lineText: string): TaskType | null {
  const { text } = stripTimePrefix(lineText)
  if (/^\s*- \[ \]\s/.test(text)) return 'open'
  if (/^\s*- \[x\]\s/i.test(text)) return 'done'
  if (/^\s*- \[-\]\s/.test(text)) return 'cancelled'
  if (/^\s*- \[>\]\s/.test(text)) return 'scheduled'
  if (/^\s*\* \S/.test(text)) return 'open'   // * task (NotePlan style)
  if (/^\s*\+ \[x\]\s/i.test(text)) return 'checklist-done' // + [x] checklist done
  if (/^\s*\+ \S/.test(text)) return 'checklist' // + checklist (open)
  return null
}

/** Position range of the marker/checkbox token to replace with a widget */
function getMarkerRange(
  lineText: string,
  lineFrom: number,
): { from: number; to: number } | null {
  const { text, offset } = stripTimePrefix(lineText)

  // "- [ ] " / "- [x] " / etc. — replace entire "- [X] " incl. the dash
  const bracket = text.match(/^(\s*)(- )(\[ \]|\[x\]|\[-\]|\[>\]) /)
  if (bracket) {
    const start = lineFrom + offset + bracket[1].length   // after leading whitespace
    const end = start + bracket[2].length + bracket[3].length + 1 // "- " + "[x]" + " "
    return { from: start, to: end }
  }
  // "* " (NotePlan open task)
  const star = text.match(/^(\s*)(\* )/)
  if (star) {
    const start = lineFrom + offset + star[1].length
    return { from: start, to: start + 2 }
  }
  // "+ [x] " (checklist done) — 마커 전체 교체
  const plusDone = text.match(/^(\s*)(\+ \[x\] )/i)
  if (plusDone) {
    const start = lineFrom + offset + plusDone[1].length
    return { from: start, to: start + plusDone[2].length }
  }
  // "+ " (checklist open)
  const plus = text.match(/^(\s*)(\+ )/)
  if (plus) {
    const start = lineFrom + offset + plus[1].length
    return { from: start, to: start + 2 }
  }
  return null
}

// ─── SVG Icon helpers ─────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg'

function makeSVG(size = 15): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 15 15')
  svg.style.cssText = 'display:inline-block;vertical-align:middle;flex-shrink:0;overflow:visible;'
  return svg
}

function addCircle(svg: SVGSVGElement, fill: string, stroke: string, strokeW = 1.5) {
  const el = document.createElementNS(NS, 'circle')
  el.setAttribute('cx', '7.5'); el.setAttribute('cy', '7.5'); el.setAttribute('r', '6.25')
  el.setAttribute('fill', fill); el.setAttribute('stroke', stroke)
  el.setAttribute('stroke-width', String(strokeW))
  svg.appendChild(el)
}

function addPath(svg: SVGSVGElement, d: string, stroke: string, strokeW = 1.8) {
  const el = document.createElementNS(NS, 'path')
  el.setAttribute('d', d); el.setAttribute('fill', 'none')
  el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', String(strokeW))
  el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(el)
}

function buildIcon(taskType: TaskType): SVGSVGElement {
  const svg = makeSVG()
  switch (taskType) {
    case 'open': {
      // Empty circle — golden/amber outline (NotePlan style)
      addCircle(svg, 'none', '#d4a843')
      break
    }
    case 'done': {
      // Outlined circle + checkmark inside — sage green (NotePlan style)
      addCircle(svg, 'none', '#6aaa6a')
      addPath(svg, 'M4.5 7.8L6.6 9.8L10.5 5.5', '#6aaa6a')
      break
    }
    case 'cancelled': {
      // Dim circle + horizontal strikethrough bar
      addCircle(svg, 'none', 'rgba(107,114,128,0.5)')
      addPath(svg, 'M4.5 7.5H10.5', 'rgba(107,114,128,0.6)', 1.8)
      break
    }
    case 'scheduled': {
      // Violet circle + right-arrow
      addCircle(svg, 'none', '#a78bfa')
      addPath(svg, 'M5.5 7.5H10M8 5.5L10 7.5L8 9.5', '#a78bfa', 1.5)
      break
    }
    case 'checklist': {
      // Rounded square outline (amber/yellow)
      const el = document.createElementNS(NS, 'rect')
      el.setAttribute('x', '1.5'); el.setAttribute('y', '1.5')
      el.setAttribute('width', '12'); el.setAttribute('height', '12')
      el.setAttribute('rx', '2.5')
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#f59e0b')
      el.setAttribute('stroke-width', '1.5')
      svg.appendChild(el)
      break
    }
    case 'checklist-done': {
      // Rounded square + checkmark (green)
      const el = document.createElementNS(NS, 'rect')
      el.setAttribute('x', '1.5'); el.setAttribute('y', '1.5')
      el.setAttribute('width', '12'); el.setAttribute('height', '12')
      el.setAttribute('rx', '2.5')
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#6aaa6a')
      el.setAttribute('stroke-width', '1.5')
      svg.appendChild(el)
      addPath(svg, 'M4.5 7.8L6.6 9.8L10.5 5.5', '#6aaa6a')
      break
    }
  }
  return svg
}

// ─── Checkbox Widget ──────────────────────────────────────────────────────────

class CheckboxWidget extends WidgetType {
  constructor(
    private readonly taskType: TaskType,
    private readonly lineFrom: number,
  ) { super() }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.style.cssText =
      'display:inline-flex;align-items:center;margin-right:5px;vertical-align:middle;' +
      'cursor:pointer;position:relative;top:-0.5px;'

    const icon = buildIcon(this.taskType)

    // Hover effect for toggle targets
    if (this.taskType === 'open' || this.taskType === 'done'
        || this.taskType === 'checklist' || this.taskType === 'checklist-done') {
      wrap.style.opacity = '1'
      wrap.addEventListener('mouseenter', () => { wrap.style.opacity = '0.75' })
      wrap.addEventListener('mouseleave', () => { wrap.style.opacity = '1' })
    }

    wrap.addEventListener('mousedown', (e) => e.preventDefault())
    wrap.addEventListener('click', (e) => {
      e.preventDefault()
      const line = view.state.doc.lineAt(this.lineFrom)
      let newText = line.text
      if (this.taskType === 'done') {
        newText = newText.replace(/- \[x\]/i, '- [ ]')
      } else if (this.taskType === 'open') {
        newText = newText
          .replace('- [ ]', '- [x]')
          .replace(/^(\s*)\* /, '$1- [x] ')
      } else if (this.taskType === 'checklist') {
        // + content → + [x] content (체크)
        newText = newText.replace(/^(\s*)\+ /, '$1+ [x] ')
      } else if (this.taskType === 'checklist-done') {
        // + [x] content → + content (해제)
        newText = newText.replace(/^(\s*)\+ \[x\] /i, '$1+ ')
      }
      if (newText !== line.text) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } })
      }
    })

    wrap.appendChild(icon)
    return wrap
  }

  eq(other: CheckboxWidget): boolean {
    return other.taskType === this.taskType && other.lineFrom === this.lineFrom
  }
  ignoreEvent(): boolean { return false }
}

// ─── Plugin 1: Line-level class decorations ───────────────────────────────────
// Kept SEPARATE from Plugin 2 to avoid RangeSetBuilder ordering conflicts.

function buildLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { from, to } = view.viewport

  for (let pos = from; pos <= to;) {
    const line = view.state.doc.lineAt(pos)
    const taskType = getTaskType(line.text)

    if (taskType) {
      const cls =
        taskType === 'done'           ? 'cm-task-done'
        : taskType === 'checklist-done' ? 'cm-task-done'
        : taskType === 'cancelled'      ? 'cm-task-cancelled'
        : taskType === 'scheduled'      ? 'cm-task-scheduled'
        : taskType === 'checklist'      ? 'cm-checklist'
        : 'cm-task-open'

      // Decoration.line is a point decoration — from == to == line.from
      builder.add(line.from, line.from, Decoration.line({ class: cls }))
    }

    pos = line.to + 1
  }

  return builder.finish()
}

export function taskLineStyleExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = buildLineDecorations(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = buildLineDecorations(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

// ─── Plugin 2: Checkbox widget replacements ───────────────────────────────────
// Separate plugin so its RangeSetBuilder never mixes with line decorations.

function buildWidgetDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { from, to } = view.viewport

  for (let pos = from; pos <= to;) {
    const line = view.state.doc.lineAt(pos)
    const taskType = getTaskType(line.text)

    if (taskType) {
      const mr = getMarkerRange(line.text, line.from)
      if (mr) {
        builder.add(
          mr.from,
          mr.to,
          Decoration.replace({ widget: new CheckboxWidget(taskType, line.from) }),
        )
      }
    }

    pos = line.to + 1
  }

  return builder.finish()
}

export function taskCheckboxExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = buildWidgetDecorations(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = buildWidgetDecorations(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}
