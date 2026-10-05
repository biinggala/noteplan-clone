'use client'
import { useEffect, useRef, useCallback } from 'react'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { EditorState, Transaction } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { noteplanTheme } from './extensions/theme'
import { taskCheckboxExtension, taskLineStyleExtension } from './extensions/taskCheckbox'
import { tagMentionExtension, facetClickExtension } from './extensions/tagMention'
import { wikiLinkExtension } from './extensions/wikiLink'
import { scheduleDateExtension } from './extensions/scheduleDate'
import { inputRulesExtension } from './extensions/inputRules'
import { markdownWYSIWYGExtension } from './extensions/markdownWYSIWYG'
import { dragHandleExtension } from './extensions/dragHandle'
import { hrRuleExtension } from './extensions/hrRule'
import { markdownShortcuts, underlineExtension } from './extensions/markdownShortcuts'
import { hangingIndentExtension } from './extensions/hangingIndent'
import { autocompletion } from '@codemirror/autocomplete'
import { wikiLinkCompletionSource } from './extensions/wikiLinkComplete'
import { slashInsertSource } from './extensions/slashInsert'
import { tagMentionCompletionSource } from './extensions/tagMentionComplete'
import { mdTableExtension } from './extensions/mdTable'
import { externalLinkExtension } from './extensions/externalLink'
import { selectionMenuExtension } from './extensions/selectionMenu'
import type { LinkTarget, FacetItem } from '@/lib/db/noteRepository'

interface NoteEditorProps {
  content: string
  onChange: (content: string) => void
  onSave?: () => void
  /** [[링크]] 클릭 시 해당 제목의 노트로 이동 */
  onOpenWikiLink?: (title: string) => void
  /** [[ 자동완성 후보 (노트 제목 목록) */
  linkTargets?: LinkTarget[]
  /** #태그 / @멘션 자동완성 후보 */
  facets?: { tags: FacetItem[]; mentions: FacetItem[] }
  /** #태그 / @멘션 ⌘+클릭 → 그 태그의 검색 결과 */
  onOpenFacet?: (kind: 'tag' | 'mention', value: string) => void
  /** 선택 영역을 독립 노트로 승격. 새 노트 제목을 돌려주면 [[링크]]로 교체된다 */
  onPromote?: (text: string) => Promise<string | null>
}

const EMPTY_FACETS = { tags: [] as FacetItem[], mentions: [] as FacetItem[] }

export default function NoteEditor({ content, onChange, onSave, onOpenWikiLink, linkTargets, facets, onOpenFacet, onPromote }: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // 에디터는 최초 1회만 생성되므로(아래 useEffect deps=[]), 이후 갱신되는 값들은
  // ref를 통해 읽어야 stale closure를 피할 수 있다.
  const onOpenWikiLinkRef = useRef(onOpenWikiLink)
  onOpenWikiLinkRef.current = onOpenWikiLink
  const linkTargetsRef = useRef<LinkTarget[]>(linkTargets ?? [])
  linkTargetsRef.current = linkTargets ?? []
  const facetsRef = useRef(facets ?? EMPTY_FACETS)
  facetsRef.current = facets ?? EMPTY_FACETS
  const onOpenFacetRef = useRef(onOpenFacet)
  onOpenFacetRef.current = onOpenFacet
  const onPromoteRef = useRef(onPromote)
  onPromoteRef.current = onPromote
  // ⌘S 도 ref 로 — 에디터는 한 번만 만들어지므로, 그때 받은 onSave 를 그대로
  // 쓰면 '처음 연 시점의 노트'를 저장해 그 뒤 고친 내용이 사라졌다.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  // 이 에디터가 마지막으로 onChange 로 내보낸 내용 — content prop 이 이 값이면
  // 내 입력의 메아리라 되돌려 적용하지 않는다.
  const lastEmittedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const text = update.state.doc.toString()
        lastEmittedRef.current = text
        onChangeRef.current(text)
      }
    })

    const startState = EditorState.create({
      doc: content,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([
          ...markdownShortcuts,   // Cmd+B/I/U (defaultKeymap보다 먼저 → 우선)
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            key: 'Mod-s',
            run: () => {
              onSaveRef.current?.()
              return true
            },
          },
        ]),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          // setext 헤딩(윗줄 텍스트 + 아랫줄 --- 를 제목으로 치는 문법)을 끈다.
          //
          // 이게 켜져 있으면 "Notes" 아래에 목록을 쓰려고 '-' 를 치는 순간
          // 마크다운 규칙상 윗줄이 제목이 돼버린다. 스페이스를 눌러 '- ' 가
          // 되면 다시 목록으로 풀리므로, 타이핑 중에 위아래 줄 서식이
          // 번쩍거렸다. 지금까지는 CSS로 폰트만 덮어썼는데, 파서는 그대로
          // 제목을 만들고 있어서 깜빡임이 남았다.
          //
          // 이 노트앱에서 제목은 '#' 로만 쓴다. '---' 는 수평선으로 남는다
          // (HorizontalRule은 별도 파서라 영향 없음).
          extensions: [{ remove: ['SetextHeading'] }],
        }),
        noteplanTheme,
        taskLineStyleExtension(),
        taskCheckboxExtension(),
        tagMentionExtension(),
        facetClickExtension((kind, value) => onOpenFacetRef.current?.(kind, value)),
        ...wikiLinkExtension(title => onOpenWikiLinkRef.current?.(title)),
        // 자동완성은 한 번만 등록하고 소스를 나열한다
        // ([[ 노트링크 + / 요소삽입 + #태그/@멘션).
        // 여러 번 등록하면 설정이 충돌해 한쪽이 죽음.
        autocompletion({
          override: [
            wikiLinkCompletionSource(() => linkTargetsRef.current),
            slashInsertSource(),
            tagMentionCompletionSource(() => facetsRef.current),
          ],
          icons: false,
          closeOnBlur: true,
          activateOnTyping: true,
        }),
        scheduleDateExtension(),
        ...inputRulesExtension(),
        ...markdownWYSIWYGExtension(),
        underlineExtension(),
        hangingIndentExtension(),
        hrRuleExtension(),
        mdTableExtension(title => onOpenWikiLinkRef.current?.(title)),
        ...externalLinkExtension(),
        ...selectionMenuExtension(text => onPromoteRef.current?.(text) ?? Promise.resolve(null)),
        ...dragHandleExtension(),
        EditorView.lineWrapping,
        updateListener,
      ],
    })

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    })

    viewRef.current = view
    return () => view.destroy()
  }, []) // 의도적으로 content 제외 — 외부 변경시만 업데이트

  // 바깥에서 content 가 바뀌면(다른 기기·실시간 합치기·타임라인·버전 복원) 반영한다.
  //  - 문서 전체를 갈아끼우지 않고 달라진 가운데만 바꾼다 → 커서가 제자리에 남는다
  //    (예전엔 전체 교체라 커서가 맨 위로 튀고 WebKit 은 화면까지 맨 위로 스크롤했다).
  //  - 실행 취소 기록에 넣지 않는다 → ⌘Z 가 다른 기기의 수정을 되돌리지 않는다.
  //  - 한글 조합 중이면 조합이 끝난 뒤에 적용한다 (조합 중인 글자가 깨지지 않게).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (content === lastEmittedRef.current) return   // 내 입력의 메아리
    const apply = () => {
      const cur = view.state.doc.toString()
      if (content === cur) return
      const max = Math.min(cur.length, content.length)
      let a = 0
      while (a < max && cur.charCodeAt(a) === content.charCodeAt(a)) a++
      let b = 0
      while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === content.charCodeAt(content.length - 1 - b)) b++
      lastEmittedRef.current = content
      view.dispatch({
        changes: { from: a, to: cur.length - b, insert: content.slice(a, content.length - b) },
        annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
        scrollIntoView: false,
      })
    }
    if (!view.composing) { apply(); return }
    const dom = view.contentDOM
    const onEnd = () => setTimeout(apply, 0)
    dom.addEventListener('compositionend', onEnd, { once: true })
    return () => dom.removeEventListener('compositionend', onEnd)
  }, [content])

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-auto h-full cm-editor-container"
    />
  )
}
