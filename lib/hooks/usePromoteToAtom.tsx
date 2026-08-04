'use client'
import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { v4 as uuidv4 } from 'uuid'
import { upsertNote, getNoteByTitle } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks, extractSupersedes } from '@/lib/parser/noteParser'
import { suggestAtomTitle } from '@/components/editor/extensions/selectionMenu'
import type { Note } from '@/types/note'

interface Pending {
  body: string
  resolve: (title: string | null) => void
}

/**
 * 선택한 내용을 독립 노트("원자")로 만든다.
 *
 * promote(text)를 부르면 제목 확인 다이얼로그가 뜨고, 확정하면 노트를 만든 뒤
 * 그 제목을 돌려준다. 에디터는 그 제목으로 [[링크]]를 꽂는다.
 * 취소하면 null.
 *
 * 반환하는 dialog를 페이지 어딘가에 렌더해야 한다.
 */
export function usePromoteToAtom(sourceTitle?: string) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [dupe, setDupe] = useState<Note | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const promote = useCallback((text: string) => {
    return new Promise<string | null>((resolve) => {
      setTitle(suggestAtomTitle(text))
      setDupe(null)
      setPending({ body: text, resolve })
      setTimeout(() => inputRef.current?.select(), 30)
    })
  }, [])

  const close = useCallback((result: string | null) => {
    pending?.resolve(result)
    setPending(null)
    setTitle('')
    setDupe(null)
    setBusy(false)
  }, [pending])

  const confirm = useCallback(async () => {
    if (!pending || busy) return
    const clean = title.replace(/[[\]/\\]/g, '').trim()
    if (!clean) return
    setBusy(true)
    try {
      // 같은 제목이 이미 있으면 새로 만들지 않고 그 노트로 링크만 건다.
      // (원자가 두 벌 생기면 나중에 어느 게 진짜인지 알 수 없어진다)
      const existing = await getNoteByTitle(clean)
      if (existing && !dupe) { setDupe(existing); setBusy(false); return }
      if (existing) { close(existing.title); return }

      const body = pending.body.trim()
      const content = sourceTitle
        ? `# ${clean}\n\n${body}\n\n---\n출처: [[${sourceTitle}]]\n`
        : `# ${clean}\n\n${body}\n`
      const safe = clean.replace(/[^a-zA-Z0-9ㄱ-ㅎ가-힣 ._-]/g, '').trim() || 'Untitled'
      const now = Date.now()
      const note: Note = {
        id: uuidv4(),
        type: 'project',
        title: clean,
        content,
        filePath: `Notes/${safe}.md`,
        tags: extractTags(content),
        mentions: extractMentions(content),
        backlinks: extractBacklinks(content), supersedes: extractSupersedes(content),
        createdAt: now,
        updatedAt: now,
      }
      await upsertNote(note)
      close(clean)
    } catch (e) {
      console.error('[promote]', e)
      setBusy(false)
    }
  }, [pending, title, busy, dupe, sourceTitle, close])

  const dialog = pending && typeof window !== 'undefined' ? createPortal(
    <>
      <div className="fixed inset-0 z-[9998] bg-black/40" onClick={() => close(null)} />
      <div className="fixed z-[9999] left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[420px]
        rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl p-4">
        <div className="text-sm font-semibold text-[var(--text-primary)] mb-1">원자로 승격</div>
        <div className="text-[11px] text-[var(--text-muted)] mb-3">
          선택한 내용이 새 노트가 되고, 원래 자리엔 링크만 남습니다.
        </div>

        <input
          ref={inputRef}
          value={title}
          onChange={e => { setTitle(e.target.value); setDupe(null) }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') confirm()
            if (e.key === 'Escape') close(null)
          }}
          placeholder="노트 제목..."
          className="w-full px-2.5 py-2 rounded-md text-sm outline-none
            bg-[var(--bg-tertiary)] border border-[var(--border)]
            text-[var(--text-primary)] focus:border-[var(--accent)]"
        />

        <div className="mt-2 max-h-28 overflow-y-auto rounded-md bg-[var(--bg-tertiary)]
          px-2.5 py-2 text-[11px] text-[var(--text-muted)] whitespace-pre-wrap">
          {pending.body.trim()}
        </div>

        {dupe && (
          <div className="mt-2 rounded-md bg-amber-500/15 border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-300">
            같은 제목의 노트가 이미 있습니다. 한 번 더 누르면 <b>새로 만들지 않고</b> 그 노트로 링크만 겁니다.
          </div>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={() => close(null)}
            className="px-3 py-1.5 text-xs rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            취소
          </button>
          <button
            onClick={confirm}
            disabled={busy || !title.trim()}
            className="px-3 py-1.5 text-xs rounded-md font-medium text-white
              bg-[var(--accent)] disabled:opacity-40"
          >
            {busy ? '…' : dupe ? '기존 노트에 연결' : '승격'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  ) : null

  return { promote, dialog }
}
