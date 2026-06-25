import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'

// 정적 SPA(서버 없음) — PKCE verifier/세션을 localStorage에 저장.
// 쿠키 기반 @supabase/ssr 클라이언트는 Tauri의 tauri:// 커스텀 프로토콜에서
// 동작하지 않아(쿠키 미지원) PKCE 교환이 실패함. localStorage는 Tauri/Electron/웹 공통.
let client: SupabaseClient | undefined

export function createClient(): SupabaseClient {
  if (client) return client
  client = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        // 코드 교환은 딥링크/콜백 페이지에서 수동(exchangeCodeForSession)으로 처리
        detectSessionInUrl: false,
      },
    }
  )
  return client
}
