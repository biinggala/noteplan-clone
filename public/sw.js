// 최소 service worker — 설치 가능(PWA) + 가벼운 오프라인 셸.
// 데이터 진실원천은 Supabase(클라우드)라 네트워크 우선으로 stale 방지.
const CACHE = 'noteplan-shell-v1'
const SHELL = ['/', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  // GET 페이지 요청만 처리 (API/Supabase/POST 등은 그대로 통과)
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 네트워크 우선, 실패 시 캐시 폴백 (오프라인 셸)
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (req.mode === 'navigate') {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {})
        }
        return res
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/'))),
  )
})
