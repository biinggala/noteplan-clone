import { useAuthStore } from '@/lib/stores/authStore'
import { refreshGoogleAccessToken } from '@/lib/google/auth'

// 구글 캘린더 쓰기(일정 추가·타임블록 → 이벤트)는 토큰이 죽어 있으면 401로 실패한다.
// 예전엔 앱 시작 때와 50분마다만 갱신해서, 맥이 잠들었다 깨면 다음 갱신 전까지
// 만료된 토큰을 그대로 들고 있었다. 그 사이 '추가'는 아무 표시 없이 사라졌다.
// 여기서는 401이면 그 자리에서 한 번 갱신하고 다시 시도한다.

let inflight: Promise<string | null> | null = null
let lastRefreshAt = 0

/** refresh token으로 access token을 새로 받는다. 동시에 여러 번 불려도 갱신은 한 번. */
export function refreshGoogleTokenNow(): Promise<string | null> {
  if (inflight) return inflight
  inflight = (async () => {
    const { googleRefreshToken, setGoogleToken, setGoogleAuthError } = useAuthStore.getState()
    if (!googleRefreshToken) return null
    const { token, error } = await refreshGoogleAccessToken(googleRefreshToken)
    if (token) {
      lastRefreshAt = Date.now()
      setGoogleToken(token)
      setGoogleAuthError(null)
      return token
    }
    setGoogleAuthError(error ?? '구글 토큰 갱신 실패')
    return null
  })().finally(() => { inflight = null })
  return inflight
}

/** 마지막 갱신이 maxAgeMs보다 오래됐으면 갱신 (앱이 다시 앞으로 올 때용). */
export function refreshGoogleTokenIfStale(maxAgeMs: number) {
  if (Date.now() - lastRefreshAt < maxAgeMs) return
  void refreshGoogleTokenNow()
}

/**
 * 현재 토큰으로 fn을 실행하고, 만료(401)면 갱신 후 한 번 더 시도한다.
 * 토큰이 아예 없으면 GOOGLE_NOT_CONNECTED.
 */
export async function withGoogleToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = useAuthStore.getState().googleAccessToken
  if (!token) throw new Error('GOOGLE_NOT_CONNECTED')
  try {
    return await fn(token)
  } catch (err) {
    if (!(err instanceof Error && err.message === 'GOOGLE_TOKEN_EXPIRED')) throw err
    const fresh = await refreshGoogleTokenNow()
    if (!fresh) throw err
    return await fn(fresh)
  }
}

/** 사용자에게 보여줄 문장 */
export function googleErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'GOOGLE_NOT_CONNECTED') return '구글 캘린더가 연결돼 있지 않습니다. 톱니 → Google 캘린더 연결을 해주세요.'
  if (msg === 'GOOGLE_TOKEN_EXPIRED') return '구글 토큰이 만료됐고 갱신에도 실패했습니다. 재연결이 필요합니다.'
  if (/ 403: /.test(msg)) return '이 캘린더에 일정을 만들 권한이 없습니다. 다른 캘린더를 고르거나 재연결해 주세요.'
  return `구글 캘린더에 저장하지 못했습니다: ${msg.slice(0, 200)}`
}
