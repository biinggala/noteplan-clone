import { EditorView } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

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
 * Tab / Shift+Tab:
 *   숫자 리스트 줄에서 Tab → 2칸 들여쓰기 + 번호를 1.로 리셋
 *   숫자 리스트 줄에서 Shift+Tab → 2칸 내어쓰기 + 번호를 1.로 리셋
 *   불릿/태스크 줄에서 Tab → 2칸 들여쓰기
 *   불릿/태스크 줄에서 Shift+Tab → 2칸 내어쓰기
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

    // Tab / Shift+Tab
    EditorView.domEventHandlers({
      keydown(e, view) {
        const isTab = e.key === 'Tab' && !e.metaKey && !e.ctrlKey
        if (!isTab) return false

        const { from } = view.state.selection.main
        const line = view.state.doc.lineAt(from)
        const text = line.text

        // ── Tab / Shift+Tab ────────────────────────────────────────────
        {
          const numberedList = text.match(/^(\s*)(\d+)\.\s/)
          const bulletTask  = text.match(/^(\s*)(- (\[.?\] )?|\+ )/)

          if (numberedList || bulletTask) {
            e.preventDefault()
            const currentIndent = (numberedList ?? bulletTask)![1]

            if (!e.shiftKey) {
              // Indent: add 2 spaces
              if (numberedList) {
                // reset numbering to 1.
                const after = text.slice(numberedList[0].length)
                const newLine = `${currentIndent}  1. ${after}`
                const newCursorOffset = from - line.from - numberedList[0].length + newLine.length - after.length
                view.dispatch({
                  changes: { from: line.from, to: line.to, insert: newLine },
                  selection: { anchor: line.from + Math.max(0, newCursorOffset) },
                  userEvent: 'input.type',
                })
              } else {
                // bullets/tasks: just indent
                view.dispatch({
                  changes: { from: line.from, to: line.from, insert: '  ' },
                  selection: { anchor: from + 2 },
                  userEvent: 'input.type',
                })
              }
            } else {
              // Shift+Tab: remove up to 2 leading spaces
              const removeCount = Math.min(2, currentIndent.length)
              if (removeCount === 0) return true
              if (numberedList) {
                const after = text.slice(numberedList[0].length)
                const newIndent = currentIndent.slice(removeCount)
                const newLine = `${newIndent}1. ${after}`
                const newCursorOffset = line.from + newLine.length - after.length
                view.dispatch({
                  changes: { from: line.from, to: line.to, insert: newLine },
                  selection: { anchor: newCursorOffset },
                  userEvent: 'input.type',
                })
              } else {
                view.dispatch({
                  changes: { from: line.from, to: line.from + removeCount, insert: '' },
                  selection: { anchor: Math.max(line.from, from - removeCount) },
                  userEvent: 'input.type',
                })
              }
            }
            return true
          }
          return false
        }
      },
    }),

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
