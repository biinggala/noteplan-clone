/**
 * 링크를 앱이 아니라 기본 브라우저에서 연다.
 *
 * 데스크톱(Tauri/WKWebView)에서는 window.open이 막히거나 앱 안 웹뷰로 열려서
 * 노트 앱이 브라우저가 돼버린다. Tauri에서는 opener 플러그인으로 OS에 넘긴다.
 *
 * 의존성을 일부러 가볍게 유지한다 — 에디터 익스텐션에서 부르기 때문에
 * supabase 같은 걸 끌고 오면 안 된다.
 */
const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** http(s)만 허용 — javascript:, file: 같은 스킴은 열지 않는다 */
export function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url)
}

export async function openExternal(url: string): Promise<void> {
  if (!isSafeHttpUrl(url)) {
    console.warn('[openExternal] http(s)가 아니라 무시:', url)
    return
  }
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
      return
    } catch (err) {
      console.error('[openExternal] Tauri opener 실패, 웹 방식으로 재시도', err)
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
