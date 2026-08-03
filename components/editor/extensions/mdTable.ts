import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

/**
 * 마크다운 표 렌더링 (NotePlan 방식).
 *
 * 커서가 표 밖에 있을 때만 실제 <table>로 그리고, 표 안으로 커서가 들어오면
 * 원본 마크다운을 그대로 보여줘 편집할 수 있게 한다.
 * (markdownWYSIWYG의 cursor-reveal과 같은 규칙)
 */

type Align = 'left' | 'center' | 'right'

interface TableBlock {
  from: number
  to: number
  header: string[]
  aligns: Align[]
  rows: string[][]
}

/** "| a | b |" → ["a", "b"] — 양 끝 파이프는 버리고, \| 는 리터럴로 취급 */
function splitRow(line: string): string[] {
  const t = line.trim()
  const body = t.replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') { cur += '|'; i++; continue }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

const DELIM_CELL = /^:?-{1,}:?$/

/** 구분행이면 각 열의 정렬을 돌려주고, 아니면 null */
function parseDelimiter(line: string): Align[] | null {
  const cells = splitRow(line)
  if (!cells.length || !cells.every(c => DELIM_CELL.test(c))) return null
  return cells.map(c => {
    const l = c.startsWith(':'), r = c.endsWith(':')
    return l && r ? 'center' : r ? 'right' : 'left'
  })
}

const isTableLine = (s: string) => /^\s*\|/.test(s)

/** 문서에서 표 블록을 모두 찾는다 (헤더 + 구분행 + 본문 0줄 이상) */
function findTables(view: EditorView): TableBlock[] {
  const doc = view.state.doc
  const out: TableBlock[] = []
  let n = 1
  while (n <= doc.lines) {
    const head = doc.line(n)
    if (!isTableLine(head.text) || n + 1 > doc.lines) { n++; continue }
    const aligns = parseDelimiter(doc.line(n + 1).text)
    if (!aligns) { n++; continue }

    const header = splitRow(head.text)
    const rows: string[][] = []
    let last = n + 1
    for (let m = n + 2; m <= doc.lines; m++) {
      const l = doc.line(m)
      if (!isTableLine(l.text)) break
      rows.push(splitRow(l.text))
      last = m
    }
    out.push({ from: head.from, to: doc.line(last).to, header, aligns, rows })
    n = last + 1
  }
  return out
}

class TableWidget extends WidgetType {
  constructor(private readonly b: TableBlock) { super() }

  // 내용이 같으면 다시 그리지 않는다 (커서 이동마다 DOM 재생성 방지)
  eq(other: TableWidget): boolean {
    return JSON.stringify(this.b.header) === JSON.stringify(other.b.header)
      && JSON.stringify(this.b.aligns) === JSON.stringify(other.b.aligns)
      && JSON.stringify(this.b.rows) === JSON.stringify(other.b.rows)
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table-wrap'

    const table = document.createElement('table')
    table.className = 'cm-md-table'

    const cols = this.b.aligns.length
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    for (let i = 0; i < cols; i++) {
      const th = document.createElement('th')
      th.textContent = this.b.header[i] ?? ''
      th.style.textAlign = this.b.aligns[i]
      htr.appendChild(th)
    }
    thead.appendChild(htr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const row of this.b.rows) {
      const tr = document.createElement('tr')
      for (let i = 0; i < cols; i++) {
        const td = document.createElement('td')
        td.textContent = row[i] ?? ''
        td.style.textAlign = this.b.aligns[i]
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)

    // 표를 클릭하면 그 자리의 원본 마크다운으로 커서를 옮겨 바로 편집.
    // 누른 셀에 해당하는 줄로 보내 준다.
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const cell = (e.target as HTMLElement)?.closest?.('td, th') as HTMLTableCellElement | null
      let pos = this.b.from
      if (cell) {
        const rowEl = cell.parentElement as HTMLTableRowElement
        const isHeader = cell.tagName === 'TH'
        // 0=헤더, 1=구분행, 2+=본문 → 구분행은 건너뛰고 계산
        const rowIdx = isHeader ? 0 : rowEl.rowIndex + 1
        const line = view.state.doc.lineAt(this.b.from).number + rowIdx
        const target = Math.min(line, view.state.doc.lines)
        pos = view.state.doc.line(target).to
      }
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    })

    return wrap
  }

  ignoreEvent(): boolean { return false }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const sel = view.state.selection
  for (const b of findTables(view)) {
    // 커서/선택이 표에 걸쳐 있으면 원본 마크다운을 그대로 노출 (편집 모드)
    const inside = sel.ranges.some(r => r.to >= b.from && r.from <= b.to)
    if (inside) continue
    builder.add(b.from, b.to, Decoration.replace({ widget: new TableWidget(b), block: true }))
  }
  return builder.finish()
}

export function mdTableExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = build(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = build(u.view)
        }
      }
    },
    { decorations: v => v.decorations },
  )
}
