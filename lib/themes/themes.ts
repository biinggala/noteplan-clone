export interface ThemeVars {
  // Layout
  '--bg-primary':    string
  '--bg-secondary':  string
  '--bg-tertiary':   string
  // Text
  '--text-primary':  string
  '--text-secondary':string
  '--text-muted':    string
  // UI chrome
  '--border':        string
  '--accent':        string
  '--sidebar-bg':    string
  // Scrollbar
  '--scrollbar-thumb':       string
  '--scrollbar-thumb-hover': string
  // CodeMirror headings
  '--cm-h1':   string
  '--cm-h2':   string
  '--cm-h3':   string
  // CodeMirror inline
  '--cm-strong':      string
  '--cm-em':          string
  '--cm-formatting':  string
  '--cm-code-bg':     string
  '--cm-code-fg':     string
  '--cm-activeline':  string
  '--cm-hr':          string
}

export interface Theme {
  id:     string
  name:   string
  dark:   boolean
  swatch: string   // preview circle color
  vars:   ThemeVars
}

export const THEMES: Theme[] = [
  {
    id: 'dark', name: 'Dark', dark: true, swatch: '#1a1a1a',
    vars: {
      '--bg-primary':    '#1a1a1a',
      '--bg-secondary':  '#222222',
      '--bg-tertiary':   '#2a2a2a',
      '--text-primary':  '#e8e8e8',
      '--text-secondary':'#aaaaaa',
      '--text-muted':    '#666666',
      '--border':                  'rgba(255,255,255,0.08)',
      '--accent':        '#3b82f6',
      '--sidebar-bg':    'rgba(30,30,30,0.85)',
      '--scrollbar-thumb':       'rgba(255,255,255,0.15)',
      '--scrollbar-thumb-hover': 'rgba(255,255,255,0.25)',
      '--cm-h1':  '#f0f0f0',
      '--cm-h2':  '#e8e8e8',
      '--cm-h3':  '#e0e0e0',
      '--cm-strong':     '#f0f0f0',
      '--cm-em':         '#d4d4d4',
      '--cm-formatting': '#555555',
      '--cm-code-bg':    'rgba(255,255,255,0.08)',
      '--cm-code-fg':    '#e2b96f',
      '--cm-activeline': 'rgba(255,255,255,0.025)',
      '--cm-hr':         'rgba(255,255,255,0.15)',
    },
  },
  {
    id: 'light', name: 'Light', dark: false, swatch: '#f5f5f4',
    vars: {
      '--bg-primary':    '#f5f5f4',
      '--bg-secondary':  '#ffffff',
      '--bg-tertiary':   '#e8e8e6',
      '--text-primary':  '#1c1c1e',
      '--text-secondary':'#555555',
      '--text-muted':    '#999999',
      '--border':                  'rgba(0,0,0,0.09)',
      '--accent':        '#2563eb',
      '--sidebar-bg':    'rgba(245,245,244,0.92)',
      '--scrollbar-thumb':       'rgba(0,0,0,0.15)',
      '--scrollbar-thumb-hover': 'rgba(0,0,0,0.25)',
      '--cm-h1':  '#111111',
      '--cm-h2':  '#222222',
      '--cm-h3':  '#333333',
      '--cm-strong':     '#111111',
      '--cm-em':         '#333333',
      '--cm-formatting': '#cccccc',
      '--cm-code-bg':    'rgba(0,0,0,0.06)',
      '--cm-code-fg':    '#c2410c',
      '--cm-activeline': 'rgba(0,0,0,0.04)',
      '--cm-hr':         'rgba(0,0,0,0.12)',
    },
  },
  {
    id: 'catppuccin', name: 'Catppuccin', dark: true, swatch: '#1e1e2e',
    vars: {
      '--bg-primary':    '#1e1e2e',
      '--bg-secondary':  '#181825',
      '--bg-tertiary':   '#313244',
      '--text-primary':  '#cdd6f4',
      '--text-secondary':'#bac2de',
      '--text-muted':    '#6c7086',
      '--border':                  'rgba(205,214,244,0.1)',
      '--accent':        '#89b4fa',
      '--sidebar-bg':    'rgba(30,30,46,0.9)',
      '--scrollbar-thumb':       'rgba(205,214,244,0.15)',
      '--scrollbar-thumb-hover': 'rgba(205,214,244,0.25)',
      '--cm-h1':  '#cba6f7',
      '--cm-h2':  '#b4befe',
      '--cm-h3':  '#89dceb',
      '--cm-strong':     '#f38ba8',
      '--cm-em':         '#fab387',
      '--cm-formatting': '#45475a',
      '--cm-code-bg':    'rgba(49,50,68,0.8)',
      '--cm-code-fg':    '#a6e3a1',
      '--cm-activeline': 'rgba(205,214,244,0.04)',
      '--cm-hr':         'rgba(205,214,244,0.1)',
    },
  },
  {
    id: 'nord', name: 'Nord', dark: true, swatch: '#2e3440',
    vars: {
      '--bg-primary':    '#2e3440',
      '--bg-secondary':  '#252a33',
      '--bg-tertiary':   '#3b4252',
      '--text-primary':  '#eceff4',
      '--text-secondary':'#d8dee9',
      '--text-muted':    '#616e88',
      '--border':                  'rgba(216,222,233,0.1)',
      '--accent':        '#88c0d0',
      '--sidebar-bg':    'rgba(46,52,64,0.9)',
      '--scrollbar-thumb':       'rgba(216,222,233,0.15)',
      '--scrollbar-thumb-hover': 'rgba(216,222,233,0.25)',
      '--cm-h1':  '#88c0d0',
      '--cm-h2':  '#81a1c1',
      '--cm-h3':  '#5e81ac',
      '--cm-strong':     '#eceff4',
      '--cm-em':         '#d8dee9',
      '--cm-formatting': '#4c566a',
      '--cm-code-bg':    'rgba(59,66,82,0.8)',
      '--cm-code-fg':    '#ebcb8b',
      '--cm-activeline': 'rgba(216,222,233,0.04)',
      '--cm-hr':         'rgba(216,222,233,0.1)',
    },
  },
  {
    id: 'dracula', name: 'Dracula', dark: true, swatch: '#282a36',
    vars: {
      '--bg-primary':    '#282a36',
      '--bg-secondary':  '#21222c',
      '--bg-tertiary':   '#343746',
      '--text-primary':  '#f8f8f2',
      '--text-secondary':'#abb2bf',
      '--text-muted':    '#6272a4',
      '--border':                  'rgba(248,248,242,0.1)',
      '--accent':        '#bd93f9',
      '--sidebar-bg':    'rgba(40,42,54,0.9)',
      '--scrollbar-thumb':       'rgba(248,248,242,0.15)',
      '--scrollbar-thumb-hover': 'rgba(248,248,242,0.25)',
      '--cm-h1':  '#ff79c6',
      '--cm-h2':  '#bd93f9',
      '--cm-h3':  '#8be9fd',
      '--cm-strong':     '#ffb86c',
      '--cm-em':         '#f1fa8c',
      '--cm-formatting': '#44475a',
      '--cm-code-bg':    'rgba(52,55,70,0.8)',
      '--cm-code-fg':    '#50fa7b',
      '--cm-activeline': 'rgba(248,248,242,0.04)',
      '--cm-hr':         'rgba(248,248,242,0.1)',
    },
  },
  {
    id: 'rosepine', name: 'Rosé Pine', dark: true, swatch: '#191724',
    vars: {
      '--bg-primary':    '#191724',
      '--bg-secondary':  '#1f1d2e',
      '--bg-tertiary':   '#26233a',
      '--text-primary':  '#e0def4',
      '--text-secondary':'#908caa',
      '--text-muted':    '#6e6a86',
      '--border':                  'rgba(224,222,244,0.1)',
      '--accent':        '#c4a7e7',
      '--sidebar-bg':    'rgba(25,23,36,0.9)',
      '--scrollbar-thumb':       'rgba(224,222,244,0.15)',
      '--scrollbar-thumb-hover': 'rgba(224,222,244,0.25)',
      '--cm-h1':  '#eb6f92',
      '--cm-h2':  '#c4a7e7',
      '--cm-h3':  '#9ccfd8',
      '--cm-strong':     '#ebbcba',
      '--cm-em':         '#f6c177',
      '--cm-formatting': '#393552',
      '--cm-code-bg':    'rgba(38,35,58,0.8)',
      '--cm-code-fg':    '#9ccfd8',
      '--cm-activeline': 'rgba(224,222,244,0.04)',
      '--cm-hr':         'rgba(224,222,244,0.1)',
    },
  },
  {
    id: 'solarized-dark', name: 'Solarized', dark: true, swatch: '#002b36',
    vars: {
      '--bg-primary':    '#002b36',
      '--bg-secondary':  '#073642',
      '--bg-tertiary':   '#0a4455',
      '--text-primary':  '#839496',
      '--text-secondary':'#657b83',
      '--text-muted':    '#586e75',
      '--border':                  'rgba(131,148,150,0.15)',
      '--accent':        '#268bd2',
      '--sidebar-bg':    'rgba(0,43,54,0.9)',
      '--scrollbar-thumb':       'rgba(131,148,150,0.2)',
      '--scrollbar-thumb-hover': 'rgba(131,148,150,0.35)',
      '--cm-h1':  '#cb4b16',
      '--cm-h2':  '#b58900',
      '--cm-h3':  '#859900',
      '--cm-strong':     '#93a1a1',
      '--cm-em':         '#eee8d5',
      '--cm-formatting': '#2a5a68',
      '--cm-code-bg':    'rgba(7,54,66,0.8)',
      '--cm-code-fg':    '#2aa198',
      '--cm-activeline': 'rgba(131,148,150,0.06)',
      '--cm-hr':         'rgba(131,148,150,0.2)',
    },
  },
]

export const DEFAULT_THEME_ID = 'dark'
export function getTheme(id: string): Theme {
  return THEMES.find(t => t.id === id) ?? THEMES[0]
}
