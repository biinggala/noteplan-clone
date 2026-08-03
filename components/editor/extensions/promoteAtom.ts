import { EditorView, keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * 선택한 줄을 독립된 노트("원자")로 빼내고, 원래 자리엔 [[링크]]만 남긴다.
 *
 * 데일리 노트는 그날 있었던 것들의 짬뽕이라, 오래 남을 생각도 김치찌개와
 * 같은 봉지에 묻힌다. 쓸 때는 시간순으로 쏟아붓되(그게 사람이 실제로 쓰는
 * 방식이므로), 나중에 의미 단위로 끌어올리는 흐름을 만든다.
 *
 * onPromote가 새 노트 제목을 돌려주면 선택 영역을 그 링크로 교체한다.
 * null이면(취소) 아무것도 하지 않는다.
 */
export function promoteAtomExtension(
  onPromote: (text: string) => Promise<string | null>,
): Extension[] {
  async function run(view: EditorView): Promise<boolean> {
    const { from, to } = view.state.selection.main
    if (from === to) return false
    const text = view.state.sliceDoc(from, to)
    if (!text.trim()) return false

    const title = await onPromote(text)
    if (!title) return true   // 취소 — 문서는 그대로

    // 다이얼로그를 띄운 사이에 문서가 바뀌었을 수 있다(실시간 동기화 등).
    // 원래 자리의 내용이 그대로일 때만 교체한다.
    if (view.state.sliceDoc(from, to) !== text) {
      console.warn('[promote] 문서가 바뀌어 링크 치환을 건너뜀 — 노트는 생성됨')
      return true
    }

    view.dispatch({
      changes: { from, to, insert: `[[${title}]]` },
      selection: { anchor: from + title.length + 4 },
    })
    view.focus()
    return true
  }

  let menuEl: HTMLElement | null = null
  const closeMenu = () => { menuEl?.remove(); menuEl = null }

  function openMenu(view: EditorView, x: number, y: number) {
    closeMenu()
    const menu = document.createElement('div')
    menu.className = 'cm-promote-menu'
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`

    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'cm-promote-item'
    item.textContent = '원자로 승격'
    item.addEventListener('mousedown', (e) => {
      e.preventDefault()
      closeMenu()
      void run(view)
    })
    menu.appendChild(item)

    document.body.appendChild(menu)
    menuEl = menu

    // 화면 밖으로 나가면 끌어당긴다
    const r = menu.getBoundingClientRect()
    if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`
    if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`

    const onAway = () => { closeMenu(); document.removeEventListener('mousedown', onAway) }
    setTimeout(() => document.addEventListener('mousedown', onAway), 0)
  }

  return [
    keymap.of([{
      key: 'Mod-Shift-e',
      preventDefault: true,
      run: (view) => { void run(view); return true },
    }]),
    EditorView.domEventHandlers({
      contextmenu(e, view) {
        // 선택 영역이 있을 때만 우리 메뉴를 띄운다.
        // 그 외에는 브라우저 기본 메뉴(붙여넣기·맞춤법 등)를 살려둔다.
        const { from, to } = view.state.selection.main
        if (from === to) return false
        if (!view.state.sliceDoc(from, to).trim()) return false
        e.preventDefault()
        openMenu(view, e.clientX, e.clientY)
        return true
      },
    }),
  ]
}

/** 선택한 텍스트에서 제목 후보를 뽑는다 (첫 줄에서 목록 기호·체크박스 제거) */
export function suggestAtomTitle(text: string): string {
  const first = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const bare = first
    .replace(/^#{1,6}\s+/, '')            // 헤딩
    .replace(/^[-*+]\s+\[[ x\-> ]\]\s*/i, '')  // 체크박스
    .replace(/^[-*+]\s+/, '')             // 불릿
    .replace(/^\d+\.\s+/, '')             // 번호 목록
    .replace(/^>\s*/, '')                 // 인용
    .replace(/^\d{1,2}:\d{2}\s*(AM|PM)?\s*-\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*/i, '') // 타임블록
    .trim()
  return bare.length > 60 ? bare.slice(0, 60).trimEnd() + '…' : bare
}
