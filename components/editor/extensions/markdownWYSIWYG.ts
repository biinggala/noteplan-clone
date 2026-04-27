import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

// Marker node names whose syntax punctuation should be hidden
// when the cursor is NOT on that line (WYSIWYG / Typora-style).
// NOTE: HeaderMark is intentionally excluded here — ATX headings are handled
// via line-text regex below so we can reliably also hide the trailing space.
// Setext headings are handled separately via line-text scan (Source 3).
const FORMATTING_MARKS = new Set([
  'EmphasisMark',      // * or _ in *italic* / **bold**
  'StrikethroughMark', // ~~ in ~~strikethrough~~
  'CodeMark',          // ` in `inline code`
  'QuoteMark',         // > in blockquotes
  'LinkMark',          // [ ] ( ) brackets in [text](url)
])

// Matches ATX heading prefix: 1-6 # characters followed by a space
const HEADING_PREFIX_RE = /^(#{1,6}) /

type DecoItem =
  | { kind: 'replace'; from: number; to: number }
  | { kind: 'line'; at: number; cls: string }

function buildDecorations(view: EditorView): DecorationSet {
  const { from, to } = view.viewport

  // All line numbers that contain a cursor or selection edge → markers stay visible
  const activeLines = new Set<number>()
  for (const range of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(range.from).number
    const b = view.state.doc.lineAt(range.to).number
    for (let ln = a; ln <= b; ln++) activeLines.add(ln)
  }

  const items: DecoItem[] = []

  // ── Source 1: non-heading formatting marks via syntax tree ────────────────
  syntaxTree(view.state).iterate({
    from,
    to,
    enter(node) {
      if (!FORMATTING_MARKS.has(node.name)) return

      // Keep fenced-code fence marks (```) visible — hiding them is confusing
      if (node.name === 'CodeMark' && node.node.parent?.name === 'FencedCode') return

      const lineNum = view.state.doc.lineAt(node.from).number
      if (activeLines.has(lineNum)) return  // cursor is on this line → reveal

      items.push({ kind: 'replace', from: node.from, to: node.to })
    },
  })

  // ── Source 2: ATX heading prefixes via line-text regex ───────────────────
  // Using line text avoids dependence on exact lezer HeaderMark boundaries and
  // reliably hides both the # characters AND the mandatory trailing space.
  for (let pos = from; pos <= to;) {
    const line = view.state.doc.lineAt(pos)
    if (!activeLines.has(line.number)) {
      const m = HEADING_PREFIX_RE.exec(line.text)
      if (m) {
        // Hide "# " / "## " / "### " etc. (hashes + space = m[0].length chars)
        items.push({ kind: 'replace', from: line.from, to: line.from + m[0].length })
      }
    }
    pos = line.to + 1
  }

  // ── Source 3: Setext heading content lines ──────────────────────────────
  // When ANY number of - or = chars (alone on a line) follows a non-empty
  // line, lezer parses the preceding line as a SetextHeading and applies
  // large/bold font via HighlightStyle. We add cm-setext-header so CSS can
  // neutralise the font — even for a single "-" or "=" while the user is
  // still typing. The mark line is NOT hidden here; hrRule.ts renders 3+
  // char lines (---, ===, etc.) as compact visual dividers.
  for (let pos = from; pos <= to;) {
    const line = view.state.doc.lineAt(pos)
    if (/^[-=]+\s*$/.test(line.text) && line.number > 1) {
      const prevLine = view.state.doc.line(line.number - 1)
      if (prevLine.text.trim().length > 0) {
        // Always neutralise heading font on the content line
        items.push({ kind: 'line', at: prevLine.from, cls: 'cm-setext-header' })
      }
    }
    pos = line.to + 1
  }

  // Sort replace items by from position (required by RangeSetBuilder)
  const replaceItems = items
    .filter((i): i is Extract<DecoItem, { kind: 'replace' }> => i.kind === 'replace')
    .sort((a, b) => a.from - b.from || a.to - b.to)

  // Line decorations must also be sorted
  const lineItems = items
    .filter((i): i is Extract<DecoItem, { kind: 'line' }> => i.kind === 'line')
    .sort((a, b) => a.at - b.at)

  // Merge both streams in sorted order into the builder
  // RangeSetBuilder requires strictly ascending positions across ALL decorations.
  // We interleave line decos (point ranges: from === to) with replace decos.
  const all: Array<{ from: number; to: number; deco: Decoration }> = [
    ...replaceItems.map((r) => ({ from: r.from, to: r.to, deco: Decoration.replace({}) })),
    ...lineItems.map((l) => ({ from: l.at, to: l.at, deco: Decoration.line({ class: l.cls }) })),
  ].sort((a, b) => a.from - b.from || a.to - b.to)

  const builder = new RangeSetBuilder<Decoration>()
  for (const { from: f, to: t, deco } of all) {
    builder.add(f, t, deco)
  }

  return builder.finish()
}

const wysiwyGPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

export function markdownWYSIWYGExtension() {
  return [wysiwyGPlugin]
}
