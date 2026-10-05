import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType, keymap } from '@codemirror/view'
import { RangeSetBuilder, Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { classifyTaskLine, splitTimePrefix, toggleTaskLine } from '@/lib/parser/taskOutline'

// ─── Types ───────────────────────────────────────────────────────────────────

type TaskType = 'open' | 'done' | 'cancelled' | 'scheduled' | 'checklist' | 'checklist-done'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip optional time-block prefix so task detection works for both formats */
function stripTimePrefix(lineText: string): { text: string; offset: number } {
  const { prefix, text } = splitTimePrefix(lineText)
  return { text, offset: prefix.length }
}

// 판별·토글 규칙은 lib/parser/taskOutline.ts 하나만 쓴다 (요약 패널과 동일해야 함)
function getTaskType(lineText: string): TaskType | null {
  return classifyTaskLine(lineText)?.type ?? null
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)

const TOGGLEABLE: ReadonlySet<TaskType> = new Set<TaskType>(['open', 'done', 'checklist', 'checklist-done'])

const STATE_LABEL: Record<TaskType, string> = {
  open: '할 일',
  done: '완료한 할 일',
  cancelled: '취소한 할 일',
  scheduled: '미룬 할 일',
  checklist: '체크리스트',
  'checklist-done': '완료한 체크리스트',
}

/** 해당 줄의 태스크를 토글하는 변경. 태스크가 아니거나 토글 불가면 null */
function toggleLineChange(view: EditorView, lineFrom: number) {
  const line = view.state.doc.lineAt(lineFrom)
  const type = getTaskType(line.text)
  if (!type) return null
  const next = toggleTaskLine(line.text, type)
  if (next == null || next === line.text) return null
  // 바뀐 부분(마커)만 교체한다 — 줄 전체를 바꾸면 커서가 줄 맨 앞으로 튄다
  const old = line.text
  let a = 0
  while (a < old.length && a < next.length && old[a] === next[a]) a++
  let z = 0
  while (z < old.length - a && z < next.length - a && old[old.length - 1 - z] === next[next.length - 1 - z]) z++
  return { from: line.from + a, to: line.to - z, insert: next.slice(a, next.length - z) }
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
  // "+ [x] " (checklist done) / "+ [ ] " — 마커 전체 교체
  const plusDone = text.match(/^(\s*)(\+ \[[x ]\] )/i)
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

    // 스크린리더용: 체크박스 역할 + 상태. 에디터 안에서는 Tab 순서에 넣지 않는다
    // (Tab은 들여쓰기) — 키보드 토글은 커서 줄에서 Mod-Enter.
    const toggleable = TOGGLEABLE.has(this.taskType)
    wrap.setAttribute('role', 'checkbox')
    wrap.setAttribute('aria-checked',
      this.taskType === 'done' || this.taskType === 'checklist-done' ? 'true'
      : this.taskType === 'cancelled' ? 'mixed' : 'false')
    wrap.setAttribute('aria-label', STATE_LABEL[this.taskType])
    if (!toggleable) wrap.setAttribute('aria-disabled', 'true')
    wrap.title = toggleable ? `${STATE_LABEL[this.taskType]} — 클릭하거나 ${isMac ? '⌘' : 'Ctrl+'}Enter로 전환` : STATE_LABEL[this.taskType]

    const icon = buildIcon(this.taskType)
    icon.setAttribute('aria-hidden', 'true')

    // Hover effect for toggle targets
    if (toggleable) {
      wrap.style.opacity = '1'
      wrap.addEventListener('mouseenter', () => { wrap.style.opacity = '0.75' })
      wrap.addEventListener('mouseleave', () => { wrap.style.opacity = '1' })
    }

    const toggle = () => {
      // 위치는 지금 DOM 기준으로 다시 잡는다 (만든 뒤 위쪽이 바뀌었을 수 있음)
      let pos = this.lineFrom
      try { pos = view.posAtDOM(wrap) } catch { /* 위젯이 이미 빠졌으면 생성 시 위치 */ }
      if (pos > view.state.doc.length) return
      const change = toggleLineChange(view, pos)
      if (change) view.dispatch({ changes: change, userEvent: 'input.toggle' })
    }

    wrap.addEventListener('mousedown', (e) => e.preventDefault())
    wrap.addEventListener('click', (e) => {
      e.preventDefault()
      toggle()
    })
    // 보조기술이 이 요소에 포커스를 준 경우 Space/Enter로 토글
    wrap.addEventListener('keydown', (e) => {
      if (e.target !== wrap || (e.key !== ' ' && e.key !== 'Enter')) return
      e.preventDefault()
      e.stopPropagation()
      toggle()
    })

    wrap.appendChild(icon)
    return wrap
  }

  eq(other: CheckboxWidget): boolean {
    return other.taskType === this.taskType && other.lineFrom === this.lineFrom
  }
  ignoreEvent(): boolean { return false }
}

/**
 * Mod-Enter: 커서(선택 영역)가 걸친 줄의 태스크를 토글. 토글할 태스크 줄이 하나도
 * 없으면 false → 기본 Mod-Enter(insertBlankLine)로 넘어간다.
 */
export function toggleTasksAtSelection(view: EditorView): boolean {
  const { state } = view
  const seen = new Set<number>()
  const changes: { from: number; to: number; insert: string }[] = []
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    let last = state.doc.lineAt(r.to).number
    // 다음 줄 맨 앞까지 잡힌 선택은 그 줄을 빼고 센다
    if (!r.empty && last > first && state.doc.line(last).from === r.to) last--
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      const c = toggleLineChange(view, state.doc.line(n).from)
      if (c) changes.push(c)
    }
  }
  if (!changes.length) return false
  view.dispatch({ changes, userEvent: 'input.toggle', scrollIntoView: true })
  return true
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

export function taskCheckboxExtension(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        constructor(view: EditorView) { this.decorations = buildWidgetDecorations(view) }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged) this.decorations = buildWidgetDecorations(u.view)
        }
      },
      { decorations: (v) => v.decorations },
    ),
    // defaultKeymap의 Mod-Enter(insertBlankLine)보다 먼저 — 태스크 줄이 아니면 그쪽으로 넘어감
    Prec.high(keymap.of([{ key: 'Mod-Enter', run: toggleTasksAtSelection }])),
  ]
}
