'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

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
  const [typingAuthor, setTypingAuthor] = useState<string | null>(null)

  /** 앱이 저장했거나 리모트를 반영한 뒤, "내가 아는 최신 상태"를 갱신 */
  const markSelfWrite = useCallback((content: string, updatedAt?: number) => {
    selfContentRef.current = content
    if (typeof updatedAt === 'number') {
      lastSeenUpdatedRef.current = Math.max(lastSeenUpdatedRef.current, updatedAt)
    }
  }, [])

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

  return { typingAuthor, markSelfWrite }
}
