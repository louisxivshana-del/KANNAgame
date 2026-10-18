// オフライン対応：初回にすべてのファイルを端末に保存し、以後はネットなしで起動できるようにする
const VERSION = 'kanna-v0.6.1';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'src/style.css',
  'src/screens.js',
  'src/ranking.js',
  'src/faces.js',
  'src/game.js',
  'vendor/decomp.min.js',
  'vendor/matter.min.js',
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/face_landmarker.task',
  'vendor/mediapipe/selfie_multiclass.tflite',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('index.html').then((r) => r || fetch(e.request));
      return fetch(e.request);
    }),
  );
});
