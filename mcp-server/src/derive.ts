/**
 * 본문에서 tags / mentions / backlinks 를 뽑는다.
 *
 * ⚠️ 앱의 lib/parser/noteParser.ts 와 같은 규칙이어야 한다. mcp-server는 별도
 * 패키지(rootDir: src)라 그 파일을 직접 import할 수 없어 여기 옮겨 적었다.
 * 한쪽을 고치면 다른 쪽도 같이 고칠 것.
 *
 * 이 계산을 빼먹으면 노트가 사이드바 태그 목록이나 백링크 패널에서 사라진다
 * (실제로 MCP로 만든 노트 절반이 #claude 를 달고도 tags가 비어 있었다).
 */

// #태그, @멘션 — 가-힣 가-힣, ㄱ-ㅎ ㄱ-ㅎ, ㅏ-ㅣ ㅏ-ㅣ
const KO = '가-힣ㄱ-ㅎㅏ-ㅣ'
const TAG_PATTERN = new RegExp(`#([\\w${KO}/]+)`, 'g')
const MENTION_PATTERN = new RegExp(`@([\\w${KO}/]+)`, 'g')
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g

// 링크/URL/이메일 영역 — 이 안의 #, @ 는 태그·멘션이 아니다
const LINK_MASK_PATTERN = new RegExp(
  [
    '!?\\[[^\\]]*\\]\\([^)]*\\)',                        // 마크다운 링크/이미지
    '(?:https?:\\/\\/|www\\.)[^\\s)]+',                  // raw URL
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',   // 이메일
  ].join('|'),
  'g',
)

/** 링크/URL/이메일을 같은 길이의 공백으로 치환 (오프셋 보존) */
function maskLinks(text: string): string {
  return text.replace(LINK_MASK_PATTERN, m => ' '.repeat(m.length))
}

/** 한글 NFC 정규화 — macOS 파일명은 분해형(NFD)이라 매칭이 조용히 실패한다 */
export function normalizeKey(s: string): string {
  return s.normalize('NFC')
}

export interface Derived {
  tags: string[]
  mentions: string[]
  backlinks: string[]
}

export function derive(content: string): Derived {
  const masked = maskLinks(content)
  return {
    tags: [...new Set([...masked.matchAll(TAG_PATTERN)].map(m => normalizeKey(m[1])))],
    mentions: [...new Set([...masked.matchAll(MENTION_PATTERN)].map(m => normalizeKey(m[1])))],
    backlinks: [...new Set([...content.matchAll(WIKILINK_PATTERN)].map(m => normalizeKey(m[1].trim())))],
  }
}

/** 문자열이 본문에 몇 번 나오는지 (정규식 아님 — 리터럴) */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0, i = 0
  for (;;) {
    const at = haystack.indexOf(needle, i)
    if (at === -1) return n
    n++
    i = at + needle.length
  }
}

/** 리터럴 치환 (정규식 특수문자 이스케이프 걱정 없이) */
export function replaceLiteral(
  haystack: string, needle: string, replacement: string, all: boolean,
): string {
  if (all) return haystack.split(needle).join(replacement)
  const at = haystack.indexOf(needle)
  if (at === -1) return haystack
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length)
}
