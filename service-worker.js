/* =============================================
   カゴメモ Service Worker
   Cache APIを用いてアプリの基本ファイルをキャッシュし、
   オフライン環境でも起動・閲覧・手動記録を可能にする。

   ■ 動作の流れ
   1. install : 主要ファイルをキャッシュに保存
   2. activate: 古いキャッシュを削除
   3. fetch   : リクエストをまずキャッシュから返し、
                無ければネットワークへ（cache-first 戦略）
                ただしGemini APIなど外部通信はキャッシュせず
                常にネットワークへ流す
============================================= */

// キャッシュ名（バージョンを上げると古いキャッシュが破棄される）
const CACHE_NAME = 'kagomemo-v1';

// オフラインでも動くようにキャッシュしておくファイル一覧
const URLS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

/* --- install：初回登録時に基本ファイルをキャッシュ --- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAllは1つでも失敗すると全体が失敗するため、
      // 取得できたものだけ確実にキャッシュする
      return Promise.allSettled(
        URLS_TO_CACHE.map((url) => cache.add(url))
      );
    })
  );
  // 新しいSWをすぐ有効化
  self.skipWaiting();
});

/* --- activate：古いバージョンのキャッシュを削除 --- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // すぐ制御を開始
  self.clients.claim();
});

/* --- fetch：リクエストへの応答方針 --- */
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // GETリクエスト以外はそのままネットワークへ（キャッシュ対象外）
  if (event.request.method !== 'GET') return;

  // 外部API・外部リソースはキャッシュせず常にネットワークへ。
  // Gemini APIやGoogle Fontsなどは最新の通信が必要なため。
  if (
    url.includes('generativelanguage.googleapis.com') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com')
  ) {
    return; // ブラウザの既定動作（ネットワーク）に任せる
  }

  // それ以外（自サイトのファイル）はcache-first戦略
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // キャッシュにあればそれを返す（＝オフラインでも表示できる）
      if (cached) return cached;

      // 無ければネットワークから取得し、成功すればキャッシュに保存
      return fetch(event.request)
        .then((response) => {
          // 正常なレスポンスのみキャッシュ
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // オフラインで取得できない場合はindex.htmlを返す（SPA的フォールバック）
          return caches.match('./index.html');
        });
    })
  );
});
