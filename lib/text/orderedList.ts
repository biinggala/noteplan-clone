/**
 * 번호 목록 들여쓰기/내어쓰기와 번호 다시 매기기.
 *
 *   1. 가
 *   2. 나
 *   3. |      ← Tab
 *
 *   1. 가
 *   2. 나
 *     1. |    ← 한 단계 안쪽 목록은 1부터 (같은 단계에 앞 항목이 있으면 이어서)
 *
 * Shift+Tab 은 반대로 바깥 단계 번호를 이어 받는다. 옮긴 줄 아래에 남은 항목들도
 * 각자 단계에서 번호가 이어지도록 다시 매긴다. 순수 함수라 줄 배열만 다룬다.
 */

const NUM_RE = /^(\s*)(\d+)([.)])(\s+)/
const LIST_RE = /^(\s*)(?:\d+[.)]|[-+*])(?:\s|$)/

export interface IndentOptions {
  /** 한 단계 들여쓰기 문자열 (CodeMirror indentUnit) */
  unit: string
  tabSize: number
}

/** 줄 앞 공백의 너비 (탭은 tabSize 칸) */
function columns(ws: string, tabSize: number): number {
  let n = 0
  for (const ch of ws) n = ch === '\t' ? n + tabSize - (n % tabSize) : n + 1
  return n
}

function leading(text: string): string {
  return text.match(/^\s*/)![0]
}

/** 들여쓰기를 한 단계 줄인다. 이미 맨 앞이면 그대로. */
function dedent(ws: string, opts: IndentOptions): string {
  if (!ws) return ws
  if (ws.endsWith('\t')) return ws.slice(0, -1)
  const unitCols = Math.max(1, columns(opts.unit, opts.tabSize))
  const target = Math.max(0, columns(ws, opts.tabSize) - unitCols)
  let out = ''
  for (const ch of ws) {
    if (columns(out + ch, opts.tabSize) > target) break
    out += ch
  }
  return out
}

/** 번호 목록 줄이면 [들여쓰기, 번호, 구분자('.'|')'), 마커 뒤 공백] */
export function parseNumbered(text: string): { indent: string; num: number; delim: string; gap: string; prefixLen: number } | null {
  const m = text.match(NUM_RE)
  if (!m) return null
  return { indent: m[1], num: parseInt(m[2], 10), delim: m[3], gap: m[4], prefixLen: m[0].length }
}

/**
 * idx 줄보다 위에서 같은 단계(col)의 번호 항목을 찾아 그 다음 번호를 돌려준다.
 * 더 안쪽 줄은 건너뛰고, 바깥 단계 줄·목록이 아닌 줄·빈 줄을 만나면 1.
 */
function nextNumberAt(lines: string[], idx: number, col: number, tabSize: number): number {
  for (let i = idx - 1; i >= 0; i--) {
    const t = lines[i]
    if (!t.trim()) return 1
    const c = columns(leading(t), tabSize)
    if (c > col) continue
    if (c < col) return 1
    const n = parseNumbered(t)
    return n ? n.num + 1 : 1
  }
  return 1
}

/**
 * from 줄부터 아래로, col 단계의 번호 항목들을 start 부터 차례로 다시 매긴다.
 * 더 안쪽 줄은 건너뛰고, 바깥 단계·같은 단계의 번호 아닌 줄·빈 줄에서 멈춘다.
 */
function renumberRun(lines: string[], from: number, col: number, start: number, tabSize: number): void {
  let n = start
  for (let i = from; i < lines.length; i++) {
    const t = lines[i]
    if (!t.trim()) return
    const c = columns(leading(t), tabSize)
    if (c > col) {
      // 안쪽 줄이라도 목록이 아닌 일반 문단이면 (들여쓴 이어지는 글) 건너뛴다
      continue
    }
    if (c < col) return
    const p = parseNumbered(t)
    if (!p) return
    if (p.num !== n) lines[i] = `${p.indent}${n}${p.delim}${p.gap}${t.slice(p.prefixLen)}`
    n++
  }
}

/**
 * fromLine..toLine (0부터, 포함) 줄을 한 단계 들이거나(dir=1) 내어(dir=-1) 쓰고
 * 번호를 다시 매긴다. 범위 안에 번호 목록 줄이 하나도 없으면 null
 * (그때는 일반 들여쓰기에 맡긴다).
 */
export function shiftListLines(
  input: string[], fromLine: number, toLine: number, dir: 1 | -1, opts: IndentOptions,
): string[] | null {
  let hasNumbered = false
  for (let i = fromLine; i <= toLine; i++) if (parseNumbered(input[i])) { hasNumbered = true; break }
  if (!hasNumbered) return null

  const lines = input.slice()
  const { tabSize } = opts
  const touched = new Set<number>()   // 번호를 다시 매겨야 하는 단계(열)

  for (let i = fromLine; i <= toLine; i++) {
    const t = lines[i]
    if (!t.trim()) continue
    const ws = leading(t)
    const oldCol = columns(ws, tabSize)
    const nws = dir > 0 ? ws + opts.unit : dedent(ws, opts)
    if (nws === ws) continue
    lines[i] = nws + t.slice(ws.length)
    if (LIST_RE.test(t)) {
      touched.add(oldCol)
      touched.add(columns(nws, tabSize))
    }
  }

  // 옮긴 줄의 번호: 새 단계에서 앞 항목을 잇거나 1부터
  for (let i = fromLine; i <= toLine; i++) {
    const p = parseNumbered(lines[i])
    if (!p) continue
    const col = columns(p.indent, tabSize)
    const n = nextNumberAt(lines, i, col, tabSize)
    if (p.num !== n) lines[i] = `${p.indent}${n}${p.delim}${p.gap}${lines[i].slice(p.prefixLen)}`
  }

  // 아래에 남은 항목들: 바뀐 단계마다, 범위 뒤 첫 항목부터 이어서 다시 매긴다.
  for (const col of touched) {
    for (let i = toLine + 1; i < lines.length; i++) {
      const t = lines[i]
      if (!t.trim()) break
      const c = columns(leading(t), tabSize)
      if (c > col) continue
      if (c === col && parseNumbered(t)) renumberRun(lines, i, col, nextNumberAt(lines, i, col, tabSize), tabSize)
      break
    }
  }
  return lines
}
