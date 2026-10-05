import { EditorView, keymap } from '@codemirror/view'
import { Prec, EditorSelection, type ChangeSpec } from '@codemirror/state'
import { syntaxTree, getIndentUnit, indentString } from '@codemirror/language'
import { indentMore, indentLess } from '@codemirror/commands'
import { shiftListLines } from '@/lib/text/orderedList'

/**
 * NotePlan 입력 규칙:
 *   "* " (줄 시작) → "- [ ] " (오픈 태스크)
 *   "+ " (줄 시작) → 그대로 유지, checklist 위젯이 처리
 *   "- " (줄 시작) → 그대로 유지 (일반 불릿)
 *
 * Enter 자동 계속 (이 확장이 담당 — lang-markdown의 Enter보다 먼저 돈다):
 *   태스크/체크리스트/불릿/숫자 줄에서 Enter → 같은 타입 줄 계속
 *   (태스크는 완료/취소/미룸이었어도, `* ` 태스크여도 새 줄은 `- [ ] `)
 *   마커만 있는 빈 줄에서 Enter → 마커 삭제 (목록 종료)
 *   lang-markdown의 insertNewlineContinueMarkup은 NotePlan 마커를 모른다:
 *   `- [-]`/`- [>]`는 `- `로, `+ [x]`는 `+ [ ] `로 이어 버리고, 빈 둘째 항목에서
 *   Enter를 치면 목록을 끝내는 대신 빈 줄을 끼워 넣는다. 그래서 목록 줄의
 *   Enter는 여기서 Prec.highest로 먼저 처리하고, 인용(>)·코드 블록 등
 *   나머지는 lang-markdown에 넘긴다.
 *
 * Tab / Shift+Tab (번호 목록 줄):
 *   Tab → 한 단계 들여쓰고 번호는 그 단계에서 새로 1. (같은 단계 앞 항목이 있으면 이어서)
 *   Shift+Tab → 한 단계 내어쓰고 바깥 단계 번호를 이어 받는다
 *   아래에 남은 항목들도 각 단계에서 번호가 이어지게 다시 매긴다
 *   불릿/태스크 줄은 기본 들여쓰기(indentWithTab)
 */
export function inputRulesExtension() {
  return [
    // * + space → - [ ] (open task)
    EditorView.inputHandler.of((view, from, _to, text) => {
      if (text !== ' ') return false
      const line = view.state.doc.lineAt(from)
      const textBefore = line.text.slice(0, from - line.from)
      if (textBefore === '*') {
        // 커서를 명시적으로 '- [ ] ' 끝에 둠 (한글 IME 조합 시작 시 위치 동기화 → 앞 공백 끼임 방지)
        view.dispatch({
          changes: { from: line.from, to: from, insert: '- [ ] ' },
          selection: { anchor: line.from + 6 },
          userEvent: 'input.type',
        })
        return true
      }
      return false
    }),

    // Enter: list continuation — lang-markdown 키맵(Prec.high)보다 먼저
    Prec.highest(EditorView.domEventHandlers({
      keydown(e, view) {
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false
        // 한글 등 조합 중엔 keydown이 무력화됨 → 아래 updateListener가 결과 줄바꿈을 보고 처리.
        if (e.isComposing || e.keyCode === 229) return false
        if (!continueList(view)) return false
        e.preventDefault()
        return true
      },
    })),

    // Tab / Shift+Tab: 번호 목록 줄은 단계를 옮기면서 번호를 다시 매긴다.
    // NoteEditor 키맵의 indentWithTab 이 Tab 을 먼저 가져가서 예전 처리기는 한 번도
    // 돌지 않았다 (들여써도 번호가 3. 그대로). 그래서 키맵으로, 더 높은 우선순위로 건다.
    // 번호 목록이 아닌 줄은 false → indentWithTab 이 평소대로 들여쓴다.
    Prec.highest(keymap.of([
      { key: 'Tab', run: v => shiftListCommand(v, 1) },
      { key: 'Shift-Tab', run: v => shiftListCommand(v, -1) },
    ])),

    // "타이핑으로 줄바꿈이 삽입돼 새 빈 줄로 커서가 이동" + 윗줄이 리스트면 마커 이어붙임.
    // (한글 조합-Enter처럼 keydown이 안 잡히는 경우를 결과 기반으로 처리 → 이중 없이 한 번만)
    EditorView.updateListener.of((u) => {
      if (contApplying || !u.docChanged) return
      const sel = u.state.selection.main
      if (!sel.empty) return
      const doc = u.state.doc
      const curLine = doc.lineAt(sel.head)
      // 커서가 새 빈 줄에 있어야 한다 (들여쓰기만 있을 수도). 줄 뒤에 글자가
      // 남아 있으면 줄 중간을 끊은 것이라 마커를 붙이지 않는다.
      if (curLine.text.trim() !== '' || curLine.number < 2) return
      // 타이핑(Enter/IME 확정)으로 줄바꿈이 삽입됐는지. 붙여넣기(input.paste)·
      // 드롭·노트 로드 같은 프로그램적 변경은 제외 — 줄바꿈으로 끝나는 텍스트를
      // 붙여넣으면 엉뚱하게 목록이 이어지던 문제.
      let inserted = false
      for (const tr of u.transactions) {
        if (!tr.docChanged || !tr.isUserEvent('input.type')) continue
        tr.changes.iterChanges((_fA, _tA, _fB, _tB, ins) => {
          if (ins.toString().includes('\n')) inserted = true
        })
      }
      if (!inserted) return
      const marker = continuationMarker(doc.line(curLine.number - 1).text)
      if (!marker) return
      const at = sel.head
      contApplying = true
      Promise.resolve().then(() => {
        contApplying = false
        u.view.dispatch({
          changes: { from: at, insert: marker },
          selection: { anchor: at + marker.length },
          userEvent: 'input.listcont',
        })
      })
    }),
  ]
}

let contApplying = false

interface ListMarker {
  /** 줄 맨 앞부터 마커 끝(공백 포함)까지의 길이 */
  end: number
  /** 다음 줄에 넣을 마커 (들여쓰기 포함) */
  next: string
  /** 마커 뒤 내용 */
  content: string
}

/**
 * 리스트/태스크 줄의 마커를 읽는다. NotePlan 규칙:
 *   `1. ` → `2. ` / `- [ ]`·`- [x]`·`- [-]`·`- [>]`·`* ` (태스크) → `- [ ] `
 *   `+ `·`+ [x] ` (체크리스트) → `+ ` / `- ` (불릿) → `- `
 */
function parseListMarker(text: string): ListMarker | null {
  let m: RegExpMatchArray | null
  if ((m = text.match(/^(\s*)(\d+)\.\s/))) return { end: m[0].length, next: `${m[1]}${parseInt(m[2], 10) + 1}. `, content: text.slice(m[0].length) }
  if ((m = text.match(/^(\s*)- \[[ xX\->]\]\s/))) return { end: m[0].length, next: `${m[1]}- [ ] `, content: text.slice(m[0].length) }
  if ((m = text.match(/^(\s*)\*\s/))) return { end: m[0].length, next: `${m[1]}- [ ] `, content: text.slice(m[0].length) }
  if ((m = text.match(/^(\s*)\+\s(?:\[[xX ]\]\s)?/))) return { end: m[0].length, next: `${m[1]}+ `, content: text.slice(m[0].length) }
  if ((m = text.match(/^(\s*)-\s/)) && !/^\s*- \[/.test(text)) return { end: m[0].length, next: `${m[1]}- `, content: text.slice(m[0].length) }
  return null
}

/** 리스트 줄 텍스트 → 다음 줄에 이어붙일 마커 (내용 있는 항목만). 없으면 null. */
function continuationMarker(text: string): string | null {
  const mk = parseListMarker(text)
  return mk && mk.content.trim() ? mk.next : null
}

/** 코드 블록 안이면 목록 규칙을 적용하지 않는다 */
function inCode(view: EditorView, pos: number): boolean {
  let n = syntaxTree(view.state).resolveInner(pos, -1)
  for (;;) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'HTMLBlock') return true
    if (!n.parent) return false
    n = n.parent
  }
}

/**
 * 리스트/태스크 줄에서 Enter → 같은 타입 줄 이어가기. 처리했으면 true.
 * 처리하지 않는 경우(false → lang-markdown·기본 Enter로 넘어감):
 *   선택 영역이 있음 / 커서가 마커 안쪽 / 목록 줄이 아님 / 코드 블록 안
 */
function continueList(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length > 1) return false
  const { from, empty } = state.selection.main
  if (!empty) return false
  const line = state.doc.lineAt(from)
  const mk = parseListMarker(line.text)
  if (!mk) return false
  const offset = from - line.from
  if (offset < mk.end) return false
  if (inCode(view, from)) return false

  // 마커만 있는 빈 항목 → 마커를 지우고 목록 종료 (커서는 그 줄에 남는다)
  if (!mk.content.trim()) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'delete',
      scrollIntoView: true,
    })
    return true
  }

  // 커서 뒤 글자는 새 항목의 내용으로 내려간다 (앞 공백은 정리)
  const after = line.text.slice(offset)
  const lead = after.length - after.trimStart().length
  const insert = `\n${mk.next}`
  view.dispatch({
    changes: { from, to: from + lead, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input.type',
    scrollIntoView: true,
  })
  return true
}

/**
 * 선택한 줄들에 번호 목록 줄이 있으면 한 단계 들이거나 내어쓰고 번호를 다시 매긴다.
 * 번호 목록 줄이 없으면 false (기본 들여쓰기로 넘어감).
 */
function shiftListCommand(view: EditorView, dir: 1 | -1): boolean {
  // 한글 조합 중에 문서를 바꾸면 조합이 깨진다 → 조합이 끝난 뒤에 처리
  if (view.composing) {
    const started = Date.now()
    const retry = () => {
      if (view.composing && Date.now() - started < 1000) { setTimeout(retry, 16); return }
      if (!shiftList(view, dir)) (dir > 0 ? indentMore : indentLess)(view)
    }
    setTimeout(retry, 0)
    return true
  }
  return shiftList(view, dir)
}

function shiftList(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view
  const doc = state.doc
  let first = Infinity, last = -1
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number
    // 선택 끝이 줄 맨 앞이면 그 줄은 빼고 (여러 줄을 끌어 선택했을 때 흔함)
    let bLine = doc.lineAt(r.to)
    if (!r.empty && r.to === bLine.from && bLine.number > a) bLine = doc.line(bLine.number - 1)
    first = Math.min(first, a)
    last = Math.max(last, bLine.number)
  }
  if (inCode(view, doc.line(first).from)) return false

  // 아래쪽 다시 매기기를 위해 목록이 끝나는 곳(빈 줄)까지만 본다
  const winEnd = (() => {
    for (let n = last + 1; n <= doc.lines; n++) if (!doc.line(n).text.trim()) return n - 1
    return doc.lines
  })()
  const winStart = (() => {
    for (let n = first - 1; n >= 1; n--) if (!doc.line(n).text.trim()) return n + 1
    return 1
  })()
  const before: string[] = []
  for (let n = winStart; n <= winEnd; n++) before.push(doc.line(n).text)

  const after = shiftListLines(before, first - winStart, last - winStart, dir, {
    unit: indentString(state, getIndentUnit(state)),
    tabSize: state.tabSize,
  })
  if (!after) return false

  // 바뀐 부분만 바꿔서 커서·선택이 내용 기준으로 그대로 따라오게
  const changes: ChangeSpec[] = []
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i]
    if (a === b) continue
    let p = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    let s = 0
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
    const line = doc.line(winStart + i)
    changes.push({ from: line.from + p, to: line.from + a.length - s, insert: b.slice(p, b.length - s) })
  }
  if (!changes.length) return true
  const cs = state.changes(changes)
  view.dispatch({
    changes: cs,
    selection: EditorSelection.create(
      state.selection.ranges.map(r => {
        // 줄 맨 앞(마커 앞)의 커서는 마커 뒤로 — 들여쓴 공백 앞에 남지 않게
        const line = doc.lineAt(r.head)
        const atStart = r.empty && r.head <= line.from + (line.text.match(/^\s*\S+\s/)?.[0].length ?? 0)
        if (atStart) {
          const nl = cs.mapPos(line.from, -1)
          const nt = after[line.number - winStart] ?? ''
          const m = nt.match(/^\s*\S+\s/)
          return EditorSelection.cursor(nl + (m ? m[0].length : 0))
        }
        return r.map(cs, 1)
      }),
      state.selection.mainIndex,
    ),
    userEvent: dir > 0 ? 'input.indent' : 'delete.dedent',
    scrollIntoView: true,
  })
  return true
}
