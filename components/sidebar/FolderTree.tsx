'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useUIStore } from '@/lib/stores/uiStore'
import {
  getFolders,
  createFolder as dbCreateFolder,
  deleteFolder as dbDeleteFolder,
  renameFolder as dbRenameFolder,
  getNotesByFolder,
  getUnfiledNotes,
  upsertNote,
  deleteNote as dbDeleteNote,
} from '@/lib/db/noteRepository'
import type { Note, Folder } from '@/types/note'

// ── Types ────────────────────────────────────────────────────────────────

interface FolderWithData extends Folder {
  children: FolderWithData[]
  notes: Note[]
}

type ContextMenu = {
  x: number
  y: number
  type: 'folder' | 'note'
  id: string
  extra?: string
} | null

type Dialog = {
  title: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  isConfirm?: boolean  // true = yes/no dialog (no input)
  onConfirm: (value: string) => void
  onCancel: () => void
} | null

// ── Tree builder ─────────────────────────────────────────────────────────

function buildTree(folders: Folder[], notesByFolder: Record<string, Note[]>): FolderWithData[] {
  const map = new Map<string, FolderWithData>()
  for (const f of folders) {
    map.set(f.id, { ...f, children: [], notes: notesByFolder[f.path] ?? [] })
  }
  const roots: FolderWithData[] = []
  for (const f of map.values()) {
    if (f.parentId && map.has(f.parentId)) {
      map.get(f.parentId)!.children.push(f)
    } else {
      roots.push(f)
    }
  }
  // PARA canonical order; non-PARA folders fall back to alphabetical after
  const PARA_ORDER = ['Projects', 'Areas', 'Resources', 'Archive']
  const paraIdx = (name: string) => {
    const i = PARA_ORDER.indexOf(name)
    return i === -1 ? PARA_ORDER.length : i
  }
  const sort = (items: FolderWithData[]) => {
    items.sort((a, b) => paraIdx(a.name) - paraIdx(b.name) || a.name.localeCompare(b.name))
    items.forEach(item => sort(item.children))
  }
  sort(roots)
  return roots
}

// ── Icons ─────────────────────────────────────────────────────────────────

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-2.5 h-2.5 flex-shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
    </svg>
  )
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 flex-shrink-0 ${open ? 'text-blue-400' : 'text-blue-400/40'}`}
      fill="currentColor" viewBox="0 0 20 20"
    >
      {open
        ? <path d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        : <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
      }
    </svg>
  )
}

function DocIcon() {
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}

// ── Inline Dialog ─────────────────────────────────────────────────────────

function InlineDialog({ dialog }: { dialog: Dialog }) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog && !dialog.isConfirm) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [dialog])

  if (!dialog) return null

  const handleConfirm = () => {
    dialog.onConfirm(inputRef.current?.value ?? '')
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={dialog.onCancel}
    >
      <div
        className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg p-4 shadow-2xl min-w-64 max-w-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-[var(--text-primary)] mb-3">{dialog.title}</p>
        {!dialog.isConfirm && (
          <input
            ref={inputRef}
            type="text"
            defaultValue={dialog.defaultValue ?? ''}
            placeholder={dialog.placeholder}
            className="w-full px-2.5 py-1.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border)]
              text-[var(--text-primary)] text-sm focus:outline-none focus:border-[var(--accent)] mb-3"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConfirm()
              if (e.key === 'Escape') dialog.onCancel()
            }}
          />
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={dialog.onCancel}
            className="px-3 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1 text-xs bg-[var(--accent)] text-white rounded-md hover:bg-blue-600 transition-colors"
          >
            {dialog.confirmLabel ?? '확인'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── NoteItem ──────────────────────────────────────────────────────────────

function NoteItem({ note, depth, isActive, onClick, onContextMenu }: {
  note: Note
  depth: number
  isActive: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className={`flex items-center gap-1.5 py-1 rounded-md cursor-pointer text-sm transition-colors
        ${isActive
          ? 'bg-blue-500/20 text-blue-400'
          : 'text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]'
        }`}
      style={{ paddingLeft: `${8 + depth * 14}px`, paddingRight: '8px' }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <DocIcon />
      <span className="truncate">{note.title}</span>
    </div>
  )
}

// ── FolderNode ────────────────────────────────────────────────────────────

function FolderNode({ folder, depth, expandedFolders, toggleFolder, onContextMenu, activeId, onNoteClick }: {
  folder: FolderWithData
  depth: number
  expandedFolders: string[]
  toggleFolder: (id: string) => void
  onContextMenu: (e: React.MouseEvent, type: 'folder' | 'note', id: string, extra?: string) => void
  activeId: string | null
  onNoteClick: (id: string) => void
}) {
  const isOpen = expandedFolders.includes(folder.id)
  const hasChildren = folder.children.length > 0 || folder.notes.length > 0

  return (
    <div>
      <div
        className="flex items-center gap-1 py-1 rounded-md cursor-pointer select-none
          text-[var(--text-secondary)] hover:bg-white/5 group"
        style={{ paddingLeft: `${6 + depth * 14}px`, paddingRight: '6px' }}
        onClick={() => toggleFolder(folder.id)}
        onContextMenu={(e) => onContextMenu(e, 'folder', folder.id, folder.path)}
      >
        <span className="w-3 flex items-center justify-center">
          {hasChildren ? <Chevron open={isOpen} /> : null}
        </span>
        <FolderIcon open={isOpen} />
        <span className="text-sm truncate ml-0.5 flex-1">{folder.name}</span>
        {folder.notes.length > 0 && (
          <span className="text-xs text-[var(--text-muted)] opacity-0 group-hover:opacity-100 flex-shrink-0">
            {folder.notes.length}
          </span>
        )}
      </div>

      {isOpen && (
        <div>
          {folder.children.map(child => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              onContextMenu={onContextMenu}
              activeId={activeId}
              onNoteClick={onNoteClick}
            />
          ))}
          {folder.notes.map(note => (
            <NoteItem
              key={note.id}
              note={note}
              depth={depth + 1}
              isActive={activeId === note.id}
              onClick={() => onNoteClick(note.id)}
              onContextMenu={(e) => onContextMenu(e, 'note', note.id)}
            />
          ))}
          {!hasChildren && (
            <div
              className="text-xs text-[var(--text-muted)] py-1 italic"
              style={{ paddingLeft: `${6 + (depth + 1) * 14}px` }}
            >
              비어있음
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Context Menu Item ─────────────────────────────────────────────────────

function MenuItem({ children, onClick, danger }: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center px-3 py-1.5 text-sm hover:bg-white/10 transition-colors
        ${danger ? 'text-red-400 hover:text-red-300' : 'text-[var(--text-primary)]'}`}
    >
      {children}
    </button>
  )
}

// ── FolderTree (main export) ──────────────────────────────────────────────

export default function FolderTree() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeId = searchParams.get('id')
  const { expandedFolders, toggleFolder, expandFolder } = useUIStore()
  const [tree, setTree] = useState<FolderWithData[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [unfiledNotes, setUnfiledNotes] = useState<Note[]>([])
  const [unfiledOpen, setUnfiledOpen] = useState(false)

  const loadData = useCallback(async () => {
    let folders = await getFolders()

    // Initialize PARA folders (idempotent — check by path)
    const existingPaths = new Set(folders.map(f => f.path))
    let created = false
    for (const name of ['Projects', 'Areas', 'Resources', 'Archive']) {
      if (!existingPaths.has(name)) {
        await dbCreateFolder(name)
        created = true
      }
    }
    if (created) folders = await getFolders()

    const notesByFolder: Record<string, Note[]> = {}
    for (const f of folders) {
      notesByFolder[f.path] = await getNotesByFolder(f.path)
    }
    setTree(buildTree(folders, notesByFolder))
    // 미분류 노트 로드
    setUnfiledNotes(await getUnfiledNotes())
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  const showInputDialog = (title: string, placeholder?: string, defaultValue?: string): Promise<string | null> =>
    new Promise((resolve) => {
      setDialog({
        title, placeholder, defaultValue,
        onConfirm: (v) => { setDialog(null); resolve(v.trim() || null) },
        onCancel: () => { setDialog(null); resolve(null) },
      })
    })

  const showConfirmDialog = (title: string): Promise<boolean> =>
    new Promise((resolve) => {
      setDialog({
        title, isConfirm: true, confirmLabel: '삭제',
        onConfirm: () => { setDialog(null); resolve(true) },
        onCancel: () => { setDialog(null); resolve(false) },
      })
    })

  const handleContextMenu = (e: React.MouseEvent, type: 'folder' | 'note', id: string, extra?: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, type, id, extra })
  }

  // ── Actions ───────────────────────────────────────────────────────────

  const handleNewNote = async (folderPath: string, folderId: string) => {
    setContextMenu(null)
    const name = await showInputDialog('새 노트 이름', '제목 입력...')
    if (!name) return
    const note = {
      id: crypto.randomUUID(),
      type: 'project' as const,
      title: name,
      content: `# ${name}\n\n`,
      filePath: `${folderPath}/${name}.md`,
      folder: folderPath,
      tags: [] as string[],
      mentions: [] as string[],
      backlinks: [] as string[],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await upsertNote(note)
    expandFolder(folderId)
    await loadData()
    router.push(`/notes?id=${note.id}`)
  }

  const handleNewSubfolder = async (parentPath?: string) => {
    setContextMenu(null)
    const name = await showInputDialog('새 폴더 이름', '폴더 이름 입력...')
    if (!name) return
    await dbCreateFolder(name, parentPath)
    await loadData()
  }

  const handleRenameFolder = async (folderId: string) => {
    setContextMenu(null)
    const findFolder = (items: FolderWithData[]): FolderWithData | undefined => {
      for (const item of items) {
        if (item.id === folderId) return item
        const found = findFolder(item.children)
        if (found) return found
      }
    }
    const folder = findFolder(tree)
    if (!folder) return
    const name = await showInputDialog('폴더 이름 변경', '새 이름 입력...', folder.name)
    if (!name || name === folder.name) return
    await dbRenameFolder(folderId, name)
    await loadData()
  }

  const handleDeleteFolder = async (folderId: string) => {
    setContextMenu(null)
    const ok = await showConfirmDialog('이 폴더를 삭제하시겠습니까?\n(폴더 안의 노트는 유지됩니다)')
    if (!ok) return
    await dbDeleteFolder(folderId)
    await loadData()
  }

  const handleDeleteNote = async (noteId: string) => {
    setContextMenu(null)
    const ok = await showConfirmDialog('이 노트를 삭제하시겠습니까?')
    if (!ok) return
    await dbDeleteNote(noteId)
    await loadData()
  }

  return (
    <div className="flex-1 overflow-y-auto relative">
      {tree.map(folder => (
        <FolderNode
          key={folder.id}
          folder={folder}
          depth={0}
          expandedFolders={expandedFolders}
          toggleFolder={toggleFolder}
          onContextMenu={handleContextMenu}
          activeId={activeId}
          onNoteClick={(id) => router.push(`/notes?id=${id}`)}
        />
      ))}

      {/* Unfiled Notes — 폴더 없이 저장된 노트 */}
      {unfiledNotes.length > 0 && (
        <div>
          <button
            onClick={() => setUnfiledOpen(o => !o)}
            className="flex items-center gap-1.5 w-full px-2 py-1 text-xs
              text-[var(--text-muted)] hover:text-[var(--text-secondary)]
              hover:bg-white/5 transition-colors rounded"
          >
            <svg
              className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${unfiledOpen ? 'rotate-90' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
            <span className="font-medium uppercase tracking-wider">Unfiled</span>
            <span className="ml-1 opacity-50">({unfiledNotes.length})</span>
          </button>
          {unfiledOpen && (
            <div>
              {unfiledNotes.map(note => (
                <button
                  key={note.id}
                  onClick={() => router.push(`/notes?id=${note.id}`)}
                  className={`flex items-center gap-1.5 w-full pl-7 pr-2 py-1 rounded text-xs transition-colors
                    ${activeId === note.id
                      ? 'bg-blue-500/20 text-blue-300'
                      : 'text-[var(--text-muted)] hover:bg-white/5 hover:text-[var(--text-secondary)]'
                    }`}
                >
                  <svg className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="truncate">{note.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[var(--bg-tertiary)] border border-[var(--border)]
            rounded-lg shadow-2xl py-1 min-w-44"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'folder' ? (
            <>
              <MenuItem onClick={() => handleNewNote(contextMenu.extra ?? '', contextMenu.id)}>
                새 노트
              </MenuItem>
              <MenuItem onClick={() => handleNewSubfolder(contextMenu.extra)}>
                새 하위 폴더
              </MenuItem>
              <div className="border-t border-[var(--border)] my-1" />
              <MenuItem onClick={() => handleRenameFolder(contextMenu.id)}>
                이름 변경
              </MenuItem>
              <MenuItem danger onClick={() => handleDeleteFolder(contextMenu.id)}>
                삭제
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem onClick={() => { setContextMenu(null); router.push(`/notes?id=${contextMenu.id}`) }}>
                열기
              </MenuItem>
              <div className="border-t border-[var(--border)] my-1" />
              <MenuItem danger onClick={() => handleDeleteNote(contextMenu.id)}>
                삭제
              </MenuItem>
            </>
          )}
        </div>
      )}

      {/* Inline Dialog (replaces window.prompt / window.confirm) */}
      <InlineDialog dialog={dialog} />
    </div>
  )
}
