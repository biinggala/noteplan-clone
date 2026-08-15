/**
 * 노트 안의 웹 주소를 ⌘(Ctrl)+클릭으로 브라우저에서 열기.
 *
 * 그냥 클릭으로 열지 않는 이유: 에디터라서 링크 위를 클릭해 커서를 놓는 일이
 * 훨씬 잦다. 편집을 방해하지 않도록 ⌘를 눌렀을 때만 링크로 동작한다
 * (VS Code·Obsidian과 같은 규칙).
 *
 * 대상:
 *   - 맨 URL            https://example.com
 *   - 마크다운 링크     [보기](https://example.com)  ← 글자 어디를 눌러도 열림
 */
import {
  EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate,
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { openExternal } from '@/lib/openExternal'

// 마크다운 링크가 먼저다 — 맨 URL 규칙이 괄호 안 주소를 따로 잡아가면
// 링크 글자 부분이 클릭 영역에서 빠진다.
const MD_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL = /https?:\/\/[^\s<>()[\]{}"'`]+/g

/** 문장 끝 문장부호가 URL에 붙어 들어가는 것 방지 */
function trimTrailing(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

export interface UrlHit {
  from: number
  to: number
  url: string
}

/** 한 줄에서 링크 영역들을 찾아낸다 (문서 기준 절대 위치) */
export function findUrlsInLine(text: string, lineStart: number): UrlHit[] {
  const hits: UrlHit[] = []
  const taken: [number, number][] = []

  MD_LINK.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MD_LINK.exec(text))) {
    hits.push({ from: lineStart + m.index, to: lineStart + m.index + m[0].length, url: m[2] })
    taken.push([m.index, m.index + m[0].length])
  }

  BARE_URL.lastIndex = 0
  while ((m = BARE_URL.exec(text))) {
    // 마크다운 링크 안에 이미 포함된 주소는 건너뛴다
    if (taken.some(([s, e]) => m!.index >= s && m!.index < e)) continue
    const url = trimTrailing(m[0])
    if (!url) continue
    hits.push({ from: lineStart + m.index, to: lineStart + m.index + url.length, url })
  }

  return hits.sort((a, b) => a.from - b.from)
}

/** 문서 위치 pos 에 걸린 링크 (없으면 null) */
export function urlAtPos(view: EditorView, pos: number): UrlHit | null {
  const line = view.state.doc.lineAt(pos)
  for (const hit of findUrlsInLine(line.text, line.from)) {
    if (pos >= hit.from && pos <= hit.to) return hit
  }
  return null
}

const linkMark = Decoration.mark({ class: 'cm-ext-link' })

const decorate = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = this.build(view) }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      for (const { from, to } of view.visibleRanges) {
        let pos = from
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos)
          for (const hit of findUrlsInLine(line.text, line.from)) {
            if (hit.to > hit.from) builder.add(hit.from, hit.to, linkMark)
          }
          pos = line.to + 1
        }
      }
      return builder.finish()
    }
  },
  { decorations: v => v.decorations },
)

/** ⌘/Ctrl 을 누르고 있는 동안만 링크처럼(손가락 커서) 보이게 한다 */
const modKeyTracking = ViewPlugin.fromClass(
  class {
    private held = false
    constructor(private view: EditorView) {
      window.addEventListener('keydown', this.onKey)
      window.addEventListener('keyup', this.onKey)
      window.addEventListener('blur', this.clear)
    }
    onKey = (e: KeyboardEvent) => this.set(e.metaKey || e.ctrlKey)
    clear = () => this.set(false)
    set(next: boolean) {
      if (next === this.held) return
      this.held = next
      this.view.dom.classList.toggle('cm-mod-held', next)
    }
    destroy() {
      window.removeEventListener('keydown', this.onKey)
      window.removeEventListener('keyup', this.onKey)
      window.removeEventListener('blur', this.clear)
      this.view.dom.classList.remove('cm-mod-held')
    }
  },
)

const clickHandler = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos == null) return false
    const hit = urlAtPos(view, pos)
    if (!hit) return false
    // mousedown 단계에서 막아야 커서가 링크 위로 옮겨가지 않는다
    e.preventDefault()
    e.stopPropagation()
    void openExternal(hit.url)
    return true
  },
})

export function externalLinkExtension() {
  return [decorate, modKeyTracking, clickHandler]
}
