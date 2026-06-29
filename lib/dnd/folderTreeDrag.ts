// FolderTree pointer-events 기반 드래그앤드롭 (WKWebView가 HTML5 DnD 미지원).
// 노트/폴더를 다른 폴더로 이동. 드롭 대상은 [data-folder-drop][data-folder-path] 요소.

export interface TreeDragItem {
  kind: 'note' | 'folder'
  id: string
  label: string
  path?: string   // folder일 때 자기 경로 (자손 드롭 방지용)
}

interface ActiveDrag {
  item: TreeDragItem
  startX: number
  startY: number
  ghost: HTMLElement | null
  dragging: boolean
  overEl: HTMLElement | null
  onMove: (item: TreeDragItem, targetPath: string) => void
  canDrop: (item: TreeDragItem, targetPath: string) => boolean
  move: (e: PointerEvent) => void
  up: (e: PointerEvent) => void
}

const THRESHOLD = 5
let active: ActiveDrag | null = null

export function startTreeDrag(
  e: React.PointerEvent,
  item: TreeDragItem,
  handlers: {
    onMove: (item: TreeDragItem, targetPath: string) => void
    canDrop: (item: TreeDragItem, targetPath: string) => boolean
  },
) {
  if (e.button !== 0) return
  if (active) cleanup()

  const move = (ev: PointerEvent) => {
    if (!active) return
    if (!active.dragging) {
      if (Math.abs(ev.clientX - active.startX) + Math.abs(ev.clientY - active.startY) < THRESHOLD) return
      active.dragging = true
      active.ghost = makeGhost(active.item)
    }
    active.ghost!.style.left = `${ev.clientX + 12}px`
    active.ghost!.style.top = `${ev.clientY + 12}px`
    setOver(findDropTarget(ev, active))
  }

  const up = (ev: PointerEvent) => {
    if (!active) return
    const drag = active
    const wasDragging = drag.dragging
    const target = wasDragging ? findDropTarget(ev, drag) : null
    cleanup()
    if (wasDragging) suppressNextClick()
    if (target) {
      const path = target.getAttribute('data-folder-path') ?? ''
      drag.onMove(drag.item, path)
    }
  }

  active = {
    item, startX: e.clientX, startY: e.clientY, ghost: null,
    dragging: false, overEl: null, onMove: handlers.onMove, canDrop: handlers.canDrop, move, up,
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

function findDropTarget(ev: PointerEvent, drag: ActiveDrag): HTMLElement | null {
  const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
  const drop = el?.closest('[data-folder-drop]') as HTMLElement | null
  if (!drop) return null
  const path = drop.getAttribute('data-folder-path') ?? ''
  return drag.canDrop(drag.item, path) ? drop : null
}

function setOver(el: HTMLElement | null) {
  if (!active || active.overEl === el) return
  active.overEl?.classList.remove('np-folder-drop-over')
  el?.classList.add('np-folder-drop-over')
  active.overEl = el
}

function makeGhost(item: TreeDragItem): HTMLElement {
  const g = document.createElement('div')
  g.className = 'np-tree-ghost'
  g.textContent = (item.kind === 'folder' ? '📁 ' : '📄 ') + item.label
  document.body.appendChild(g)
  return g
}

function cleanup() {
  if (!active) return
  window.removeEventListener('pointermove', active.move)
  window.removeEventListener('pointerup', active.up)
  window.removeEventListener('pointercancel', active.up)
  active.overEl?.classList.remove('np-folder-drop-over')
  active.ghost?.remove()
  active = null
}

// 드래그 직후 발생하는 click(폴더 토글/노트 열기) 1회 억제
function suppressNextClick() {
  const handler = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    window.removeEventListener('click', handler, true)
  }
  window.addEventListener('click', handler, true)
  setTimeout(() => window.removeEventListener('click', handler, true), 350)
}
