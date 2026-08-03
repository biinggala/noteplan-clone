import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { StateField, RangeSetBuilder } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'

/**
 * 마크다운 표를 실제 <table>로 렌더링하고, 셀을 클릭해 그 자리에서 바로
 * 타이핑할 수 있게 한다 (Notion / NotePlan 방식).
 *
 * 편집 모델: 각 셀은 contentEditable 아일랜드. 키 입력마다 문서를 갱신하면
 * 커밋할 때마다 위젯 DOM이 통째로 다시 생성돼 타이핑 중 포커스가 날아간다
 * (eq()가 내용 비교라 셀 값이 바뀌는 순간 위젯이 "다른 것"으로 판정됨).
 * 그래서 타이핑 자체는 로컬 DOM에서만 하고, 셀을 벗어날 때(Tab/Enter/블러)
 * 표 전체를 마크다운으로 재직렬화해 한 번에 커밋한다.
 *
 * ⚠️ 반드시 StateField로 구현해야 한다. CodeMirror는 block 데코레이션을
 * ViewPlugin에서 제공하는 걸 금지한다("Block decorations may not be
 * specified via plugins") — 뷰포트 재측정 시 RangeError가 반복 발생해
 * 에디터 렌더링 전체가 깨진다 (2026-08-03에 실제로 겪은 버그).
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

/** 셀 텍스트 → 마크다운 행의 한 칸. 파이프는 이스케이프, 줄바꿈은 공백으로 */
function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

function joinRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`
}

function alignMarker(a: Align): string {
  return a === 'center' ? ':---:' : a === 'right' ? '---:' : '---'
}

/** TableBlock → 전체 마크다운 텍스트 재직렬화 */
function serializeTable(b: Pick<TableBlock, 'header' | 'aligns' | 'rows'>): string {
  const lines = [
    joinRow(b.header),
    `| ${b.aligns.map(alignMarker).join(' | ')} |`,
    ...b.rows.map(joinRow),
  ]
  return lines.join('\n')
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
function findTables(state: EditorState): TableBlock[] {
  const doc = state.doc
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

// data-table-from 속성으로 커밋 후 재생성된 위젯을 다시 찾아 포커스를 돌려준다
const FROM_ATTR = 'data-table-from'

class TableWidget extends WidgetType {
  constructor(private readonly b: TableBlock) { super() }

  eq(other: TableWidget): boolean {
    return this.b.from === other.b.from
      && JSON.stringify(this.b.header) === JSON.stringify(other.b.header)
      && JSON.stringify(this.b.aligns) === JSON.stringify(other.b.aligns)
      && JSON.stringify(this.b.rows) === JSON.stringify(other.b.rows)
  }

  toDOM(view: EditorView): HTMLElement {
    const b = this.b
    const cols = b.aligns.length

    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table-wrap'
    wrap.setAttribute(FROM_ATTR, String(b.from))

    const table = document.createElement('table')
    table.className = 'cm-md-table'

    // 커밋이 문서를 바꾸면 이 위젯 DOM은 통째로 교체된다. 교체된 뒤에 남은
    // 옛 노드의 blur가 늦게 도착해 낡은 [from, to]로 또 쓰는 걸 막는 플래그.
    let dead = false

    /** 화면(contentEditable)에 지금 들어있는 값을 그대로 읽는다 */
    function readCells(): { header: string[]; rows: string[][] } {
      const header = Array.from(table.querySelectorAll('thead .cm-tcell'))
        .map(el => el.textContent ?? '')
      const rows = Array.from(table.querySelectorAll('tbody tr'))
        .map(tr => Array.from(tr.querySelectorAll('.cm-tcell')).map(el => el.textContent ?? ''))
      return { header, rows }
    }

    /** 현재 화면 값을 마크다운으로 재직렬화해 문서에 한 번에 반영 */
    function commit(extra?: { header: string[]; aligns: Align[]; rows: string[][] }) {
      if (dead) return
      const next = extra ?? { ...readCells(), aligns: b.aligns }
      const text = serializeTable(next)
      if (text === view.state.doc.sliceString(b.from, b.to)) return
      dead = true
      view.dispatch({ changes: { from: b.from, to: b.to, insert: text } })
    }

    /** 커밋 후 새로 그려진 위젯에서 같은 좌표의 셀을 찾아 포커스 (row -1 = 헤더) */
    function focusCell(row: number, col: number, atStart = false) {
      const host = view.dom.querySelector(`[${FROM_ATTR}="${b.from}"]`)
      const sel = row === -1
        ? `thead tr th:nth-child(${col + 1}) .cm-tcell`
        : `tbody tr:nth-child(${row + 1}) td:nth-child(${col + 1}) .cm-tcell`
      const el = host?.querySelector(sel) as HTMLElement | null
      if (!el) return
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(atStart)
      const s = window.getSelection()
      s?.removeAllRanges()
      s?.addRange(range)
    }

    function makeCell(tag: 'th' | 'td', text: string, row: number, col: number): HTMLElement {
      const cell = document.createElement(tag)
      cell.style.textAlign = b.aligns[col]
      const editable = document.createElement('div')
      editable.className = 'cm-tcell'
      editable.contentEditable = 'true'
      editable.textContent = text
      editable.spellcheck = false

      // 표 셀은 한 줄이므로 붙여넣기의 줄바꿈은 공백으로 눕힌다
      editable.addEventListener('paste', (e) => {
        e.preventDefault()
        const t = e.clipboardData?.getData('text/plain') ?? ''
        document.execCommand('insertText', false, t.replace(/\r?\n/g, ' '))
      })

      editable.addEventListener('blur', () => commit())

      editable.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          editable.textContent = row === -1 ? b.header[col] : b.rows[row][col]
          editable.blur()
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          const rowCount = table.querySelectorAll('tbody tr').length
          commit()
          if (row + 1 < rowCount) focusCell(row + 1, col)
          else editable.blur()
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          e.stopPropagation()
          const rowCount = table.querySelectorAll('tbody tr').length
          const forward = !e.shiftKey
          let r = row, c = col + (forward ? 1 : -1)
          if (c >= cols) { r += 1; c = 0 }
          else if (c < 0) { r -= 1; c = cols - 1 }
          commit()
          if (r < -1 || r >= rowCount) { editable.blur(); return }
          focusCell(r, c, forward)
          return
        }
        // 빈 셀에서 Backspace를 두면 브라우저가 셀 div 자체를 지워버린다
        if (e.key === 'Backspace' && !editable.textContent) {
          e.preventDefault()
          return
        }
        // 저장 단축키는 그대로 흘려보내고, 나머지 키는 CM 키맵(들여쓰기·서식
        // 단축키)이 표 밖 커서에 대해 동작하지 않도록 여기서 막는다
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') return
        e.stopPropagation()
      })

      cell.appendChild(editable)
      return cell
    }

    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    for (let i = 0; i < cols; i++) htr.appendChild(makeCell('th', b.header[i] ?? '', -1, i))
    thead.appendChild(htr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    b.rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      for (let i = 0; i < cols; i++) tr.appendChild(makeCell('td', row[i] ?? '', r, i))
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    wrap.appendChild(table)

    // ── 행/열 추가·삭제 ──
    const toolbar = document.createElement('div')
    toolbar.className = 'cm-md-table-toolbar'

    function button(text: string, title: string, danger: boolean, onClick: () => void) {
      const el = document.createElement('button')
      el.type = 'button'
      el.textContent = text
      el.title = title
      el.className = 'cm-md-table-btn' + (danger ? ' cm-md-table-btn-danger' : '')
      // mousedown 기본동작을 막아야 편집 중이던 셀이 blur되지 않는다
      el.addEventListener('mousedown', (e) => e.preventDefault())
      el.addEventListener('click', onClick)
      return el
    }

    toolbar.append(
      button('+ 행', '아래에 행 추가', false, () => {
        const { header, rows } = readCells()
        commit({ header, aligns: b.aligns, rows: [...rows, new Array(cols).fill('')] })
        focusCell(rows.length, 0)
      }),
      button('− 행', '마지막 행 삭제', true, () => {
        const { header, rows } = readCells()
        if (!rows.length) return
        commit({ header, aligns: b.aligns, rows: rows.slice(0, -1) })
      }),
      button('+ 열', '오른쪽에 열 추가', false, () => {
        const { header, rows } = readCells()
        commit({
          header: [...header, ''],
          aligns: [...b.aligns, 'left'],
          rows: rows.map(r => [...r, '']),
        })
        focusCell(-1, cols)
      }),
      button('− 열', '마지막 열 삭제', true, () => {
        if (cols <= 1) return
        const { header, rows } = readCells()
        commit({
          header: header.slice(0, -1),
          aligns: b.aligns.slice(0, -1),
          rows: rows.map(r => r.slice(0, -1)),
        })
      }),
    )
    wrap.appendChild(toolbar)

    return wrap
  }

  // 셀 안 클릭/타이핑은 우리 로직이 다 처리 — CM이 자체 커서 이동을 시도하지
  // 않도록 이벤트를 통째로 무시하게 한다.
  ignoreEvent(): boolean { return true }
}

function build(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const b of findTables(state)) {
    builder.add(b.from, b.to, Decoration.replace({ widget: new TableWidget(b), block: true }))
  }
  return builder.finish()
}

const tableField = StateField.define<DecorationSet>({
  create(state) { return build(state) },
  update(value, tr) {
    if (!tr.docChanged) return value
    return build(tr.state)
  },
  provide: f => EditorView.decorations.from(f),
})

export function mdTableExtension() {
  return tableField
}
