import type { LinkTarget } from '@/lib/db/noteRepository'
import { normalizeKey } from '@/lib/parser/noteParser'

/**
 * [[ 자동완성 후보 랭킹.
 *
 * 기존엔 updated_at 내림차순이 전부라, 매일 수정되는 날짜 노트
 * (2026-08-02, Week 31 …)가 상단을 차지해 정작 링크하고 싶은 개념 노트를
 * 밀어냈다. 아래 점수들을 합산해 정렬한다.
 *
 * 나중에 벡터(의미) 점수를 붙일 자리도 semanticScore로 열어둠 — 0~1 값을
 * 넘기면 가중치를 얹어 같은 랭킹에 섞인다.
 */

const CALENDAR_TYPES = new Set(['daily', 'weekly', 'monthly', 'yearly'])

/** 제목이 날짜/주차처럼 생겼는지 (Week 31, 2026 / 2026-08-02 / 2026-W31) */
function looksLikeDateTitle(title: string): boolean {
  return /^\d{4}-\d{2}(-\d{2})?$/.test(title)
    || /^\d{4}-W\d{2}$/.test(title)
    || /^Week \d{1,2}, \d{4}$/.test(title)
}

/** Archive 폴더(및 그 하위) 소속인지 — 'Archive', 'Archive/2025/…' */
export function isArchived(folder?: string): boolean {
  if (!folder) return false
  return /^archive(\/|$)/i.test(normalizeKey(folder).trim())
}

export interface RankOptions {
  /** 노트 id → 0~1 의미 유사도 (B단계 벡터검색에서 주입) */
  semanticScore?: Map<string, number>
  limit?: number
}

interface Scored { t: LinkTarget; score: number }

export function rankLinkTargets(
  targets: LinkTarget[],
  query: string,
  opts: RankOptions = {},
): LinkTarget[] {
  const { semanticScore, limit = 30 } = opts
  const q = normalizeKey(query).trim().toLowerCase()
  const now = Date.now()

  const seen = new Set<string>()
  const out: Scored[] = []

  for (const t of targets) {
    if (!t.title) continue
    const title = normalizeKey(t.title)
    const key = title.toLowerCase()
    if (seen.has(key)) continue

    // ── 문자열 매칭 (쿼리가 있을 때) ──
    let lexical = 0
    if (q) {
      const idx = key.indexOf(q)
      if (idx === -1) continue                  // 부분일치조차 안 되면 탈락
      if (key === q)          lexical = 100     // 완전일치
      else if (idx === 0)     lexical = 60      // 접두어 일치 ("방" → "방향성")
      else if (/[\s/\-_]/.test(key[idx - 1] ?? '')) lexical = 40  // 단어 시작
      else                    lexical = 20      // 단순 포함
      // 짧은 제목일수록 정확한 매칭에 가까움
      lexical += Math.max(0, 12 - title.length) * 0.5
    }
    seen.add(key)

    // ── 캘린더 노트 감점 ──
    // 날짜 노트는 링크 대상이 되는 일이 드문데 매일 수정돼 상단을 점령한다.
    const isCalendar = CALENDAR_TYPES.has(t.type) || looksLikeDateTitle(title)
    const calendarPenalty = isCalendar ? (q ? 25 : 60) : 0

    // ── 허브 가중: 참조를 많이 받은 노트일수록 위로 (제텔카스텐) ──
    const hub = Math.min(30, Math.log2(1 + t.inbound) * 12)

    // ── PARA 폴더에 정리된 노트 소폭 가산 ──
    const filed = t.folder ? 6 : 0

    // ── 대체된 노트 감점 ──
    // 다른 노트가 supersedes로 갈아치운 노트는 더 이상 현재가 아니다.
    // Archive보다 세게 누른다 — 보관은 "지난 일"이지만 대체는 "틀린 정보"에 가깝다.
    // 그래도 완전히 숨기진 않는다: 옛 노트를 일부러 찾아볼 일이 있다.
    const supersededPenalty = t.superseded ? (q ? 30 : 70) : 0

    // ── Archive 감점 ──
    // 보관된 노트는 시의성이 낮다. 캘린더 노트만큼 세게 누르진 않는다 —
    // 이름을 알고 찾아 치면(쿼리 있음) 나와야 하므로.
    const archived = isArchived(t.folder)
    const archivePenalty = archived ? (q ? 18 : 40) : 0

    // ── 최근성: 최근 90일 안에서만 완만하게 (0~10) ──
    const days = (now - (t.updatedAt || 0)) / 86_400_000
    const recency = days < 0 ? 0 : Math.max(0, 10 - days / 9)

    // ── 의미 유사도 (B단계) ──
    const semantic = (semanticScore?.get(t.id) ?? 0) * 45

    out.push({
      t,
      score: lexical + hub + filed + recency + semantic
        - calendarPenalty - archivePenalty - supersededPenalty,
    })
  }

  out.sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title))
  return out.slice(0, limit).map(s => s.t)
}
