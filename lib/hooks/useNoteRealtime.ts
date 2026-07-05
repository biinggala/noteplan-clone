'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { upsertNote, getNoteById, getNoteUpdatedAt } from '@/lib/db/noteRepository'
import type { Note } from '@/types/note'

interface TypingPayload {
  typing: boolean
  author?: string
}

/**
 * 노트 row의 외부 변경(예: MCP 서버가 쓴 내용)을 실시간 반영하고,
 * 외부 작성자의 "작성 중" presence를 표시한다.
 *
 * echo/경합 방어 (updated_at 기반):
 *  - 앱이 저장하거나 리모트를 반영할 때마다 markSelfWrite(content, updatedAt)로
 *    "내가 이미 아는 최신 상태"를 기록.
 *  - 리모트 UPDATE가 도착하면
 *      (1) updated_at이 지금까지 본 최신보다 오래됐으면 → 순서 역전된 옛 이벤트, 무시
 *      (2) content가 방금 내가 쓴/받은 것과 같으면 → 내 저장의 echo, 무시
 *      (3) 그 외 → 진짜 리모트 변경, 화면에 반영
 *
 * 낙관적 동시성 (저장 시점 충돌 방어):
 *  - realtime은 "화면 반영"만 빠르게 해줄 뿐 "저장"은 막지 못한다 — 잠자기에서
 *    깨어난 백그라운드 탭처럼 realtime을 놓친 세션이 저장을 시도하면 여전히
 *    최신 내용을 옛 내용으로 덮어쓸 수 있다.
 *  - save(note)는 upsert 직전 DB의 실제 updated_at을, "내가 아는 baseline"이
 *    아니라 **저장하려는 그 note 객체 자신의 updatedAt**과 비교한다(공유 ref를
 *    쓰면 노트 전환 시 다른 노트의 baseline이 리셋되면서 오판할 수 있음 — 실제로
 *    이 버그 때문에 날짜를 바꾸면 새 빈 노트에 이전 노트 내용이 덮어써지는
 *    사고가 있었음, 2026-07-06 수정).
 *  - 충돌로 판정돼도, 그 사이 사용자가 이미 다른 노트로 넘어갔다면(activeNoteIdRef
 *    가 다름) 화면(onRemoteContent)에는 반영하지 않는다 — 화면에 없는 노트의
 *    내용을 지금 보고 있는 노트에 잘못 밀어넣는 걸 막기 위함.
 *  - 호출자는 반환된 Note로 자기 state(특히 updatedAt)를 갱신해야 한다
 *    (그래야 다음 저장이 최신 baseline 위에서 이어짐).
 */
export function useNoteRealtime(
  noteId: string | undefined,
  onRemoteContent: (content: string) => void
) {
  const selfContentRef = useRef<string | null>(null)
  const lastSeenUpdatedRef = useRef<number>(0)
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const onRemoteContentRef = useRef(onRemoteContent)
  onRemoteContentRef.current = onRemoteContent
  // 지금 화면에 실제로 떠 있는 노트 id — save()가 늦게 끝났을 때 엉뚱한 노트에
  // 반영하지 않기 위한 가드. onRemoteContentRef와 마찬가지로 매 렌더 갱신.
  const activeNoteIdRef = useRef(noteId)
  activeNoteIdRef.current = noteId
  const [typingAuthor, setTypingAuthor] = useState<string | null>(null)

  /** 앱이 저장했거나 리모트를 반영한 뒤, "내가 아는 최신 상태"를 갱신 */
  const markSelfWrite = useCallback((content: string, updatedAt?: number) => {
    selfContentRef.current = content
    if (typeof updatedAt === 'number') {
      lastSeenUpdatedRef.current = Math.max(lastSeenUpdatedRef.current, updatedAt)
    }
  }, [])

  /**
   * 충돌 검사 후 저장. 다른 기기가 이미 더 최신으로 고쳤으면 덮어쓰지 않고
   * 그 최신 Note를 대신 반환한다(호출자는 이걸로 자기 state를 갱신).
   */
  const save = useCallback(async (note: Note): Promise<Note> => {
    const remoteUpdatedAt = await getNoteUpdatedAt(note.id)
    if (remoteUpdatedAt != null && remoteUpdatedAt > note.updatedAt) {
      console.warn('[realtime] 저장 충돌 감지 — 다른 기기가 더 최신, 덮어쓰기 취소하고 최신본 반영')
      const latest = await getNoteById(note.id)
      if (latest) {
        // 지금도 여전히 이 노트를 보고 있을 때만 화면/baseline에 반영
        if (activeNoteIdRef.current === note.id) {
          markSelfWrite(latest.content, latest.updatedAt)
          onRemoteContentRef.current(latest.content)
        }
        return latest
      }
    }
    const saved = await upsertNote(note)
    if (activeNoteIdRef.current === note.id) {
      markSelfWrite(saved.content, saved.updatedAt)
    }
    return saved
  }, [markSelfWrite])

  useEffect(() => {
    if (!noteId) return
    // 노트가 바뀌면 이전 노트 기준의 baseline은 버린다.
    selfContentRef.current = null
    lastSeenUpdatedRef.current = 0
    const supabase = createClient()
    let cancelled = false

    // Realtime은 RLS를 존중 → 소켓에 로그인 access token을 실어야 이벤트가 통과.
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token
      if (token) supabase.realtime.setAuth(token)
      if (cancelled) return

      const channel = supabase
        .channel(`note:${noteId}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'notes', filter: `id=eq.${noteId}` },
          (payload) => {
            // 이 채널이 아직 완전히 해제되지 않은 채로 남아있을 수 있다(unsubscribe는
            // 비동기) — 그 사이 사용자가 이미 다른 노트로 넘어갔다면 이 이벤트는 그
            // "지금은 활성이 아닌" 노트(noteId, 클로저로 고정됨)에 대한 것이므로 무시.
            // 이 가드가 없으면 이전 노트의 저장 이벤트가 onRemoteContentRef(항상 최신
            // 콜백을 가리킴)를 통해 새로 열린 노트의 content를 덮어쓰는 사고가 난다.
            if (activeNoteIdRef.current !== noteId) return
            const row = payload.new as { content: string; updated_at?: number }
            const ts = typeof row.updated_at === 'number' ? row.updated_at : Date.now()
            // (1) 순서 역전된 옛 이벤트
            if (ts < lastSeenUpdatedRef.current) return
            lastSeenUpdatedRef.current = ts
            // (2) 내 저장의 echo
            if (row.content === selfContentRef.current) return
            // (3) 진짜 리모트 변경 → 반영 (다음 autosave echo 대비 baseline도 갱신)
            selfContentRef.current = row.content
            onRemoteContentRef.current(row.content)
          }
        )
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
          const p = payload as TypingPayload
          setTypingAuthor(p.typing ? (p.author ?? 'Claude AI') : null)
        })
        .subscribe((status) => {
          console.log(`[realtime] note:${noteId} → ${status}`)
        })

      channelRef.current = channel
    })

    return () => {
      cancelled = true
      setTypingAuthor(null)
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    }
  }, [noteId])

  return { typingAuthor, markSelfWrite, save }
}
