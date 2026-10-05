'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { saveNoteContent } from '@/lib/db/noteRepository'
import { extractTags, extractMentions, extractBacklinks, extractSupersedes } from '@/lib/parser/noteParser'
import { merge3 } from '@/lib/text/merge3'
import { useNoteStore } from '@/lib/stores/noteStore'
import type { Note } from '@/types/note'

/**
 * 노트 한 개의 '편집 세션' — 불러오기, 자동저장, 충돌 합치기, 실시간 반영,
 * 기기 내 임시 보관(draft), 실패 재시도를 한 곳에서 맡는다.
 *
 * 2.0 이전에는 데일리/주간/월간/노트 페이지가 각자 비슷하지만 조금씩 다른 저장
 * 코드를 갖고 있었고, 그 때문에 아래 문제가 있었다.
 *  - 저장 충돌이면 서버본으로 갈아끼워, 이 기기에서 친 내용이 사라졌다.
 *    그런데 '열어보기만 해도 저장'되던 탓에, 다른 기기가 노트를 열기만 해도
 *    충돌이 났다.
 *  - 같은 페이지 안에서 노트를 바꾸면(링크 클릭, 주 이동) 마지막 2초가 사라졌다.
 *  - 저장 실패는 다시 시도하지 않았고, 앱을 닫으면 아직 안 보낸 내용이 사라졌다.
 *  - 빨리 날짜를 넘기면 늦게 온 응답이 다른 날 노트를 띄웠다.
 *
 * 원칙
 *  - base = '이 기기가 마지막으로 확인한 서버 내용과 그 updated_at'.
 *    저장은 base 와 같을 때만 쓰는 조건부 UPDATE (saveNoteContent).
 *  - 내용이 base 와 같으면 저장하지 않는다 (열어보기 ≠ 저장).
 *  - 서버가 그새 바뀌었으면 base·서버·이 기기 세 버전을 줄 단위로 합친다(merge3).
 *    같은 줄을 서로 다르게 고친 경우만 이 기기 쪽을 남기고, 덮인 서버 쪽은 DB
 *    트리거가 버전 기록에 남긴다. 어느 경우에도 이 기기에서 친 내용은 버리지 않는다.
 *  - 고칠 때마다 localStorage 에 draft 를 남기고 저장이 확인되면 지운다.
 *    다음에 열 때 draft 가 남아 있으면(앱이 꺼졌거나 오프라인) 되살린다.
 */

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface LoadResult {
  note: Note
  /** 아직 서버에 없는 새 노트 (첫 저장이 insert) */
  isNew?: boolean
}

interface Doc {
  id: string
  note: Note
  base: { content: string; updatedAt: number | null }
  alive: boolean
  chain: Promise<void>
  inflightContent: string | null
  timer: ReturnType<typeof setTimeout> | null
  retryDelay: number
  /** tags/backlinks 등 파생 열이 계산된 본문 (매 타자마다 계산하지 않으려고) */
  derivedFor: string
}

/** 파생 열이 낡았으면 지금 계산 */
function ensureDerived(doc: Doc) {
  if (doc.derivedFor !== doc.note.content) {
    doc.note = withContent(doc.note, doc.note.content)
    doc.derivedFor = doc.note.content
  }
}

const AUTOSAVE_MS = 1200
const DRAFT_PREFIX = 'np-draft:'
const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000

interface Draft { content: string; baseContent: string; baseUpdatedAt: number | null; at: number }

function readDraft(id: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_PREFIX + id) ?? 'null') as Draft | null
    if (!d || Date.now() - d.at > DRAFT_MAX_AGE) return null
    return d
  } catch { return null }
}
function writeDraft(doc: Doc) {
  try {
    const d: Draft = { content: doc.note.content, baseContent: doc.base.content, baseUpdatedAt: doc.base.updatedAt, at: Date.now() }
    localStorage.setItem(DRAFT_PREFIX + doc.id, JSON.stringify(d))
  } catch { /* 용량 초과·사생활 모드 — 저장 자체는 계속 */ }
}
function clearDraft(id: string) {
  try { localStorage.removeItem(DRAFT_PREFIX + id) } catch { /* 무시 */ }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

/** 본문에서 파생되는 열(태그 등)을 다시 계산 */
export function withContent(note: Note, content: string): Note {
  return {
    ...note,
    content,
    tags: extractTags(content),
    mentions: extractMentions(content),
    backlinks: extractBacklinks(content),
    supersedes: extractSupersedes(content),
  }
}

export function useNoteDocument(
  key: string | null,
  load: (key: string) => Promise<LoadResult | null>,
) {
  const [note, setNote] = useState<Note | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [typingAuthor, setTypingAuthor] = useState<string | null>(null)
  const docRef = useRef<Doc | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load

  /** doc 의 현재 note 를 화면·전역 스토어에 반영 (살아 있는 doc 만) */
  // 전역 노트 스토어(사이드바 태그 목록·검색 등이 구독)는 타자가 잠깐 멈췄을 때만
  // 갱신한다. 매 글자마다 갱신하면 사이드바가 전체 노트의 태그를 다시 훑어,
  // 노트가 많을 때 한 글자에 100ms 넘게 걸려 한글 입력이 끊겼다.
  const storeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushToStore = (doc: Doc) => {
    const store = useNoteStore.getState()
    store.setActiveNote(doc.note)
    const { content, tags, mentions, backlinks, supersedes } = doc.note
    store.updateNote(doc.id, { content, tags, mentions, backlinks, supersedes })
  }
  const publish = useCallback((doc: Doc, opts: { immediate?: boolean } = {}) => {
    if (!doc.alive || docRef.current !== doc) return
    setNote(doc.note)
    if (storeTimer.current) clearTimeout(storeTimer.current)
    if (opts.immediate) { pushToStore(doc); return }
    storeTimer.current = setTimeout(() => {
      if (docRef.current === doc) pushToStore(doc)
    }, 400)
  }, [])

  const setDocStatus = useCallback((doc: Doc, s: SaveStatus, err: string | null = null) => {
    if (!doc.alive || docRef.current !== doc) return
    setStatus(s)
    setError(err)
  }, [])

  // ── 저장 ──────────────────────────────────────────────────────────────────
  const persist = useCallback((doc: Doc): Promise<void> => {
    if (doc.timer) { clearTimeout(doc.timer); doc.timer = null }
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        ensureDerived(doc)
        const n = doc.note
        if (n.content === doc.base.content && doc.base.updatedAt != null) {
          clearDraft(doc.id)
          setDocStatus(doc, 'saved')
          return
        }
        setDocStatus(doc, 'saving')
        doc.inflightContent = n.content
        let r
        try {
          r = await saveNoteContent(n, doc.base.updatedAt)
        } catch (e) {
          doc.inflightContent = null
          const msg = errorText(e)
          console.error('[save] 실패 — 다시 시도 예정', msg)
          const offline = navigator.onLine === false || /failed to fetch|network|load failed|fetch/i.test(msg)
          setDocStatus(doc, 'error', offline ? '오프라인 — 연결되면 저장합니다' : `저장 실패: ${msg} — 다시 시도 중`)
          scheduleRetry(doc)
          return
        }
        doc.inflightContent = null
        doc.retryDelay = 2000

        if (r.status === 'saved') {
          doc.base = { content: n.content, updatedAt: r.updatedAt }
          doc.note = { ...doc.note, updatedAt: r.updatedAt }
          if (doc.note.content === n.content) { clearDraft(doc.id); setDocStatus(doc, 'saved') }
          else { setDocStatus(doc, 'dirty'); schedule(doc) }
          publish(doc)
          return
        }
        if (r.status === 'deleted') { clearDraft(doc.id); return }
        if (r.status === 'missing') {
          setDocStatus(doc, 'error', '이 노트는 다른 곳에서 삭제됐습니다. 내용은 이 기기에 임시 보관돼 있습니다.')
          return
        }
        // conflict — 서버가 그새 바뀜
        const latest = r.latest
        const meta = { title: latest.title, filePath: latest.filePath, folder: latest.folder, type: latest.type }
        if (latest.content === doc.base.content) {
          // 본문은 그대로, 제목·폴더·updated_at 만 바뀐 경우 (다른 기기의 이름 바꾸기 등)
          doc.base = { content: latest.content, updatedAt: latest.updatedAt }
          doc.note = { ...doc.note, ...meta, updatedAt: latest.updatedAt }
          publish(doc)
          continue
        }
        const { text, conflict } = merge3(doc.base.content, doc.note.content, latest.content)
        doc.base = { content: latest.content, updatedAt: latest.updatedAt }
        doc.note = { ...withContent(doc.note, text), ...meta, updatedAt: latest.updatedAt }
        publish(doc)
        if (conflict && doc.alive) {
          setNotice('다른 기기에서 같은 줄을 동시에 고쳐, 이 기기의 내용을 남겼습니다. 다른 쪽 내용은 버전 기록에서 볼 수 있습니다.')
        }
        // 합친 결과를 다시 저장 (서버본과 같으면 위에서 바로 끝난다)
      }
      setDocStatus(doc, 'dirty')
      schedule(doc)
    }
    doc.chain = doc.chain.then(run, run)
    return doc.chain
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, setDocStatus])

  const schedule = useCallback((doc: Doc, ms = AUTOSAVE_MS) => {
    if (doc.timer) clearTimeout(doc.timer)
    doc.timer = setTimeout(() => { doc.timer = null; void persist(doc) }, ms)
  }, [persist])

  const scheduleRetry = useCallback((doc: Doc) => {
    const delay = doc.retryDelay
    doc.retryDelay = Math.min(doc.retryDelay * 2, 60_000)
    schedule(doc, delay)
  }, [schedule])

  // ── 불러오기 (key 가 바뀌면 이전 노트는 저장하고 새로 연다) ─────────────────
  useEffect(() => {
    if (!key) return
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setNote(null)
    setStatus('idle')
    setError(null)
    setNotice(null)

    loadRef.current(key).then(res => {
      if (cancelled) return   // 그새 다른 노트로 넘어감 — 늦게 온 응답은 버린다
      if (!res) { setNotFound(true); setLoading(false); return }
      const loaded = res.note
      const doc: Doc = {
        id: loaded.id,
        note: loaded,
        base: { content: loaded.content, updatedAt: res.isNew ? null : loaded.updatedAt },
        alive: true,
        chain: Promise.resolve(),
        inflightContent: null,
        timer: null,
        retryDelay: 2000,
        derivedFor: loaded.content,
      }
      // 저장되지 못한 채 남아 있던 draft 되살리기
      const draft = readDraft(loaded.id)
      if (draft && draft.content !== loaded.content) {
        if (draft.baseUpdatedAt === doc.base.updatedAt || draft.baseContent === loaded.content) {
          doc.note = withContent(loaded, draft.content)
        } else {
          const { text, conflict } = merge3(draft.baseContent, draft.content, loaded.content)
          doc.note = withContent(loaded, text)
          if (conflict) setNotice('저장되지 못했던 이 기기의 내용을 되살리면서, 그 사이 바뀐 서버 내용과 합쳤습니다.')
        }
      } else if (draft) {
        clearDraft(loaded.id)
      }
      docRef.current = doc
      publish(doc, { immediate: true })
      setLoading(false)
      if (doc.note.content !== doc.base.content || doc.base.updatedAt == null) {
        setStatus('dirty')
        // 새 노트는 아무것도 안 쳤으면 만들지 않는다 (빈 'Untitled' 가 쌓이지 않게)
        if (!res.isNew) schedule(doc)
      }
    }).catch(e => {
      if (cancelled) return
      console.error('[note load]', e)
      setError(`노트를 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`)
      setLoading(false)
    })

    return () => {
      cancelled = true
      const doc = docRef.current
      if (doc) {
        doc.alive = false
        // 화면에서 사라지는 노트라도 고친 게 있으면 지금 저장한다
        if (doc.note.content !== doc.base.content) {
          void persist(doc)
        } else if (doc.timer) {
          clearTimeout(doc.timer); doc.timer = null
        }
        docRef.current = null
      }
    }
  }, [key, persist, publish, schedule])

  // ── 편집 ──────────────────────────────────────────────────────────────────
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deriveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setContent = useCallback((content: string) => {
    const doc = docRef.current
    if (!doc || content === doc.note.content) return
    // 태그·링크 같은 파생 값은 타자가 잠깐 멈췄을 때 계산한다 — 아주 긴 노트에서
    // 매 글자마다 전체를 다시 훑느라 입력이 무거워지던 것
    doc.note = { ...doc.note, content }
    if (deriveTimer.current) clearTimeout(deriveTimer.current)
    deriveTimer.current = setTimeout(() => {
      if (docRef.current !== doc) return
      ensureDerived(doc)
      publish(doc)
    }, 250)
    publish(doc)
    setStatus('dirty')
    setError(null)
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => { if (docRef.current === doc) writeDraft(doc) }, 300)
    schedule(doc)
  }, [publish, schedule])

  /** 지금 바로 저장 (⌘S) */
  const saveNow = useCallback(async () => {
    const doc = docRef.current
    if (!doc) return
    // 새 노트는 비어 있어도 ⌘S 면 만든다
    await persist(doc)
  }, [persist])

  /** 제목·폴더 등 본문 밖 정보만 바꾼다 (저장하지 않음 — 이미 서버에서 바뀐 값) */
  const patchMeta = useCallback((patch: Partial<Pick<Note, 'title' | 'filePath' | 'folder' | 'updatedAt'>>) => {
    const doc = docRef.current
    if (!doc) return
    doc.note = { ...doc.note, ...patch }
    if (typeof patch.updatedAt === 'number' && doc.note.content === doc.base.content) {
      doc.base = { ...doc.base, updatedAt: patch.updatedAt }
    }
    publish(doc)
  }, [publish])

  // ── 실시간: 다른 기기·MCP 가 이 노트를 고치면 합쳐서 반영 ─────────────────────
  const noteId = note?.id
  useEffect(() => {
    if (!noteId) return
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token
      if (token) supabase.realtime.setAuth(token)
      if (cancelled) return
      channel = supabase
        .channel(`note:${noteId}`)
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'notes', filter: `id=eq.${noteId}` },
          (payload) => {
            const doc = docRef.current
            if (!doc || doc.id !== noteId) return
            const row = payload.new as { content: string; updated_at: number; title?: string; file_path?: string; folder?: string | null }
            const ts = typeof row.updated_at === 'number' ? row.updated_at : 0
            if (doc.base.updatedAt != null && ts <= doc.base.updatedAt) return   // 옛 이벤트 / 내 저장의 메아리
            const meta = {
              ...(row.title != null ? { title: row.title } : {}),
              ...(row.file_path != null ? { filePath: row.file_path } : {}),
              ...('folder' in row ? { folder: row.folder ?? undefined } : {}),
            }
            if (row.content === doc.inflightContent || row.content === doc.base.content) {
              // 내 저장의 메아리이거나 본문 밖만 바뀜
              doc.base = { content: row.content, updatedAt: ts }
              doc.note = { ...doc.note, ...meta, updatedAt: ts }
              publish(doc)
              return
            }
            const { text, conflict } = merge3(doc.base.content, doc.note.content, row.content)
            doc.base = { content: row.content, updatedAt: ts }
            doc.note = { ...withContent(doc.note, text), ...meta, updatedAt: ts }
            publish(doc)
            if (conflict) setNotice('다른 곳에서 같은 줄을 동시에 고쳐, 이 기기의 내용을 남겼습니다. 다른 쪽 내용은 버전 기록에서 볼 수 있습니다.')
            if (text !== row.content) { setStatus('dirty'); schedule(doc) }
            else { clearDraft(doc.id); setStatus('saved') }
          })
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
          const p = payload as { typing: boolean; author?: string }
          setTypingAuthor(p.typing ? (p.author ?? 'Claude') : null)
        })
        .subscribe()
    })
    return () => {
      cancelled = true
      setTypingAuthor(null)
      if (channel) supabase.removeChannel(channel)
    }
  }, [noteId, publish, schedule])

  // ── 앱을 닫거나 가릴 때 바로 저장, 다시 온라인이 되면 재시도 ────────────────
  useEffect(() => {
    const flush = () => {
      const doc = docRef.current
      if (doc && doc.note.content !== doc.base.content) { writeDraft(doc); void persist(doc) }
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    const onOnline = () => { const doc = docRef.current; if (doc && doc.note.content !== doc.base.content) void persist(doc) }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
  }, [persist])

  return {
    note, loading, notFound, status, error, notice, typingAuthor,
    setContent, saveNow, patchMeta,
    dismissNotice: () => setNotice(null),
  }
}
