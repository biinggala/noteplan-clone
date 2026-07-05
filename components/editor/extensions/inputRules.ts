import { EditorView } from '@codemirror/view'

/**
 * NotePlan 입력 규칙:
 *   "* " (줄 시작) → "- [ ] " (오픈 태스크)
 *   "+ " (줄 시작) → 그대로 유지, checklist 위젯이 처리
 *   "- " (줄 시작) → 그대로 유지 (일반 불릿)
 *
 * Enter 자동 계속:
 *   태스크/체크리스트/불릿/숫자 줄에서 Enter → 같은 타입 줄 계속
 *   빈 태스크 줄에서 Enter → 해당 줄 삭제 (목록 종료)
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

    // Tab / Shift+Tab + Enter: list continuation
    EditorView.domEventHandlers({
      keydown(e, view) {
        const isEnter = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey
        const isTab = e.key === 'Tab' && !e.metaKey && !e.ctrlKey
        if (!isEnter && !isTab) return false

        const { from } = view.state.selection.main
        const line = view.state.doc.lineAt(from)
        const text = line.text

        // ── Tab / Shift+Tab ────────────────────────────────────────────
        if (isTab) {
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

        // ── Enter (영문) ────────────────────────────────────────────────
        // 한글 등 조합 중엔 keydown이 무력화됨 → 아래 updateListener가 결과 줄바꿈을 보고 처리.
        if (e.isComposing || e.keyCode === 229) return false
        return continueList(view)
      },
    }),

    // 이벤트 소스 무관하게, "줄바꿈이 삽입돼 새 빈 줄로 커서가 이동" + 윗줄이 리스트면 마커 이어붙임.
    // (한글 조합-Enter처럼 keydown이 안 잡히는 경우를 결과 기반으로 처리 → 이중 없이 한 번만)
    EditorView.updateListener.of((u) => {
      if (contApplying || !u.docChanged) return
      const sel = u.state.selection.main
      if (!sel.empty) return
      const doc = u.state.doc
      const curLine = doc.lineAt(sel.head)
      if (sel.head !== curLine.from || curLine.number < 2) return
      let inserted = false
      for (const tr of u.transactions) {
        if (!tr.isUserEvent('input')) continue
        tr.changes.iterChanges((_fA, _tA, _fB, tB, ins) => {
          if (tB === sel.head && ins.toString().endsWith('\n')) inserted = true
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

/** 리스트 줄 텍스트 → 다음 줄에 이어붙일 마커 (내용 있는 항목만). 없으면 null. */
function continuationMarker(text: string): string | null {
  let m: RegExpMatchArray | null
  if ((m = text.match(/^(\s*)(\d+)\.\s(.+)$/))) return `${m[1]}${parseInt(m[2]) + 1}. `
  if ((m = text.match(/^(\s*)- \[[ x\->]\]\s(.+)$/i))) return `${m[1]}- [ ] `
  if ((m = text.match(/^(\s*)\+\s(.+)$/))) return `${m[1]}+ `
  if (!/^\s*- \[/.test(text) && (m = text.match(/^(\s*)-\s(.+)$/))) return `${m[1]}- `
  return null
}

/** 리스트/태스크 줄에서 Enter → 같은 타입 줄 이어가기. 처리했으면 true. */
function continueList(view: EditorView): boolean {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const text = line.text

  // Numbered list continuation
  const numberedList = text.match(/^(\s*)(\d+)\.\s(.*)$/)
  if (numberedList) {
    const indent = numberedList[1] ?? ''
    const num    = parseInt(numberedList[2] ?? '1', 10)
    const content = numberedList[3] ?? ''
    if (!content.trim()) {
      view.dispatch({ changes: { from: line.from, to: from, insert: '' }, userEvent: 'input.type' })
      return true
    }
    const next = `\n${indent}${num + 1}. `
    view.dispatch({ changes: { from, to: from, insert: next }, selection: { anchor: from + next.length }, userEvent: 'input.type' })
    return true
  }

  // Open task continuation
  const openTask = text.match(/^(\s*)- \[ \] (.*)$/)
  if (openTask) {
    const indent = openTask[1] ?? ''
    const content = openTask[2] ?? ''
    if (!content.trim()) {
      view.dispatch({ changes: { from: line.from, to: from, insert: '' }, userEvent: 'input.type' })
      return true
    }
    view.dispatch({ changes: { from, to: from, insert: `\n${indent}- [ ] ` }, selection: { anchor: from + indent.length + 7 }, userEvent: 'input.type' })
    return true
  }

  // Checklist continuation
  const checklist = text.match(/^(\s*)\+ (.*)$/)
  if (checklist) {
    const indent = checklist[1] ?? ''
    const content = checklist[2] ?? ''
    if (!content.trim()) {
      view.dispatch({ changes: { from: line.from, to: from, insert: '' }, userEvent: 'input.type' })
      return true
    }
    view.dispatch({ changes: { from, to: from, insert: `\n${indent}+ ` }, selection: { anchor: from + indent.length + 3 }, userEvent: 'input.type' })
    return true
  }

  // Regular bullet continuation (- text)
  const bullet = text.match(/^(\s*)- (.*)$/)
  if (bullet && !/^\s*- \[/.test(text)) {
    const indent = bullet[1] ?? ''
    const content = bullet[2] ?? ''
    if (!content.trim()) {
      view.dispatch({ changes: { from: line.from, to: from, insert: '' }, userEvent: 'input.type' })
      return true
    }
    view.dispatch({ changes: { from, to: from, insert: `\n${indent}- ` }, selection: { anchor: from + indent.length + 3 }, userEvent: 'input.type' })
    return true
  }

  return false
}
