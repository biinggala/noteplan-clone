import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

export const noteplanTheme = [
  EditorView.theme({
    '&': {
      height: '100%',
      fontSize: '15px',
      fontFamily: 'var(--font-editor)',
      background: 'transparent',
      color: 'var(--text-primary)',
    },
    '.cm-content': {
      padding: '32px 48px 32px 6px',
      maxWidth: '780px',
      margin: '0 auto',
      caretColor: 'var(--accent)',
    },
    '.cm-line': {
      lineHeight: '1.8',
      padding: '1px 0',
    },
    '.cm-activeLine': {
      background: 'var(--cm-activeline)',
      borderRadius: '4px',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--accent)',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, ::selection': {
      background: 'color-mix(in srgb, var(--accent) 25%, transparent) !important',
    },
    '.cm-gutters': {
      background: 'transparent',
      border: 'none',
      color: 'var(--text-muted)',
      fontSize: '12px',
      paddingRight: '8px',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 4px',
      minWidth: '36px',
    },
    '.cm-task-open':      { color: 'var(--text-primary)' },
    '.cm-task-done':      { color: 'var(--text-muted)', textDecoration: 'line-through' },
    '.cm-task-cancelled': { color: 'var(--text-muted)', opacity: '0.55', textDecoration: 'line-through' },
    '.cm-task-scheduled': { color: '#a78bfa' },
    '.cm-checklist':      { color: 'var(--text-primary)' },

    '.cm-tag':           { color: '#60a5fa', fontWeight: '500' },
    '.cm-mention':       { color: '#a78bfa', fontWeight: '500' },
    '.cm-underline':     { textDecoration: 'underline', textUnderlineOffset: '2px' },
    '.cm-wikilink':      { color: '#34d399', textDecoration: 'underline', cursor: 'pointer' },
    '.cm-schedule-date': { color: '#f59e0b', fontSize: '0.85em', fontStyle: 'italic' },

    '.cm-formatting-heading':       { color: 'var(--cm-formatting) !important', fontWeight: '400 !important', fontSize: '1em !important' },
    '.cm-formatting-strong':        { color: 'var(--cm-formatting) !important' },
    '.cm-formatting-em':            { color: 'var(--cm-formatting) !important' },
    '.cm-formatting-strikethrough': { color: 'var(--cm-formatting) !important' },
    '.cm-formatting-code':          { color: 'var(--cm-formatting) !important' },
    '.cm-formatting-list':          { color: 'var(--cm-formatting) !important' },
    '.cm-formatting-link':          { color: 'var(--cm-formatting) !important' },
    '.cm-formatting-quote':         { color: 'var(--cm-formatting) !important' },

    '.cm-hr': { color: 'var(--cm-formatting)', letterSpacing: '4px' },

    '.cm-line.cm-setext-header':     { lineHeight: '1.8 !important' },
    '.cm-line.cm-setext-header span': {
      fontSize: '1em !important',
      fontWeight: 'normal !important',
      color: 'var(--text-primary) !important',
    },
    '.cm-line.cm-setext-header *': {
      fontSize: '1em !important',
      fontWeight: 'normal !important',
    },
    // setext 헤딩(아래 ---)이라도 태그/멘션/위키링크 색은 유지
    '.cm-line.cm-setext-header span.cm-tag':      { color: '#60a5fa !important' },
    '.cm-line.cm-setext-header span.cm-mention':  { color: '#a78bfa !important' },
    '.cm-line.cm-setext-header span.cm-wikilink': { color: '#34d399 !important' },
    '.cm-scroller': { overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },

    // ── 마크다운 표 (커서가 밖에 있을 때 렌더) ──────────────────────────
    '.cm-md-table-wrap': {
      margin: '10px 0',
      overflowX: 'auto',
      cursor: 'text',
    },
    '.cm-md-table': {
      borderCollapse: 'collapse',
      width: '100%',
      fontSize: '0.95em',
      lineHeight: '1.5',
    },
    '.cm-md-table th, .cm-md-table td': {
      border: '1px solid var(--border)',
      padding: '6px 10px',
      verticalAlign: 'top',
    },
    '.cm-md-table th': {
      fontWeight: '650',
      color: 'var(--text-primary)',
      backgroundColor: 'var(--cm-code-bg)',
      whiteSpace: 'nowrap',
    },
    '.cm-md-table td': { color: 'var(--text-secondary)' },
    '.cm-md-table tbody tr:hover td': { backgroundColor: 'var(--cm-activeline)' },
    // 셀은 그 자리에서 바로 편집되는 contentEditable
    '.cm-tcell': {
      outline: 'none',
      minHeight: '1.4em',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    },
    '.cm-tcell:focus': {
      boxShadow: 'inset 0 0 0 2px var(--accent)',
      borderRadius: '2px',
    },
    // 행/열 추가·삭제 버튼 — 표 위에 마우스를 올렸을 때만 드러난다
    '.cm-md-table-toolbar': {
      display: 'flex',
      gap: '4px',
      marginTop: '4px',
      opacity: '0',
      transition: 'opacity 120ms ease',
    },
    '.cm-md-table-wrap:hover .cm-md-table-toolbar, .cm-md-table-wrap:focus-within .cm-md-table-toolbar': {
      opacity: '1',
    },
    '.cm-md-table-btn': {
      font: 'inherit',
      fontSize: '11px',
      lineHeight: '1',
      padding: '4px 8px',
      cursor: 'pointer',
      color: 'var(--text-muted)',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: '5px',
    },
    '.cm-md-table-btn:hover': { color: 'var(--text-primary)' },
    '.cm-md-table-btn-danger:hover': { color: '#ef4444', borderColor: '#ef4444' },

    // ── [[ 자동완성 드롭다운 ────────────────────────────────────────────
    // CodeMirror 기본 스타일(흰 배경 + 시스템 폰트)이 테마와 전혀 안 맞아서 새로 입힘
    '.cm-tooltip.cm-tooltip-autocomplete': {
      backgroundColor: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
      overflow: 'hidden',
      padding: '4px',
      marginTop: '4px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-editor)',
      fontSize: '13px',
      maxHeight: '18em',
      margin: '0',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      padding: '6px 10px',
      borderRadius: '6px',
      lineHeight: '1.4',
      color: 'var(--text-primary)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)',
      color: 'var(--accent)',
    },
    '.cm-completionLabel': { flex: '1 1 auto', minWidth: '0' },
    // 입력한 글자와 일치하는 부분 강조
    '.cm-completionMatchedText': {
      textDecoration: 'none',
      fontWeight: '700',
      color: 'var(--accent)',
    },
    'li[aria-selected] .cm-completionMatchedText': { color: 'inherit' },
    // 폴더 경로 / 피참조 수(↩N)
    '.cm-completionDetail': {
      flex: '0 0 auto',
      fontStyle: 'normal',
      fontSize: '11px',
      opacity: '0.6',
      maxWidth: '45%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  }),

  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.heading1, fontSize: '1.75em', fontWeight: '700', color: 'var(--cm-h1)', lineHeight: '1.3' },
      { tag: tags.heading2, fontSize: '1.35em', fontWeight: '600', color: 'var(--cm-h2)' },
      { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600', color: 'var(--cm-h3)' },
      { tag: tags.heading4, fontSize: '1.05em', fontWeight: '600', color: 'var(--cm-h3)' },

      { tag: tags.strong,        fontWeight: '700', color: 'var(--cm-strong)' },
      { tag: tags.emphasis,      fontStyle: 'italic', color: 'var(--cm-em)' },
      { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },

      {
        tag: tags.monospace,
        fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: '0.9em',
        background: 'var(--cm-code-bg)',
        borderRadius: '3px',
        padding: '1px 4px',
        color: 'var(--cm-code-fg)',
      },

      { tag: tags.link,              color: 'var(--accent)', textDecoration: 'underline' },
      { tag: tags.url,               color: 'var(--accent)', opacity: '0.7' },
      { tag: tags.quote,             color: 'var(--text-muted)', fontStyle: 'italic' },
      { tag: tags.contentSeparator,  color: 'var(--cm-formatting)' },
      { tag: tags.comment,           color: 'var(--text-muted)', fontStyle: 'italic' },
      { tag: tags.meta,              color: 'var(--cm-formatting)' },
      { tag: tags.processingInstruction, color: 'var(--cm-formatting)' },
    ])
  ),
]
