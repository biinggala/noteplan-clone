/**
 * 줄 단위 3-way merge.
 *
 * base   = 양쪽이 공통으로 알던 마지막 서버 내용
 * local  = 이 기기에서 그 뒤에 고친 내용 (아직 저장 안 됨)
 * remote = 그 사이 다른 곳(다른 기기, MCP, 링크 이름 바꾸기)이 저장한 내용
 *
 * 서로 다른 줄을 고쳤으면 둘 다 반영한다. 같은 줄을 서로 다르게 고친 경우만
 * 'conflict' — 그때는 이 기기 쪽(local)을 남긴다. 덮어쓰는 서버 쪽 내용은
 * 저장 시 DB 트리거가 note_revisions 에 남기므로 기록에서 되찾을 수 있다.
 * (예전에는 충돌이면 이 기기에서 친 내용을 통째로 버렸다.)
 */
export interface MergeResult {
  text: string
  conflict: boolean
}

interface Hunk {
  start: number      // base 줄 인덱스 [start, end) 를
  end: number
  lines: string[]    // 이 줄들로 바꾼다
}

export function merge3(base: string, local: string, remote: string): MergeResult {
  if (local === remote) return { text: local, conflict: false }
  if (local === base) return { text: remote, conflict: false }
  if (remote === base) return { text: local, conflict: false }

  const b = base.split('\n')
  const l = local.split('\n')
  const r = remote.split('\n')
  const hl = diffHunks(b, l)
  const hr = diffHunks(b, r)

  const out: string[] = []
  let conflict = false
  let pos = 0
  let i = 0
  let j = 0
  while (i < hl.length || j < hr.length) {
    const a = hl[i]
    const c = hr[j]
    // 다음에 처리할 hunk: 시작이 앞선 것 (같으면 둘을 같이 본다)
    let take: 'l' | 'r' | 'both'
    if (!c) take = 'l'
    else if (!a) take = 'r'
    else if (overlaps(a, c)) take = 'both'
    else take = first(a, c)

    if (take === 'both') {
      // 겹치는 hunk 들을 하나의 구간으로 모은다
      let start = Math.min(a.start, c.start)
      let end = Math.max(a.end, c.end)
      const groupL: Hunk[] = [a]
      const groupR: Hunk[] = [c]
      i++; j++
      for (;;) {
        if (i < hl.length && hl[i].start < end) { end = Math.max(end, hl[i].end); groupL.push(hl[i++]); continue }
        if (j < hr.length && hr[j].start < end) { end = Math.max(end, hr[j].end); groupR.push(hr[j++]); continue }
        break
      }
      start = Math.min(start, groupL[0].start, groupR[0].start)
      copy(b, pos, start, out)
      const lv = applyRange(b, start, end, groupL)
      const rv = applyRange(b, start, end, groupR)
      if (lv.join('\n') !== rv.join('\n')) conflict = true
      out.push(...lv)   // 충돌이면 이 기기 쪽을 남긴다
      pos = end
      continue
    }
    const h = take === 'l' ? a : c
    if (take === 'l') i++; else j++
    copy(b, pos, h.start, out)
    out.push(...h.lines)
    pos = h.end
  }
  copy(b, pos, b.length, out)
  return { text: out.join('\n'), conflict }
}

function overlaps(a: Hunk, c: Hunk): boolean {
  const aIns = a.start === a.end
  const cIns = c.start === c.end
  if (aIns && cIns) return a.start === c.start            // 같은 자리에 서로 다른 삽입
  if (aIns) return c.start < a.start && a.start < c.end    // 상대가 바꾼 구간 '안'에 삽입
  if (cIns) return a.start < c.start && c.start < a.end
  return a.start < c.end && c.start < a.end                // 바꾼 구간이 겹침
}

/** 겹치지 않는 두 hunk 중 base 에서 먼저 오는 쪽 (같은 시작이면 삽입이 먼저) */
function first(a: Hunk, c: Hunk): 'l' | 'r' {
  if (a.start !== c.start) return a.start < c.start ? 'l' : 'r'
  return a.start === a.end ? 'l' : 'r'
}

function copy(src: string[], from: number, to: number, out: string[]) {
  for (let k = from; k < to; k++) out.push(src[k])
}

/** base[start,end) 구간에 hunk 들을 적용한 결과 줄 */
function applyRange(b: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const res: string[] = []
  let p = start
  for (const h of hunks) {
    copy(b, p, h.start, res)
    res.push(...h.lines)
    p = h.end
  }
  copy(b, p, end, res)
  return res
}

/** base → other 로 가는 변경 구간들 (LCS 기반, 앞뒤 공통부분은 먼저 잘라낸다) */
function diffHunks(base: string[], other: string[]): Hunk[] {
  let pre = 0
  while (pre < base.length && pre < other.length && base[pre] === other[pre]) pre++
  let suf = 0
  while (
    suf < base.length - pre && suf < other.length - pre &&
    base[base.length - 1 - suf] === other[other.length - 1 - suf]
  ) suf++

  const B = base.slice(pre, base.length - suf)
  const O = other.slice(pre, other.length - suf)
  const n = B.length, m = O.length
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0 || n * m > 4_000_000) {
    // 한쪽이 비었거나 너무 크면 가운데 전체를 한 덩어리로 본다
    return [{ start: pre, end: pre + n, lines: O }]
  }

  // LCS 길이 표 (뒤에서부터)
  const W = m + 1
  const dp = new Uint32Array((n + 1) * W)
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      dp[x * W + y] = B[x] === O[y]
        ? dp[(x + 1) * W + y + 1] + 1
        : Math.max(dp[(x + 1) * W + y], dp[x * W + y + 1])
    }
  }
  const hunks: Hunk[] = []
  let x = 0, y = 0
  let cur: Hunk | null = null
  const flush = () => { if (cur) { hunks.push(cur); cur = null } }
  while (x < n || y < m) {
    if (x < n && y < m && B[x] === O[y]) { flush(); x++; y++; continue }
    if (!cur) cur = { start: pre + x, end: pre + x, lines: [] }
    if (y < m && (x >= n || dp[x * W + y + 1] >= dp[(x + 1) * W + y])) {
      cur.lines.push(O[y]); y++
    } else {
      x++; cur.end = pre + x
    }
  }
  flush()
  return hunks
}
