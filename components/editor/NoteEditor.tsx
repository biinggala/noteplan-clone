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

interface NoteEditorProps {
  content: string
  onChange: (content: string) => void
  onSave?: () => void
}

export default function NoteEditor({ content, onChange, onSave }: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

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
        wikiLinkExtension(),
        scheduleDateExtension(),
        ...inputRulesExtension(),
        ...markdownWYSIWYGExtension(),
        underlineExtension(),
        hrRuleExtension(),
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
