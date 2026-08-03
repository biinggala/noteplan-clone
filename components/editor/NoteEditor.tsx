'use client'
import { useEffect, useRef, useCallback } from 'react'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { noteplanTheme } from './extensions/theme'
import { taskCheckboxExtension, taskLineStyleExtension } from './extensions/taskCheckbox'
import { tagMentionExtension } from './extensions/tagMention'
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
import { mdTableExtension } from './extensions/mdTable'
import type { LinkTarget } from '@/lib/db/noteRepository'

interface NoteEditorProps {
  content: string
  onChange: (content: string) => void
  onSave?: () => void
  /** [[링크]] 클릭 시 해당 제목의 노트로 이동 */
  onOpenWikiLink?: (title: string) => void
  /** [[ 자동완성 후보 (노트 제목 목록) */
  linkTargets?: LinkTarget[]
}

export default function NoteEditor({ content, onChange, onSave, onOpenWikiLink, linkTargets }: NoteEditorProps) {
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

  useEffect(() => {
    if (!containerRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString())
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
              onSave?.()
              return true
            },
          },
        ]),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
        }),
        noteplanTheme,
        taskLineStyleExtension(),
        taskCheckboxExtension(),
        tagMentionExtension(),
        ...wikiLinkExtension(title => onOpenWikiLinkRef.current?.(title)),
        // 자동완성은 한 번만 등록하고 소스를 나열한다
        // ([[ 노트링크 + / 요소삽입). 여러 번 등록하면 설정이 충돌해 한쪽이 죽음.
        autocompletion({
          override: [
            wikiLinkCompletionSource(() => linkTargetsRef.current),
            slashInsertSource(),
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

  // 외부에서 content가 바뀔 때만 동기화 (예: 노트 전환)
  const lastContentRef = useRef(content)
  useEffect(() => {
    if (!viewRef.current) return
    const currentDoc = viewRef.current.state.doc.toString()
    if (content !== currentDoc && content !== lastContentRef.current) {
      viewRef.current.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      })
    }
    lastContentRef.current = content
  }, [content])

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-auto h-full cm-editor-container"
    />
  )
}
