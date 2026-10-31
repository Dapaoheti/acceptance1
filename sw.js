/* Service Worker v6.2
   改进点（防CDN劫持）：
   1. 缓存版本升级 jf-deps-v3：激活时自动清除旧版本缓存，
      即使之前缓存过被劫持的假响应，也会被一并清除；
   2. 只缓存干净响应：status===200、未被重定向、非 text/html
      （被 DNS 劫持时返回的通常是 HTML 菠菜页/错误页，一律拒绝缓存）；
   3. 本地 vendor 文件（与页面同源，无劫持面）优先预缓存；
   4. CDN 缓存改为逐个校验下载，单个失败不影响其它资源。 */
var CACHE_NAME = "jf-deps-v5"; /* v7.30：升版清洗旧缓存（含可能被劫持的假CDN响应） */
var LOCAL_ASSETS = [
  "vendor/xlsx.full.min.js",
  "vendor/jspdf.umd.min.js",
  "vendor/html2canvas.min.js",
  "vendor/pdf.min.js",
  "vendor/pdf.worker.min.js"
];
var CDN_URLS = [];   /* v7.30：CDN 全部移除（2026-10 曾被劫持跳转菠菜站），依赖全本地 vendor */

/* 响应体检：拒绝被劫持的假响应 */
function isClean(response) {
  if (!response || response.status !== 200) return false;
  if (response.redirected) return false;
  var ct = (response.headers.get("content-type") || "").toLowerCase();
  if (ct.indexOf("text/html") !== -1) return false;
  if (/<html|<!doctype/i.test(String(text).slice(0, 500))) return false; /* HTML伪装成JS/JSON也拒收 */ /* 劫持页多为 HTML */
  return true;
}

function cacheOne(cache, url) {
  return fetch(url).then(function (res) {
    if (isClean(res)) return cache.put(url, res.clone());
    console.log("[SW] 拒绝缓存可疑响应:", url);
  }).catch(function () {
    console.log("[SW] 下载失败，跳过:", url);
  });
}

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      /* 本地文件逐个缓存；CDN 逐个校验下载，互不影响 */
      return Promise.all(
        ['./', 'index.html', 'style.css', 'dashboard.html'].concat(LOCAL_ASSETS).map(function (u) { return cacheOne(cache, u); })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      /* 清掉旧版本缓存（包括可能被污染的 jf-deps-v2） */
      return Promise.all(
        names.filter(function (n) { return n.indexOf("jf-") === 0 && n !== CACHE_NAME; }) /* 只清本应用缓存，避免误删同域其他应用 */
             .map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  var url = e.request.url;
  var isLocal = url.indexOf("/vendor/") > -1;
  var isCdn = CDN_URLS.some(function (u) { return url.indexOf(u) === 0; });
  /* 应用外壳：同源 GET 网络优先 + 缓存兜底（离线可打开） */
  if (e.request.method === "GET" && !isLocal && !isCdn && url.indexOf(self.location.origin) === 0) {
    e.respondWith(
      fetch(e.request).then(function (response) {
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function () {
        return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
          return hit || caches.match("index.html");
        });
      })
    );
    return;
  }
  if (!isLocal && !isCdn) return;

  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request).then(function (response) {
        if (isClean(response)) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, clone); });
        } else {
          console.log("[SW] 响应可疑，直接透传不缓存:", url);
        }
        return response;
      });
    })
  );
});
