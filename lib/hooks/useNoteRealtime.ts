'use client'
import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface TypingPayload {
  typing: boolean
  author?: string
}

/**
 * 노트 row의 외부 변경(예: MCP 서버가 쓴 내용)을 실시간 반영하고,
 * 외부 작성자의 "작성 중" presence를 표시한다.
 * selfWriteRef에 방금 내가 저장한 content를 기록해두면 같은 내용의
 * 에코 이벤트를 무시해 자기 자신의 저장을 리모트 변경으로 오인하지 않는다.
 */
export function useNoteRealtime(
  noteId: string | undefined,
  onRemoteContent: (content: string) => void
) {
  const selfWriteRef = useRef<string | null>(null)
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const onRemoteContentRef = useRef(onRemoteContent)
  onRemoteContentRef.current = onRemoteContent
  const [typingAuthor, setTypingAuthor] = useState<string | null>(null)

  useEffect(() => {
    if (!noteId) return
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
            const newContent = (payload.new as { content: string }).content
            console.log('[realtime] UPDATE 수신', { len: newContent?.length })
            if (newContent === selfWriteRef.current) { console.log('[realtime] self-echo 무시'); return }
            onRemoteContentRef.current(newContent)
          }
        )
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
          const p = payload as TypingPayload
          console.log('[realtime] typing broadcast', p)
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

  return { typingAuthor, selfWriteRef }
}
