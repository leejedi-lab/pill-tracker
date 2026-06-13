// 복약 체크 서비스 워커 — 앱 셸 캐싱(오프라인 지원)
// 파일을 수정하면 CACHE_VERSION을 올려야 기존 사용자에게 새 버전이 배포됩니다.
const CACHE_VERSION = 'pill-tracker-v4';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './cloud.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 네트워크 우선, 실패 시 캐시 — 항상 최신을 받되 오프라인에서도 동작
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 외부 도메인(Firebase SDK/Firestore 등)은 가로채지 않고 그대로 네트워크로 보낸다
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
