import { EditorView, keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { wrapSelection } from './markdownShortcuts'

/**
 * 텍스트를 선택하고 우클릭하면 뜨는 메뉴.
 *
 * - 서식(굵게/기울임/…)은 Cmd+B 같은 단축키와 완전히 같은 명령을 부른다.
 *   markdownShortcuts의 wrapSelection을 그대로 쓰므로 토글 동작(이미 감싸져
 *   있으면 해제)도 동일하다. 여기서 따로 구현하면 둘이 어긋난다.
 *
 * - "원자로 승격"은 선택한 내용을 독립 노트로 빼내고 원래 자리엔 [[링크]]만
 *   남긴다. 데일리 노트는 그날 있었던 것들의 짬뽕이라, 오래 남을 생각도
 *   김치찌개와 같은 봉지에 묻히기 때문. 쓸 때는 시간순으로 쏟아붓되(그게
 *   사람이 실제로 쓰는 방식이므로) 나중에 의미 단위로 끌어올린다.
 *
 * ⚠️ 메뉴 DOM은 document.body에 붙는다. 스타일을 EditorView.theme()에 넣으면
 * 셀렉터가 에디터 내부로 스코프돼 하나도 안 먹는다 → globals.css에 있다.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl+'
const SHIFT = isMac ? '⇧' : 'Shift+'

interface MenuItem {
  label: string
  hint?: string
  run: (view: EditorView) => void
  /** 위에 구분선을 그린다 */
  divider?: boolean
}

export function selectionMenuExtension(
  onPromote: (text: string) => Promise<string | null>,
): Extension[] {
  async function promote(view: EditorView): Promise<void> {
    const { from, to } = view.state.selection.main
    if (from === to) return
    const text = view.state.sliceDoc(from, to)
    if (!text.trim()) return

    const title = await onPromote(text)
    if (!title) return   // 취소 — 문서는 그대로

    // 다이얼로그를 띄운 사이에 문서가 바뀌었을 수 있다(실시간 동기화 등).
    // 원래 자리의 내용이 그대로일 때만 교체한다.
    if (view.state.sliceDoc(from, to) !== text) {
      console.warn('[promote] 문서가 바뀌어 링크 치환을 건너뜀 — 노트는 생성됨')
      return
    }

    view.dispatch({
      changes: { from, to, insert: `[[${title}]]` },
      selection: { anchor: from + title.length + 4 },
    })
    view.focus()
  }

  const wrap = (open: string, close: string) => (v: EditorView) => {
    wrapSelection(open, close)(v)
    v.focus()
  }

  const ITEMS: MenuItem[] = [
    { label: '굵게',        hint: `${MOD}B`,         run: wrap('**', '**') },
    { label: '기울임',      hint: `${MOD}I`,         run: wrap('*', '*') },
    { label: '밑줄',        hint: `${MOD}U`,         run: wrap('<u>', '</u>') },
    { label: '취소선',      hint: `${MOD}${SHIFT}X`, run: wrap('~~', '~~') },
    { label: '인라인 코드', hint: `${MOD}E`,         run: wrap('`', '`') },
    { label: '원자로 승격', hint: `${MOD}${SHIFT}E`, run: v => { void promote(v) }, divider: true },
  ]

  let menuEl: HTMLElement | null = null
  const closeMenu = () => { menuEl?.remove(); menuEl = null }

  function openMenu(view: EditorView, x: number, y: number) {
    closeMenu()
    const menu = document.createElement('div')
    menu.className = 'cm-sel-menu'
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`

    for (const it of ITEMS) {
      if (it.divider) {
        const hr = document.createElement('div')
        hr.className = 'cm-sel-divider'
        menu.appendChild(hr)
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cm-sel-item'

      const label = document.createElement('span')
      label.textContent = it.label
      btn.appendChild(label)

      if (it.hint) {
        const hint = document.createElement('span')
        hint.className = 'cm-sel-hint'
        hint.textContent = it.hint
        btn.appendChild(hint)
      }

      // mousedown에서 preventDefault — 안 하면 선택이 풀린 뒤 명령이 돈다
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        closeMenu()
        it.run(view)
      })
      menu.appendChild(btn)
    }

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
      run: (view) => { void promote(view); return true },
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
