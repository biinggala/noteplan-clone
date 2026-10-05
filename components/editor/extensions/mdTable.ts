import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { StateField, RangeSetBuilder, Annotation } from '@codemirror/state'
import type { EditorState, Text, Transaction } from '@codemirror/state'
import { openExternal, isSafeHttpUrl } from '@/lib/openExternal'
import { isFacetValue } from '@/lib/parser/noteParser'

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
 * 셀 안의 마크다운(**굵게**, `코드`, [[노트링크]], #태그 …)은 포커스가 없을 때
 * 렌더된 모습으로, 포커스가 들어오면 원문으로 바뀐다 — 에디터 본문의
 * markdownWYSIWYG와 같은 규칙.
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

/** n번째 줄에서 시작하는 표를 읽는다 (헤더 + 구분행 + 본문 0줄 이상). 표가 아니면 null */
function parseTableAt(doc: Text, n: number): TableBlock | null {
  if (n < 1 || n + 1 > doc.lines) return null
  const head = doc.line(n)
  if (!isTableLine(head.text)) return null
  const aligns = parseDelimiter(doc.line(n + 1).text)
  if (!aligns) return null

  const header = splitRow(head.text)
  const rows: string[][] = []
  let last = n + 1
  for (let m = n + 2; m <= doc.lines; m++) {
    const l = doc.line(m)
    if (!isTableLine(l.text)) break
    rows.push(splitRow(l.text))
    last = m
  }
  return { from: head.from, to: doc.line(last).to, header, aligns, rows }
}

/** 문서에서 표 블록을 모두 찾는다 */
function findTables(doc: Text): TableBlock[] {
  const out: TableBlock[] = []
  let n = 1
  while (n <= doc.lines) {
    const t = parseTableAt(doc, n)
    if (!t) { n++; continue }
    out.push(t)
    n = doc.lineAt(t.to).number + 1
  }
  return out
}

// ── 셀 안 인라인 마크다운 ───────────────────────────────────────────────
// 본문 파서(noteParser/tagMention)와 같은 한글 범위를 쓴다
const KO = '\\uAC00-\\uD7A3\\u3131-\\u314E\\u314F-\\u3163'
const INLINE = new RegExp(
  '`([^`]+)`' +                        // 1 코드
  '|\\[\\[([^\\]]+)\\]\\]' +           // 2 위키링크
  '|\\[([^\\]]+)\\]\\(([^)]+)\\)' +    // 3 텍스트, 4 URL
  '|\\*\\*([^*]+)\\*\\*' +             // 5 굵게
  '|~~([^~]+)~~' +                     // 6 취소선
  '|\\*([^*]+)\\*' +                   // 7 기울임 *
  '|_([^_]+)_' +                       // 8 기울임 _
  // 태그·멘션: 줄 맨 앞/공백/여는 괄호 뒤만 (본문·색인과 같은 규칙)
  `|(?<![^\\s(\\[{"'])#([\\w${KO}/]+)` +   // 9 태그
  `|(?<![^\\s(\\[{"'])@([\\w${KO}]+)`,     // 10 멘션
  'g'
)

/** 셀에 렌더할 만한 마크다운이 들어있는지 */
function hasInline(text: string): boolean {
  INLINE.lastIndex = 0
  return INLINE.test(text)
}

/**
 * 셀 원문 → DOM. innerHTML을 쓰지 않고 노드를 직접 만든다(노트 내용이
 * 그대로 HTML로 해석되면 안 되므로).
 */
function renderInline(text: string, onOpenWikiLink?: (title: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment()
  let last = 0
  INLINE.lastIndex = 0
  let m: RegExpExecArray | null

  const el = (tag: string, cls: string, content: string) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    node.textContent = content
    return node
  }

  while ((m = INLINE.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)))
    last = m.index + m[0].length

    // 매치 값은 반드시 여기서 지역 변수로 붙잡는다 — m은 다음 회차에 덮어쓰이고
    // 루프가 끝나면 null이라, 이벤트 핸들러가 m을 직접 읽으면 터진다.
    const [, code, wiki, linkText, linkUrl, bold, strike, emA, emB, tag, mention] = m

    if (code !== undefined) frag.appendChild(el('code', '', code))
    else if (wiki !== undefined) {
      const a = el('span', 'cm-wikilink', wiki)
      a.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        onOpenWikiLink?.(wiki)
      })
      frag.appendChild(a)
    }
    else if (linkText !== undefined) {
      // target=_blank 는 데스크톱(WKWebView)에서 앱 안 웹뷰로 열리거나 아예
      // 안 열린다. 기본 브라우저로 넘기는 공통 헬퍼를 쓴다.
      const a = document.createElement('a')
      a.textContent = linkText
      // javascript: 같은 스킴은 href 로도 두지 않는다 (가운데 클릭·키보드로 열릴 수 있다)
      if (isSafeHttpUrl(linkUrl)) a.href = linkUrl
      a.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        void openExternal(linkUrl)
      })
      frag.appendChild(a)
    }
    else if (bold !== undefined) frag.appendChild(el('strong', '', bold))
    else if (strike !== undefined) frag.appendChild(el('s', '', strike))
    else if (emA !== undefined) frag.appendChild(el('em', '', emA))
    else if (emB !== undefined) frag.appendChild(el('em', '', emB))
    else if (tag !== undefined) {
      frag.appendChild(isFacetValue(tag, 'tag') ? el('span', 'cm-tag', '#' + tag) : document.createTextNode('#' + tag))
    }
    else if (mention !== undefined) {
      frag.appendChild(isFacetValue(mention, 'mention') ? el('span', 'cm-mention', '@' + mention) : document.createTextNode('@' + mention))
    }
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
  return frag
}

// 열 너비는 마크다운에 적을 자리가 없어서 문서에 저장하지 못한다.
// 세션 동안만 헤더 조합을 키로 기억한다 (새로고침하면 기본 너비로 돌아감).
const columnWidths = new Map<string, number[]>()
const widthKey = (header: string[]) => header.join('\u0000')

const RAW_ATTR = 'data-raw'
const WRAP_CLASS = 'cm-md-table-wrap'

/** 셀 편집 커밋 트랜잭션 표시 — 이 트랜잭션으로는 표를 원문 보기로 바꾸지 않는다 */
const tableCommit = Annotation.define<boolean>()

/** CodeMirror가 화면에서 걷어낸 위젯 DOM. 늦게 도착한 blur가 여기에 쓰지 못하게 한다 */
const deadWraps = new WeakSet<HTMLElement>()

/** 위젯 DOM이 지금 문서의 어느 표인지 — 위치는 만든 시점이 아니라 지금 문서에서 다시 찾는다 */
function tableOfWrap(view: EditorView, wrap: HTMLElement): TableBlock | null {
  if (deadWraps.has(wrap) || !wrap.isConnected || !view.dom.contains(wrap)) return null
  let pos: number
  try { pos = view.posAtDOM(wrap) } catch { return null }
  if (pos < 0 || pos > view.state.doc.length) return null
  const t = parseTableAt(view.state.doc, view.state.doc.lineAt(pos).number)
  return t && t.from === pos ? t : null
}

/** 문서 위치 `from`에서 시작하는 표 위젯의 (row, col) 셀에 포커스. row -1 = 헤더 */
export function focusTableCell(
  view: EditorView, from: number, row: number, col: number,
  mode: 'start' | 'end' | 'all' = 'end',
): boolean {
  const wraps = Array.from(view.dom.querySelectorAll<HTMLElement>(`.${WRAP_CLASS}`))
  const host = wraps.find(w => {
    if (deadWraps.has(w)) return false
    try { return view.posAtDOM(w) === from } catch { return false }
  })
  const sel = row === -1
    ? `thead tr th:nth-child(${col + 1}) .cm-tcell`
    : `tbody tr:nth-child(${row + 1}) td:nth-child(${col + 1}) .cm-tcell`
  const el = host?.querySelector(sel) as HTMLElement | null
  if (!el) return false
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  if (mode !== 'all') range.collapse(mode === 'start')
  const s = window.getSelection()
  s?.removeAllRanges()
  s?.addRange(range)
  return true
}

class TableWidget extends WidgetType {
  constructor(
    private readonly b: TableBlock,
    private readonly onOpenWikiLink?: (title: string) => void,
  ) { super() }

  // 위치(from)는 비교하지 않는다. 표 위쪽을 고쳐 표가 밀려나기만 했을 때
  // DOM을 그대로 두어야 셀에서 치던 글자·포커스가 날아가지 않는다.
  // 커밋할 때 실제 위치는 tableOfWrap()이 그때의 문서에서 다시 찾는다.
  eq(other: TableWidget): boolean {
    return JSON.stringify(this.b.header) === JSON.stringify(other.b.header)
      && JSON.stringify(this.b.aligns) === JSON.stringify(other.b.aligns)
      && JSON.stringify(this.b.rows) === JSON.stringify(other.b.rows)
  }

  destroy(dom: HTMLElement): void {
    deadWraps.add(dom)
  }

  toDOM(view: EditorView): HTMLElement {
    const b = this.b
    const cols = b.aligns.length
    const onOpen = this.onOpenWikiLink

    const wrap = document.createElement('div')
    wrap.className = WRAP_CLASS

    const scroll = document.createElement('div')
    scroll.className = 'cm-md-table-scroll'

    const table = document.createElement('table')
    table.className = 'cm-md-table'

    // 커밋이 문서를 바꾸면 이 위젯 DOM은 통째로 교체된다. 교체된 뒤에 남은
    // 옛 노드의 blur가 늦게 도착해 또 쓰는 걸 막는 플래그 (destroy()의
    // deadWraps와 함께 — 다른 이유로 걷어내진 경우까지 막는다).
    let dead = false

    /** 셀의 원문(마크다운). 포커스 중이면 화면 텍스트가 곧 원문이다. */
    function rawOf(el: Element): string {
      return el === document.activeElement
        ? (el.textContent ?? '')
        : (el.getAttribute(RAW_ATTR) ?? el.textContent ?? '')
    }

    function readCells(): { header: string[]; rows: string[][] } {
      const header = Array.from(table.querySelectorAll('thead .cm-tcell')).map(rawOf)
      const rows = Array.from(table.querySelectorAll('tbody tr'))
        .map(tr => Array.from(tr.querySelectorAll('.cm-tcell')).map(rawOf))
      return { header, rows }
    }

    /** 이 위젯이 그리는 표의 지금 위치 (위젯이 이미 버려졌으면 null) */
    let lastFrom: number | null = null
    function current(): TableBlock | null {
      if (dead) return null
      const t = tableOfWrap(view, wrap)
      if (t) lastFrom = t.from
      return t
    }

    /**
     * 현재 화면 값을 마크다운으로 재직렬화해 문서에 한 번에 반영.
     * 표의 범위는 위젯을 만들 때가 아니라 지금 문서에서 다시 찾는다 —
     * 그 사이 문서가 바뀌었으면 낡은 범위로 쓰다 RangeError가 나거나 남의
     * 글을 덮어쓴다.
     */
    function commit(extra?: { header: string[]; aligns: Align[]; rows: string[][] }) {
      const cur = current()
      if (!cur) { dead = true; return }
      const next = extra ?? { ...readCells(), aligns: b.aligns }
      const text = serializeTable(next)
      if (text === view.state.doc.sliceString(cur.from, cur.to)) return
      dead = true
      view.dispatch({
        changes: { from: cur.from, to: cur.to, insert: text },
        annotations: tableCommit.of(true),
        userEvent: 'input.table',
      })
    }

    /** 커밋 후 새로 그려진 위젯에서 같은 좌표의 셀을 찾아 포커스 (row -1 = 헤더) */
    function focusCell(row: number, col: number, atStart = false) {
      if (lastFrom == null) return
      focusTableCell(view, lastFrom, row, col, atStart ? 'start' : 'end')
    }

    function paint(editable: HTMLElement, raw: string) {
      editable.setAttribute(RAW_ATTR, raw)
      editable.textContent = ''
      editable.appendChild(renderInline(raw, onOpen))
    }

    function makeCell(tag: 'th' | 'td', raw: string, row: number, col: number): HTMLElement {
      const cell = document.createElement(tag)
      cell.style.textAlign = b.aligns[col]

      const editable = document.createElement('div')
      editable.className = 'cm-tcell'
      editable.contentEditable = 'true'
      editable.spellcheck = false
      paint(editable, raw)

      // 포커스가 오면 원문으로, 나가면 다시 렌더된 모습으로 (본문 WYSIWYG와 동일)
      // 마크다운이 없는 평범한 셀은 바꿔치기하지 않는다 — 클릭한 자리에
      // 캐럿이 그대로 남게 하려고.
      editable.addEventListener('focus', () => {
        const r = editable.getAttribute(RAW_ATTR) ?? ''
        if (hasInline(r)) editable.textContent = r
      })

      editable.addEventListener('input', () => {
        editable.setAttribute(RAW_ATTR, editable.textContent ?? '')
      })

      // 표 셀은 한 줄이므로 붙여넣기의 줄바꿈은 공백으로 눕힌다
      editable.addEventListener('paste', (e) => {
        e.preventDefault()
        const t = e.clipboardData?.getData('text/plain') ?? ''
        document.execCommand('insertText', false, t.replace(/\r?\n/g, ' '))
      })

      // 한글 IME 조합 중에는 커밋하지 않는다. 조합 중인 글자는 아직 DOM에
      // 확정되지 않아서, 이때 커밋/다시 그리면 마지막 음절이 두 번 들어가거나
      // 사라진다. 조합 중에 포커스를 잃으면 조합이 끝난 뒤에 커밋한다.
      let composing = false
      let blurPending = false
      const finishBlur = () => {
        blurPending = false
        const raw2 = editable.textContent ?? ''
        editable.setAttribute(RAW_ATTR, raw2)
        commit()
        // 문서가 안 바뀌어 위젯이 그대로면 여기서 직접 다시 렌더한다
        if (!dead && document.activeElement !== editable) paint(editable, raw2)
      }
      editable.addEventListener('compositionstart', () => { composing = true })
      editable.addEventListener('compositionend', () => {
        composing = false
        if (blurPending) finishBlur()
      })

      editable.addEventListener('blur', () => {
        if (composing) {
          blurPending = true
          // compositionend가 끝내 오지 않는 브라우저 대비
          setTimeout(() => { if (blurPending) { composing = false; finishBlur() } }, 300)
          return
        }
        finishBlur()
      })

      editable.addEventListener('keydown', (e) => {
        // IME 조합 중의 Enter/Tab 등은 조합 확정용이다 — 셀 이동/커밋을 하면
        // 확정되기 전 글자로 커밋된 뒤 확정 글자가 한 번 더 들어간다.
        if (e.isComposing || e.keyCode === 229) {
          e.stopPropagation()
          return
        }
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

    // ── 열 너비 (colgroup + 경계선 드래그) ──
    const colgroup = document.createElement('colgroup')
    const colEls: HTMLTableColElement[] = []
    const saved = columnWidths.get(widthKey(b.header))
    for (let i = 0; i < cols; i++) {
      const col = document.createElement('col')
      if (saved && saved.length === cols) col.style.width = `${saved[i]}px`
      colgroup.appendChild(col)
      colEls.push(col)
    }
    if (saved && saved.length === cols) table.style.tableLayout = 'fixed'
    table.appendChild(colgroup)

    function startResize(e: MouseEvent, index: number) {
      e.preventDefault()
      e.stopPropagation()
      // 드래그를 시작할 때 현재 렌더된 너비를 전부 픽셀로 고정한다.
      // 그래야 한 칸만 늘려도 나머지가 제멋대로 움직이지 않는다.
      const ths = Array.from(table.querySelectorAll('thead th'))
      const widths = ths.map(th => (th as HTMLElement).getBoundingClientRect().width)
      colEls.forEach((c, i) => { c.style.width = `${widths[i]}px` })
      table.style.tableLayout = 'fixed'

      const startX = e.clientX
      const startA = widths[index]
      const startB = widths[index + 1]
      const MIN = 48

      const onMove = (ev: MouseEvent) => {
        let dx = ev.clientX - startX
        dx = Math.max(-(startA - MIN), Math.min(startB - MIN, dx))
        widths[index] = startA + dx
        widths[index + 1] = startB - dx
        colEls[index].style.width = `${widths[index]}px`
        colEls[index + 1].style.width = `${widths[index + 1]}px`
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('cm-table-resizing')
        columnWidths.set(widthKey(b.header), widths)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.classList.add('cm-table-resizing')
    }

    // ── 헤더 ──
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    for (let i = 0; i < cols; i++) {
      const th = makeCell('th', b.header[i] ?? '', -1, i)

      // 열 삭제 — 그 열에 마우스를 올렸을 때 위쪽 여백에 뜬다
      if (cols > 1) {
        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'cm-tdel cm-tdel-col'
        del.title = '이 열 삭제'
        del.textContent = '×'
        del.addEventListener('mousedown', (e) => e.preventDefault())
        del.addEventListener('click', () => {
          const { header, rows } = readCells()
          commit({
            header: header.filter((_, k) => k !== i),
            aligns: b.aligns.filter((_, k) => k !== i),
            rows: rows.map(r => r.filter((_, k) => k !== i)),
          })
        })
        th.appendChild(del)
      }

      // 마지막 열 뒤에는 경계선 드래그를 붙이지 않는다 (짝이 없음)
      if (i < cols - 1) {
        const grip = document.createElement('div')
        grip.className = 'cm-tresize'
        grip.addEventListener('mousedown', (e) => startResize(e, i))
        th.appendChild(grip)
      }

      htr.appendChild(th)
    }
    thead.appendChild(htr)
    table.appendChild(thead)

    // ── 본문 ──
    const tbody = document.createElement('tbody')
    b.rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      for (let i = 0; i < cols; i++) {
        const td = makeCell('td', row[i] ?? '', r, i)
        // 행 삭제 — 그 행에 마우스를 올렸을 때 왼쪽 여백에 뜬다
        if (i === 0) {
          const del = document.createElement('button')
          del.type = 'button'
          del.className = 'cm-tdel cm-tdel-row'
          del.title = '이 행 삭제'
          del.textContent = '×'
          del.addEventListener('mousedown', (e) => e.preventDefault())
          del.addEventListener('click', () => {
            const { header, rows } = readCells()
            commit({ header, aligns: b.aligns, rows: rows.filter((_, k) => k !== r) })
          })
          td.appendChild(del)
        }
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)

    scroll.appendChild(table)
    wrap.appendChild(scroll)

    // ── 표에 마우스를 올리면 뜨는 + 바 (Notion 방식) ──
    const addRow = document.createElement('button')
    addRow.type = 'button'
    addRow.className = 'cm-tadd cm-tadd-row'
    addRow.title = '행 추가'
    addRow.textContent = '+'
    addRow.addEventListener('mousedown', (e) => e.preventDefault())
    addRow.addEventListener('click', () => {
      const { header, rows } = readCells()
      commit({ header, aligns: b.aligns, rows: [...rows, new Array(cols).fill('')] })
      focusCell(rows.length, 0)
    })

    const addCol = document.createElement('button')
    addCol.type = 'button'
    addCol.className = 'cm-tadd cm-tadd-col'
    addCol.title = '열 추가'
    addCol.textContent = '+'
    addCol.addEventListener('mousedown', (e) => e.preventDefault())
    addCol.addEventListener('click', () => {
      const { header, rows } = readCells()
      // 열 수가 바뀌면 저장해 둔 너비는 의미가 없다
      columnWidths.delete(widthKey(b.header))
      commit({
        header: [...header, ''],
        aligns: [...b.aligns, 'left'],
        rows: rows.map(r => [...r, '']),
      })
      focusCell(-1, cols)
    })

    wrap.append(addRow, addCol)
    return wrap
  }

  // 셀 안 클릭/타이핑은 우리 로직이 다 처리 — CM이 자체 커서 이동을 시도하지
  // 않도록 이벤트를 통째로 무시하게 한다.
  ignoreEvent(): boolean { return true }
}

interface TableState {
  tables: TableBlock[]
  /** 원문으로 보여 주는 표의 시작 위치 (커서가 그 표 안에 있을 때) */
  reveal: number | null
  decos: DecorationSet
}

/**
 * 커서(메인 선택의 head)가 들어 있는 표. 그 표는 위젯으로 가리지 않고 원문
 * 그대로 보여 준다 — 가려진 범위 안에 커서가 있으면 CodeMirror가 DOM 캐럿을
 * 둘 곳이 없어 타이핑이 문서 맨 앞으로 튄다 (문서 끝의 표 뒤, 구분행을 막
 * 친 직후, /표 삽입 직후 등). 경계(from, to)도 포함한다.
 */
function tableAtHead(tables: TableBlock[], state: EditorState): TableBlock | null {
  const head = state.selection.main.head
  return tables.find(t => t.from <= head && head <= t.to) ?? null
}

function build(tables: TableBlock[], reveal: number | null, onOpenWikiLink?: (title: string) => void): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const b of tables) {
    if (b.from === reveal) continue
    builder.add(b.from, b.to, Decoration.replace({
      widget: new TableWidget(b, onOpenWikiLink),
      block: true,
    }))
  }
  return builder.finish()
}

/**
 * 이번 변경이 표에 영향을 줄 수 있는지. 아니면 전체 재스캔 대신 기존 표
 * 위치만 옮긴다 — 큰 노트에서 키 입력마다 문서 전체를 훑지 않도록.
 * (바뀐 줄에 '|'가 있거나, 바뀐 범위가 기존 표에 닿으면 재스캔)
 */
function touchesTables(tr: Transaction, tables: TableBlock[]): boolean {
  let hit = false
  const doc = tr.state.doc
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (hit) return
    if (tables.some(t => fromA <= t.to + 1 && toA >= t.from - 1)) { hit = true; return }
    const text = doc.sliceString(doc.lineAt(fromB).from, doc.lineAt(toB).to)
    if (text.includes('|')) hit = true
  })
  return hit
}

function mapTables(tables: TableBlock[], tr: Transaction): TableBlock[] {
  return tables.map(t => ({ ...t, from: tr.changes.mapPos(t.from, 1), to: tr.changes.mapPos(t.to, -1) }))
}

export function mdTableExtension(onOpenWikiLink?: (title: string) => void) {
  return StateField.define<TableState>({
    create(state) {
      const tables = findTables(state.doc)
      // 처음 열 때는 커서가 (기본값 0이라) 맨 앞 표 안에 있어도 렌더한다
      return { tables, reveal: null, decos: build(tables, null, onOpenWikiLink) }
    },
    update(value, tr) {
      const tables = !tr.docChanged ? value.tables
        : touchesTables(tr, value.tables) ? findTables(tr.state.doc)
        : mapTables(value.tables, tr)

      let reveal: number | null
      if (tr.annotation(tableCommit)) reveal = null              // 셀 편집 커밋: 렌더 유지
      else if (tr.docChanged || tr.selection) reveal = tableAtHead(tables, tr.state)?.from ?? null
      else reveal = value.reveal

      if (!tr.docChanged && reveal === value.reveal) return value
      return { tables, reveal, decos: build(tables, reveal, onOpenWikiLink) }
    },
    provide: f => EditorView.decorations.from(f, v => v.decos),
  })
}
