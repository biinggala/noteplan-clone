import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

export const noteplanTheme = [
  EditorView.theme({
    '&': {
      height: '100%',
      fontSize: '15px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
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
    '.cm-scroller': { overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
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
