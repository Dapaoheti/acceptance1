/**
 * 采购智验助手 v7.40
 * 优化：变量可读性 / IndexedDB 连接缓存 / 错误处理 / 兼容性
 */
console.log("=== 采购智验助手 v7.40 ===");

/* ===================== 配置常量 ===================== */
var JF_WRITE_TOKEN = "jf-write-2026"; /* 写接口令牌（与服务端一致；配合Origin白名单） */
var DB_NAME = "JFV53";
var DB_STORE = "ph";
var DB_INDEX_KEY = "***";
var IMG_MAX_SIZE = 1400;
var JPEG_QUALITY = 0.7;

/* ===================== 应用状态 ===================== */
var currentProject = null;
var currentIndex = -1;
var cameraStream = null;
var pendingImport = null;
var lastParsedRows = null; /* 解析原始行（明细列重映射用） */
var pdfBlob = null;
var viewerIndex = 0;
var viewerPhotos = [];
var isGalleryProcessing = false;
var dupImportCount = 0; /* 本批硬判重复计数 */
var dupSimilarCount = 0; /* 本批软判相似计数 */

function getInterceptStats() {
  try {
    return JSON.parse(localStorage.getItem("jf_intercept_stats") || '{"dup":0,"similar":0,"ps":0}');
  } catch (e) { return { dup: 0, similar: 0, ps: 0 }; }
}
function addInterceptStat(type) {
  var s = getInterceptStats();
  s[type] = (s[type] || 0) + 1;
  try { localStorage.setItem("jf_intercept_stats", JSON.stringify(s)); } catch (e) {}
}
function showInterceptStats() {
  var s = getInterceptStats();
  showToast("\ud83d\udee1 \u7d2f\u8ba1\u62e6\u622a\uff1a\u91cd\u590d\u7528\u56fe " + s.dup + " \u5f20 \u00b7 \u6781\u76f8\u4f3c " + s.similar + " \u5f20 \u00b7 \u7be1\u6539 " + (s.ps || 0) + " \u5f20", 5000);
}
var hashIndexCache = null; /* 集团哈希索引缓存（本地比对零延迟） */
var hashIndexLoading = null;
var hashIndexFailedAt = 0;
var hashIndexLoadedAt = 0;

function loadHashIndex() {
  /* 下载集团哈希索引（1次），后续本地比对零网络延迟 */
  if (hashIndexCache && Date.now() - hashIndexLoadedAt < 30 * 60 * 1000) return Promise.resolve(hashIndexCache); /* 30分钟TTL，感知其他设备新指纹 */
  if (hashIndexLoading) return hashIndexLoading;
  if (hashIndexFailedAt && Date.now() - hashIndexFailedAt < 30000) return Promise.resolve([]); /* 失败后30s内不反复重试 */
  hashIndexLoading = fetch(DEFAULT_AI_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "hashes", wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""), })
  }).then(function (res) { return res.json(); }).then(function (d) {
    hashIndexCache = Array.isArray(d) ? d : (d && d.rows) || [];
    hashIndexLoadedAt = Date.now();
    hashIndexLoading = null;
    return hashIndexCache;
  }).catch(function () {
    hashIndexLoading = null;
    hashIndexFailedAt = Date.now(); /* 失败不缓存空结果，30秒后允许重试（防整个会话查重静默失效） */
    return [];
  });
  return hashIndexLoading;
}

function localHashCheck(phash, fileHash, skipAcceptNo) {
  /* 本地比对集团哈希索引（零延迟）——fileHash完全相同=硬拦；感知哈希=警告
     skipAcceptNo=本验收单号：本单自己上传的指纹=自己，一律不算重复（防自撞误报） */
  if (!hashIndexCache || (!phash && !fileHash)) return [];
  var hits = [];
  for (var i = 0; i < hashIndexCache.length; i++) {
    var r = hashIndexCache[i];
    if (skipAcceptNo && (r.acceptNo || "") === skipAcceptNo) continue; /* 自己单号的记录=自己 */
    /* ★fileHash 完全相同 = 同一文件 = 硬拦（跨项目也拦） */
    if (fileHash && r.fileHash && r.fileHash === fileHash) {
      hits.push({ hash: r.hash, fileHash: r.fileHash, date: r.date || "", acceptNo: r.acceptNo || "", project: r.project || "", name: r.name || "", idx: r.idx, dist: 0, hard: true, byFile: true });
      continue;
    }
    /* 感知哈希相似 = 警告 */
    if (phash && r.hash && hammingHex(String(r.hash), phash) <= DUP_TOLERANCE) {
      hits.push({ hash: r.hash, date: r.date || "", acceptNo: r.acceptNo || "", project: r.project || "", name: r.name || "", idx: r.idx, dist: 0, hard: false });
    }
  }
  return hits;
}
var hashCheckPending = []; /* 集团查重进行中的请求（验收前必须全部完成） */
var deleteTargetKey = null;

/* ===================== 缓存的 IndexedDB 连接 ===================== */
var cachedDb = null;

/* ===================== 工具函数 ===================== */
function padZero(n) { return String(n).padStart(2, "0"); }

function escapeHtml(str) {
  /* 文本/属性通用转义（含引号，属性上下文也安全） */
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escAttrJs(v) {
  /* onclick="fn('...')" 属性内 JS 字符串转义：先JS转义再HTML转义 */
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, " ").replace(/\u2028/g, " ").replace(/\u2029/g, " ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeForPdf(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTimestamp(str) {
  if (!str) return "";
  var m = str.match(/^\d{4}-(\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return m ? m[1] + " " + m[2] : str;
}

function formatDate(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + padZero(d.getHours()) + ":" + padZero(d.getMinutes());
}

/* ===================== IndexedDB（缓存连接） ===================== */
function openDb() {
  return new Promise(function (resolve, reject) {
    if (cachedDb) { resolve(cachedDb); return; }
    var request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = function (e) {
      cachedDb = e.target.result;
      resolve(cachedDb);
    };
    request.onerror = function (e) { reject(e.target.error); };
  });
}

function dbPut(key, value, retries) {
  retries = retries || 2;
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function (e) { reject(e.target.error || tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }).catch(function (err) {
    /* 配额不足：重试无意义，直接给出明确指引 */
    if (isQuotaError(err)) {
      handleQuotaError();
      return Promise.reject(err);
    }
    if (retries > 0) {
      return new Promise(function (r) { setTimeout(r, 300); }).then(function () {
        return dbPut(key, value, retries - 1);
      });
    }
    return Promise.reject(err);
  });
}

function dbGet(key) {
  return openDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction(DB_STORE, "readonly");
      var req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }).catch(function () { return null; });
}

function dbDel(key) {
  return openDb().then(function (db) {
    db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(key);
  }).catch(function () {});
}

/* ===================== 存储配额守护 ===================== */
var quotaWarned = false;
var spaceWarned = false;

function isQuotaError(err) {
  var name = (err && err.name) || "";
  var msg = (err && err.message) || "";
  return name.indexOf("Quota") > -1 || msg.indexOf("quota") > -1 ||
         msg.indexOf("Quota") > -1 || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function handleQuotaError() {
  if (quotaWarned) return;
  quotaWarned = true;
  showToast("\u26a0 \u672c\u5730\u5b58\u50a8\u7a7a\u95f4\u4e0d\u8db3\uff01\u8bf7\u751f\u6210PDF\u9a8c\u6536\u6587\u4ef6\u540e\uff0c\u5728\u5b8c\u6210\u9875\u70b9\u300c\u6e05\u7406\u7167\u7247\u300d\u91ca\u653e\u7a7a\u95f4");
}

function getStorageUsage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate().then(function (est) {
        if (!est || !est.quota) return null;
        return (est.usage || 0) / est.quota;
      }).catch(function () { return null; });
    }
  } catch (e) {}
  return Promise.resolve(null);
}

function checkStorageSpace() {
  getStorageUsage().then(function (pct) {
    if (pct !== null && pct > 0.85 && !spaceWarned) {
      spaceWarned = true;
      showToast("\u26a0 \u672c\u5730\u5b58\u50a8\u5df2\u4f7f\u7528" + Math.round(pct * 100) + "%\uff0c\u5efa\u8bae\u751f\u6210PDF\u540e\u6e05\u7406\u5df2\u9a8c\u6536\u7167\u7247");
    }
  });
}

function initStorageGuard() {
  try {
    /* 申请持久化存储：防止浏览器因磁盘压力自动清除验收数据 */
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
    checkStorageSpace();
  } catch (e) {}
}

/* ===================== AI 点数（视觉识别辅助验收） ===================== */
var AI_PROVIDERS = {
  mimo: {
    name: "MiMo视觉·按量付费(sk-)",
    url: "https://api.xiaomimimo.com/v1/chat/completions",
    model: "mimo-v2.6-flash"
  },
  mimotp: {
    name: "MiMo视觉·TokenPlan(tp-)",
    url: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    model: "mimo-v2.6-flash"
  },
  deepseek: {
    name: "DeepSeek 视觉",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-v4-flash-vision-exp"
  },
  qwen: {
    name: "通义千问VL",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen3-vl-plus"
  }
};

var DEFAULT_AI_PROXY = "https://1514325591-klg147a60r.ap-guangzhou.tencentscf.com"; /* SCF代理已内置，全员零配置 */

function getAiConfig() {
  try {
    return {
      mode: localStorage.getItem("jf_ai_mode") || "proxy",
      provider: localStorage.getItem("jf_ai_provider") || "deepseek",
      key: localStorage.getItem("jf_ai_key") || "",
      proxyUrl: localStorage.getItem("jf_ai_proxy") || DEFAULT_AI_PROXY || "/api/ai-count"
    };
  } catch (e) { return { mode: "proxy", provider: "deepseek", key: "", proxyUrl: DEFAULT_AI_PROXY || "/api/ai-count" }; }
}

function saveAiConfig(mode, provider, key, proxyUrl) {
  try {
    localStorage.setItem("jf_ai_mode", mode);
    localStorage.setItem("jf_ai_provider", provider);
    localStorage.setItem("jf_ai_key", key);
    localStorage.setItem("jf_ai_proxy", proxyUrl || "/api/ai-count");
  } catch (e) {}
}

function openAiSettings() {
  var cfg = getAiConfig();
  document.getElementById("aiMode").value = cfg.mode;
  document.getElementById("aiProvider").value = cfg.provider;
  document.getElementById("aiKey").value = cfg.key;
  var whInput = document.getElementById("aiWebhook");
  if (whInput) { try { whInput.value = localStorage.getItem("jf_webhook") || ""; } catch (e) {} }
  var proxyInput = document.getElementById("aiProxyUrl");
  if (proxyInput) proxyInput.value = cfg.proxyUrl;
  toggleAiModeUI();
  document.getElementById("aiModal").classList.add("active");
}

function closeAiSettings() {
  document.getElementById("aiModal").classList.remove("active");
}

function toggleAiModeUI() {
  var mode = document.getElementById("aiMode").value;
  var keyArea = document.getElementById("aiKeyArea");
  if (keyArea) keyArea.style.display = (mode === "key") ? "" : "none";
  var proxyArea = document.getElementById("aiProxyArea");
  if (proxyArea) proxyArea.style.display = (mode === "proxy") ? "" : "none";
}

function saveAiSettings() {
  var mode = document.getElementById("aiMode").value;
  var provider = document.getElementById("aiProvider").value;
  var key = document.getElementById("aiKey").value.trim();
  var proxyInput = document.getElementById("aiProxyUrl");
  var proxyUrl = proxyInput ? proxyInput.value.trim() : "";
  if (mode === "key" && !key) {
    showToast("已选自带Key模式，请填写 API Key");
    return;
  }
  if (mode === "proxy" && !proxyUrl) proxyUrl = DEFAULT_AI_PROXY || "/api/ai-count";
  saveAiConfig(mode, provider, key, proxyUrl);
  try {
    var wh = document.getElementById("aiWebhook");
    if (wh) localStorage.setItem("jf_webhook", wh.value.trim());
  } catch (e) {}
  closeAiSettings();
  showToast(mode === "proxy" ? "已保存：使用平台代理，团队共享无需Key" : "已保存：自带Key模式（仅存本机）");
}

function buildAiPrompt(item) {
  /* 实测：简单提示+800px=准确+1.5秒 */
  return "图中是「" + item.displayName + "」的验收照片。识别并计数，只输出JSON：" +
    "{\"material\":\"识别到的物料\",\"qty\":数量,\"confidence\":\"high|medium|low\",\"match\":\"high|medium|low\"}。" +
    "qty=数量（数不清填null）；match=图中物品与「" + item.displayName + "」是否一致。";
}


function aiCount() {
  if (currentIndex < 0 || !currentProject) return;
  /* 点数前图片压缩到300px：实测提速约20%（2.2s→1.9s），简单计数任务不影响准确率 */
  var item = currentProject.items[currentIndex];
  var photo = null;
  for (var i = item.photos.length - 1; i >= 0; i--) {
    if (item.photos[i].dataUrl) { photo = item.photos[i]; break; }
  }
  if (!photo) { showToast("请先拍摄/添加验收照片，再使用AI点数"); return; }

  var cfg = getAiConfig();
  if (cfg.mode === "key" && !cfg.key) {
    showToast("请先在「AI设置」中配置 API Key");
    openAiSettings();
    return;
  }
  var prompt = buildAiPrompt(item);
  /* 图片压缩到300px：实测提速约20%（2.2s→1.9s），简单计数不降准 */
  compressForAi(photo.dataUrl, 800).then(function (compressed) { /* 800px实测最快最准(1.3s/100%) */
    var photoOpt = { dataUrl: compressed };
    if (cfg.mode === "key") {
      aiCallDirect(cfg, photoOpt, prompt);
    } else {
      aiCallProxy(cfg, photoOpt, prompt);
    }
  });
}

/* 平台代理模式：Key 托管在 EdgeOne 环境变量，团队共享，前端零密钥 */
function aiCallProxy(cfg, photo, prompt) {
  var proxyUrl = cfg.proxyUrl || "/api/ai-count";
  showLoading("AI 识别中…");
  fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""), image: photo.dataUrl, prompt: prompt, model: "qwen" }) /* ★点数走千问 */
  }).then(function (res) {
    return res.json().then(function (data) {
      return { ok: res.ok, status: res.status, data: data };
    });
  }).then(function (r) {
    hideLoading();
    if (!r.ok) {
      if (r.status === 404) {
        /* 同域代理未部署（如 GitHub Pages）：回退自带Key */
        if (cfg.key) {
          showToast("平台代理不可用，已回退自带Key模式");
          aiCallDirect(cfg, photo, prompt);
        } else {
          showToast("平台代理未部署；当前环境请在AI设置中改用「自带Key」模式");
          openAiSettings();
        }
        return;
      }
      throw new Error((r.data && r.data.error) || ("HTTP " + r.status));
    }
    applyAiCount(parseAiCount(String(r.data && r.data.content || "")));
  }).catch(function (err) {
    hideLoading();
    console.error("AI代理调用失败:", err);
    showToast("AI 识别失败：" + (err && err.message ? String(err.message).slice(0, 60) : "网络错误"));
  });
}

/* 自带Key模式：浏览器直连大模型 API（个人试用/无代理环境兜底） */
function aiCallDirect(cfg, photo, prompt) {
  var p = AI_PROVIDERS[cfg.provider] || AI_PROVIDERS.deepseek;
  showLoading("AI 识别中…");
  var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 45000) : null;
  fetch(p.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": 'Bearer '  + cfg.key
    },
    body: JSON.stringify({
      model: p.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: photo.dataUrl } }
        ]
      }],
      max_tokens: 2048
    }),
    signal: ctrl ? ctrl.signal : undefined
  }).then(function (res) {
    if (timer) clearTimeout(timer);
    if (!res.ok) {
      return res.text().then(function (t) {
        var msg = t.slice(0, 120);
        if (res.status === 401) msg = "API Key 无效或已过期";
        else if (res.status === 402) msg = "API 余额不足";
        else if (res.status === 429) msg = "请求过于频繁，请稍后再试";
        throw new Error(msg);
      });
    }
    return res.json();
  }).then(function (data) {
    hideLoading();
    var text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (text && Array.isArray(text)) { text = text.map(function (c) { return c.text || ""; }).join(""); }
    applyAiCount(parseAiCount(String(text || "")));
  }).catch(function (err) {
    hideLoading();
    if (err && err.name === "AbortError") { showToast("AI 识别超时，请重试"); return; }
    console.error("AI识别失败:", err);
    showToast("AI 识别失败：" + (err && err.message ? String(err.message).slice(0, 60) : "网络错误"));
  });
}

/* 从模型回复中提取 JSON（对象或数组均支持）。
   整体解析失败时，从首个 { 或 [ 起做括号配平提取（跳过字符串内的括号）——
   不能用简单的 \{[\s\S]*\}：返回数组时会抓成内层对象块导致解析失败 */
function extractJson(text) {
  var s = String(text || "");
  try { return JSON.parse(s.trim()); } catch (e) {}
  /* 逐个候选起始点尝试：首个 {/[ 块解析失败时继续往后找（前面可能是说明性括号） */
  for (var start = 0; start < s.length; start++) {
    if (s[start] !== "{" && s[start] !== "[") continue;
    var open = s[start], close = open === "{" ? "}" : "]";
    var depth = 0, inStr = false, esc = false;
    for (var j = start; j < s.length; j++) {
      var c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, j + 1)); } catch (e2) { break; } /* 这块不是JSON，换下一个候选 */
        }
      }
    }
  }
  return null;
}

function parseAiCount(text) {
  /* 统一走 extractJson（对象返回）；数组时返回 null（调用方期望对象） */
  var r = extractJson(text);
  return (r && typeof r === "object" && !Array.isArray(r)) ? r : null;
}

function applyAiCount(result) {
  if (!result) { showToast("AI 返回内容无法解析，请重试"); return; }
  var item = currentProject.items[currentIndex];
  var qty = result.qty;
  var conf = String(result.confidence || "").toLowerCase();
  var match = String(result.match || "").toLowerCase();
  var review = String(result.review || "").trim();
  if (!review) {
    /* 模型没给意见时自动补一句简要复核意见（图文不符/存疑/置信低都要留痕进备注） */
    if (match === "low") review = "图文不符：照片与条目疑似不是同一物，请核实";
    else if (match === "medium") review = "图文存疑：请核实照片与条目对应关系";
    else if (conf && conf !== "high") review = "识别置信度" + (conf === "medium" ? "中" : "低") + "：请人工核实数量";
  }
  if (item) { item.aiMatch = match; item.aiReview = review; }

  var matchTxt = match === "high" ? "\u2705 \u56fe\u6587\u4e00\u81f4" :
    (match === "medium" ? "\u26a0\ufe0f \u56fe\u6587\u5b58\u7591\uff0c\u8bf7\u6838\u5b9e" :
      (match === "low" ? "\u274c \u56fe\u6587\u4e0d\u7b26\uff08\u7167\u7247\u4e0e\u6761\u76ee\u4e0d\u662f\u540c\u4e00\u7269\uff09" : ""));
  var confTxt = conf === "high" ? "\u9ad8" : (conf === "medium" ? "\u4e2d" : "\u4f4e");
  var num = parseFloat(qty);
  var canFill = (conf === "high" || conf === "medium") && qty !== null && qty !== undefined && isFinite(num) && match !== "low";

  /* 常驻结果面板：多行、不自动消失 */
  var level = match === "low" ? "bad" : (match === "medium" || conf === "low" || review ? "warn" : "ok");
  var lines = [];
  lines.push("\u8bc6\u522b\u7269\u6599\uff1a" + (result.material || "\u672a\u8bc6\u522b"));
  lines.push((canFill ? "\u9884\u586b\u6570\u91cf\uff1a" : "\u4f30\u6570\uff1a") + (qty !== null && qty !== undefined ? qty + (result.unit || "") : "\u65e0\u6cd5\u786e\u5b9a") + "\uff08\u7f6e\u4fe1\u5ea6 " + confTxt + "\uff09");
  if (matchTxt) lines.push("\u56fe\u6587\u6838\u5bf9\uff1a" + matchTxt);
  if (review) lines.push("\u590d\u6838\u610f\u89c1\uff1a" + review);
  if (result.note) lines.push("\u5224\u65ad\u4f9d\u636e\uff1a" + result.note);
  var box = document.getElementById("aiResult");
  if (box) {
    box.className = "ai-result ai-result-" + level;
    box.innerHTML = '<div class="ai-result-title">\ud83e\udd16 AI \u8bc6\u522b\u7ed3\u679c' +
      '<button class="ai-result-close" onclick="closeAiResult()">\u2715</button></div>' +
      lines.map(function (l) { return '<div class="ai-result-line">' + escapeHtml(l) + '</div>'; }).join("");
    box.style.display = "";
  }

  if (canFill) {
    var qField = document.getElementById("inpAQ");
    qField.value = String(num);
    if (qField.dispatchEvent) qField.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (match === "low") {
    showToast("\u26a0 \u56fe\u6587\u4e0d\u7b26\uff1a\u6761\u76ee\u4e0e\u7167\u7247\u4e0d\u662f\u540c\u4e00\u7269\uff0c\u672a\u9884\u586b\uff0c\u8bf7\u6838\u5b9e", 5000);
  }
  /* \u2605\u56fe\u6587\u590d\u5408\u610f\u89c1\u81ea\u52a8\u586b\u5165\u5907\u6ce8\u680f\uff08\u4e0d\u91cd\u590d\u8ffd\u52a0\uff0c\u540c\u65f6\u8ddf\u7740\u8fdb\u751f\u6210\u6587\u4ef6\u5907\u6ce8\u5217\uff09 */
  if (review) {
    var rEl2 = document.getElementById("inpR");
    if (rEl2 && rEl2.value.indexOf(review) < 0) {
      rEl2.value = rEl2.value ? (rEl2.value + "\uff1b" + review) : review;
      if (typeof syncFormToItem === "function") syncFormToItem();
    }
  }
  saveProject();
}

function closeAiResult() {
  var box = document.getElementById("aiResult");
  if (box) { box.style.display = "none"; box.innerHTML = ""; }
}


/* ===================== 价格台账（报价基准 + 验收简报 + 月度比对） ===================== */
function getLedger(key) {
  return dbGet(key).then(function (raw) {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
  }).catch(function () { return []; });
}

function saveLedger(key, arr) {
  return dbPut(key, JSON.stringify(arr)).catch(function (e) { console.error("ledger:", e); });
}
var _ledgerChains = {};
function ledgerUpdate(key, fn) {
  /* 台账读改写串行化：防并发覆盖/dupIdx错算（快速连拍两条相同记录不再丢） */
  _ledgerChains[key] = (_ledgerChains[key] || Promise.resolve()).then(fn).catch(function (e) { console.error("ledger:", e); });
  return _ledgerChains[key];
}

/* 报价单导入时：同类物料报价单价入账 */
function localDateStr() {
  /* 本地日期 YYYY-MM-DD：toISOString 是 UTC，凌晨 0-8 点会记到前一天/上个月 */
  var d = new Date(), m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

function recordPrices(items, source) {
  var rows = [];
  (items || []).forEach(function (it) {
    var p = parseFloat(it.origPrice);
    if (isFinite(p) && p > 0 && it.displayName) {
      rows.push({ name: it.displayName, unit: it.origUnit || "", price: p, source: source || "", date: localDateStr() });
    }
  });
  if (!rows.length) return;
  ledgerUpdate("ledger_prices", function () {
    return getLedger("ledger_prices").then(function (arr) {
      return saveLedger("ledger_prices", arr.concat(rows));
    });
  });
  uploadPrices(rows);
}

/* 验收完成时：自动上传验收简报（数量/单价/总价） */
function recordAcceptBrief(item) {
  var rec = {
    date: localDateStr(),
    time: new Date().toTimeString().slice(0, 5),
    acceptNo: currentProject.acceptNo || "",
    contractNo: currentProject.contractNo || "",
    project: currentProject.name || "",
    name: item.displayName,
    unit: item.origUnit || "",
    qty: item.acceptQty || "",
    price: item.acceptPrice || "",
    amount: item.acceptAmount || "",
    quoteQty: item.quoteQty || item.origQty || "",
    quotePrice: item.quotePrice || item.origPrice || "",
    remark: item.remark || "",
    match: item.aiMatch || "",
    review: item.aiReview || ""
  };
  ledgerUpdate("ledger_accepts", function () {
    return getLedger("ledger_accepts").then(function (arr) {
      /* dupIdx：同键记录在台账中的出现序号(0起)，服务端据此幂等去重（重试/补传不重复计数） */
      rec.dupIdx = countKeyOccurrence(arr, rec);
      arr.push(rec);
      return saveLedger("ledger_accepts", arr);
    }).then(function () { uploadBrief(rec); });
  });
  sendBriefToWebhook(rec);
}

/* 可选：企微群机器人 Webhook 上传简报 */
function sendBriefToWebhook(rec) {
  try {
    var url = localStorage.getItem("jf_webhook") || "";
    if (!url) return;
    var txt = "\u3010\u9a8c\u6536\u7b80\u62a5\u3011" + rec.date + " " + rec.time +
      "\n\u5355\u53f7\uff1a" + (rec.acceptNo || "-") +
      "\n\u9879\u76ee\uff1a" + rec.project +
      "\n\u6761\u76ee\uff1a" + rec.name +
      "\n\u6570\u91cf\uff1a" + rec.qty + (rec.unit || "") + " \u00d7 \u5355\u4ef7 " + rec.price + " = \u91d1\u989d " + rec.amount +
      (rec.review ? "\n\u590d\u6838\uff1a" + rec.review : "");
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: txt } })
    }).catch(function () {});
  } catch (e) {}
}

/* 中心上报：每单验收简报 / 报价基准 自动上传集团数据仓
 * ★v7.14 上传持久化队列：localStorage 入队 + 顺序单发（避免服务端并发） + 失败退避重试，
 *   页面 load / 网络恢复 online 自动补发——上报不再“发后不管”，彻底根治丢数 */
var UQ_KEY = "jf_upload_queue";
var uqFlushing = false;
var uqRetryTimer = null;

function uqLoad() {
  try { return JSON.parse(localStorage.getItem(UQ_KEY) || "[]"); } catch (e) { return []; }
}
function uqSave(q) {
  try { localStorage.setItem(UQ_KEY, JSON.stringify(q)); }
  catch (e) {
    console.error("上传队列保存失败:", e);
    try { showToast("\u26a0 \u5b58\u50a8\u7a7a\u95f4\u4e0d\u8db3\uff0c\u4e0a\u62a5\u961f\u5217\u53ef\u80fd\u4e22\u5931\uff0c\u8bf7\u5c3d\u5feb\u6e05\u7406\u6216\u5907\u4efd", 8000); } catch (e2) {}
  }
}

/* 去重键：与服务端 reportOne 完全一致 */
function briefKey(r) {
  return [r.acceptNo || "", r.name || "", r.qty || "", r.price || "", r.amount || "", r.date || ""].join("|");
}

/* 台账中同键(同名同额同单同日)记录已出现次数 = 新记录的 dupIdx */
function countKeyOccurrence(arr, rec) {
  var month = String(rec.date || "").slice(0, 7);
  var k = briefKey(rec);
  var n = 0;
  (arr || []).forEach(function (r) {
    if (String(r.date || "").slice(0, 7) === month && briefKey(r) === k) n++;
  });
  return n;
}

/* 单条上报（服务端返回 ok:true / dedup:true 均视为成功）；25秒超时防请求挂死 */
function sendBrief(rec) {
  var ctrl = null, timer = null;
  try {
    ctrl = new AbortController();
    timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 25000);
  } catch (e) {}
  var done = function () { if (timer) { clearTimeout(timer); timer = null; } };
  return fetch(DEFAULT_AI_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "report", wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""),  record: rec }),
    signal: ctrl ? ctrl.signal : undefined
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (d) {
      done();
      if (res.ok && d && d.ok) return d;
      throw new Error((d && d.error) || ("HTTP " + res.status));
    });
  }, function (e) {
    done();
    throw new Error(e && e.name === "AbortError" ? "上传超时(25秒)" : ((e && e.message) || "网络错误"));
  });
}

function uploadBrief(rec) {
  var q = uqLoad();
  q.push({ rec: rec, attempts: 0, ts: Date.now() });
  uqSave(q);
  flushUploadQueue();
}

/* 顺序发送：每次只发一条，发完再发下一条（避免服务端并发写冲突） */
function flushUploadQueue() {
  if (uqFlushing) return;
  var q = uqLoad();
  if (!q.length) return;
  var item = q[0];
  if (item.nextTs && Date.now() < item.nextTs) {
    /* 退避期内：到点自动重试 */
    scheduleFlush(item.nextTs - Date.now());
    return;
  }
  uqFlushing = true;
  sendBrief(item.rec).then(function () {
    var q2 = uqLoad();
    var fp = JSON.stringify(item.rec);
    for (var qi = 0; qi < q2.length; qi++) {
      if (q2[qi] && JSON.stringify(q2[qi].rec) === fp) { q2.splice(qi, 1); break; }
    }
    uqSave(q2);
    uqFlushing = false;
    scheduleFlush(400); /* 间隔400ms再发下一条，避免数据仓接口限流 */
  }).catch(function () {
    var q2 = uqLoad();
    if (q2.length) {
      q2[0].attempts = (q2[0].attempts || 0) + 1;
      /* 退避：5s、10s、20s…最大 5 分钟，服务端幂等，重试不重复计数 */
      var delay = Math.min(300000, 5000 * Math.pow(2, Math.min(q2[0].attempts - 1, 6)));
      q2[0].nextTs = Date.now() + delay;
      uqSave(q2);
      scheduleFlush(delay);
    }
    uqFlushing = false;
  });
}

function scheduleFlush(delay) {
  if (uqRetryTimer) clearTimeout(uqRetryTimer);
  uqRetryTimer = setTimeout(function () { uqRetryTimer = null; flushUploadQueue(); }, Math.max(500, delay));
}

/* ===== 补传数据仓：本地台账 vs 服务端全量记录，出现次数感知差集，逐条顺序补报 ===== */
function getDashToken() {
  try { return sessionStorage.getItem("jf_dash_token") || localStorage.getItem("jf_dash_token") || ""; } catch (e) { return ""; }
}

function fetchServerRecords(month) {
  var body = { action: "records", month: month, token: getDashToken() };
  return fetch(DEFAULT_AI_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (d) {
      if (res.status === 401) {
        /* 看板口令未存/不对：向用户要一次，存本机后重试 */
        var t = "";
        try { t = (window.prompt("补传需看板口令验证，请输入口令：") || "").trim(); } catch (e) {}
        if (!t) throw new Error("未验证口令，已取消补传");
        try { localStorage.setItem("jf_dash_token", t); } catch (e) {}
        return fetch(DEFAULT_AI_PROXY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "records", month: month, token: t })
        }).then(function (res2) {
          return res2.json().catch(function () { return {}; }).then(function (d2) {
            if (!res2.ok || !d2 || d2.error) throw new Error((d2 && d2.error) || ("HTTP " + res2.status));
            return d2.records || [];
          });
        });
      }
      if (!res.ok || !d || d.error) throw new Error((d && d.error) || ("HTTP " + res.status));
      return d.records || [];
    });
  });
}

function syncWarehouse() {
  var monthEl = document.getElementById("ldMonth");
  var month = (monthEl && monthEl.value) || new Date().toISOString().slice(0, 7);
  showToast("正在核对数据仓…");
  fetchServerRecords(month).then(function (serverRecs) {
    /* 服务端按 key 统计出现次数 */
    var serverCnt = {};
    (serverRecs || []).forEach(function (r) {
      var k = briefKey(r);
      serverCnt[k] = (serverCnt[k] || 0) + 1;
    });
    return getLedger("ledger_accepts").then(function (local) {
      var mine = local.filter(function (r) { return String(r.date || "").indexOf(month) === 0; });
      var seen = {};
      var missing = [];
      mine.forEach(function (r) {
        var k = briefKey(r);
        var d = seen[k] || 0;
        seen[k] = d + 1;
        /* 出现次数感知：服务端第 n 次出现只能抵消本地 dupIdx<n 的那条 */
        if ((serverCnt[k] || 0) <= d) {
          var rec = {};
          for (var p in r) if (Object.prototype.hasOwnProperty.call(r, p)) rec[p] = r[p];
          rec.dupIdx = d;
          missing.push(rec);
        }
      });
      if (!missing.length) { showToast("✓ 数据仓已同步，无需补传"); return 0; }
      showToast("发现 " + missing.length + " 条未上报，开始顺序补传…");
      /* 逐条顺序上报（带 dupIdx）：单条失败不中断整批——入持久化队列退避重试，继续下一条 */
      var sent = 0, failed = 0, firstErr = "";
      var gap = function () { return new Promise(function (r) { setTimeout(r, 400); }); }; /* 发送间隔防数据仓限流 */
      var chain = Promise.resolve();
      missing.forEach(function (rec, i) {
        chain = chain.then(function () {
          return gap().then(function () { return sendBrief(rec); }).then(function () {
            sent++;
            if ((i + 1) % 5 === 0 || i === missing.length - 1) showToast("补传中 " + (i + 1) + "/" + missing.length + "…", 1200);
          }).catch(function (e) {
            failed++;
            if (!firstErr) firstErr = (e && e.message) ? String(e.message) : "未知错误";
            try {
              var q = uqLoad();
              q.push({ rec: rec, attempts: 0, ts: Date.now() });
              uqSave(q);
            } catch (e2) {}
          });
        });
      });
      return chain.then(function () {
        if (!failed) { showToast("✓ 补传 " + sent + " 条", 3500); return sent; }
        showToast("补传完成 " + sent + " 条，" + failed + " 条失败已排队自动重试", 6000);
        /* 弹框直显完整错误（toast单行截断看不全），并复制到剪贴板方便发回 */
        var detail = "补传失败详情（请把这段文字发回给助理）：\n\n" + (firstErr || "未知错误") +
          "\n\n成功 " + sent + " 条，失败 " + failed + " 条已排队自动重试";
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(detail);
        } catch (e) {}
        try { alert(detail); } catch (e) {}
        flushUploadQueue();
        return sent;
      });
    });
  }).catch(function (e) {
    showToast("补传失败：" + (e && e.message ? e.message : "网络错误"));
  });
}

function uploadPrices(rows) {
  try {
    fetch(DEFAULT_AI_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prices", wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""),  rows: rows })
    }).catch(function () {});
  } catch (e) {}
}

/* 月度汇总：按物料比对验收单价 vs 报价基准 */
function buildMonthlyRows(month) {
  return Promise.all([getLedger("ledger_accepts"), getLedger("ledger_prices")]).then(function (res) {
    var accepts = res[0], prices = res[1];
    var filtered = accepts.filter(function (r) { return !month || String(r.date || "").indexOf(month) === 0; });
    var groups = {};
    filtered.forEach(function (r) {
      var k = r.name;
      if (!groups[k]) groups[k] = { name: k, unit: r.unit, count: 0, amountSum: 0, priceSum: 0, hasPrice: 0, reviews: [] };
      var g = groups[k];
      g.count++;
      g.amountSum += parseFloat(r.amount) || 0;
      var p = parseFloat(r.price);
      if (isFinite(p) && p > 0) { g.priceSum += p; g.hasPrice++; }
      if (r.review) g.reviews.push(r.review);
    });
    var rows = Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.avgAcceptPrice = g.hasPrice ? g.priceSum / g.hasPrice : 0;
      /* 报价基准：最新一条同名报价 */
      var base = null;
      for (var i = prices.length - 1; i >= 0; i--) {
        if (prices[i].name === k && prices[i].price > 0) { base = prices[i].price; break; }
      }
      g.basePrice = base;
      g.diffPct = (base && g.avgAcceptPrice) ? ((g.avgAcceptPrice - base) / base * 100) : null;
      return g;
    });
    rows.sort(function (x, y) { return Math.abs(y.diffPct || 0) - Math.abs(x.diffPct || 0); });
    return rows;
  });
}

function openLedgerView() {
  var sel = document.getElementById("ldMonth");
  getLedger("ledger_accepts").then(function (accepts) {
    var months = [];
    accepts.forEach(function (r) {
      var m = String(r.date || "").slice(0, 7);
      if (m && months.indexOf(m) < 0) months.push(m);
    });
    months.sort().reverse();
    if (!months.length) months.push(new Date().toISOString().slice(0, 7));
    sel.innerHTML = months.map(function (m) { return '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>'; }).join("");
    document.getElementById("ledgerModal").classList.add("active");
    renderLedger();
  });
}

function closeLedgerView() { document.getElementById("ledgerModal").classList.remove("active"); }

function renderLedger() {
  var month = document.getElementById("ldMonth").value;
  buildMonthlyRows(month).then(function (rows) {
    var el = document.getElementById("ldTable");
    if (!rows.length) { el.innerHTML = '<p style="color:#8a99ab;font-size:.8rem;text-align:center;padding:20px 0;">\u672c\u6708\u6682\u65e0\u9a8c\u6536\u8bb0\u5f55</p>'; return; }
    var html = '<table class="ld-table"><tr><th>\u7269\u6599</th><th>\u62a5\u4ef7\u57fa\u51c6</th><th>\u9a8c\u6536\u5747\u4ef7</th><th>\u5dee\u5f02</th><th>\u6b21\u6570</th><th>\u9a8c\u6536\u603b\u989d</th></tr>';
    rows.forEach(function (g) {
      var diffTxt = "\u2014", diffStyle = "";
      if (g.diffPct !== null && isFinite(g.diffPct)) {
        diffTxt = (g.diffPct > 0 ? "+" : "") + g.diffPct.toFixed(1) + "%";
        if (Math.abs(g.diffPct) >= 5) diffStyle = g.diffPct > 0 ? "color:#e5484d;font-weight:700;" : "color:#22a06b;font-weight:700;";
      }
      html += '<tr>' +
        '<td style="text-align:left;">' + escapeHtml(g.name) + '</td>' +
        '<td>' + (g.basePrice ? g.basePrice.toFixed(2) : '\u2014') + '</td>' +
        '<td>' + (g.avgAcceptPrice ? g.avgAcceptPrice.toFixed(2) : '\u2014') + '</td>' +
        '<td style="' + diffStyle + '">' + diffTxt + '</td>' +
        '<td>' + g.count + '</td>' +
        '<td>' + g.amountSum.toFixed(2) + '</td></tr>';
    });
    html += '</table>';
    el.innerHTML = html;
    el._rows = rows; el._month = month;
  });
}

/* ===== 数据备份/恢复（微信缓存会被清，备份到文件永不丢） ===== */
/* ===== 接力验收：单项目导出/导入 ===== */
function exportCurrentProject() {
  if (!currentProject) { showToast("\u8bf7\u5148\u6253\u5f00\u9879\u76ee"); return; }
  var data = {
    type: "relay",
    project: currentProject,
    exportTime: new Date().toISOString(),
    note: "\u63a5\u529b\u9a8c\u6536\u6570\u636e\uff0c\u5bf9\u65b9\u5bfc\u5165\u540e\u7ee7\u7eed\u9a8c\u6536"
  };
  var blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  var a2 = document.createElement("a");
  a2.href = URL.createObjectURL(blob);
  a2.download = "\u63a5\u529b_" + (currentProject.name || "\u9879\u76ee") + "_" + localDateStr() + ".json";
  a2.style.display = "none";
  document.body.appendChild(a2); /* iOS必须入DOM才走下载，否则页面直接显示JSON代码 */
  a2.click();
  setTimeout(function () { try { document.body.removeChild(a2); URL.revokeObjectURL(a2.href); } catch (e) {} }, 4000);
  showToast("\ud83d\udcbe \u5df2\u5bfc\u51fa\u63a5\u529b\u6570\u636e\uff0c\u53d1\u7ed9\u4e0b\u4e00\u4eba\u5bfc\u5165\u5373\u53ef\u63a5\u7eed", 4000);
}

function importRelayData() {
  var input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var data = JSON.parse(ev.target.result);
        if (data.type !== "relay" || !data.project) { showToast("\u4e0d\u662f\u63a5\u529b\u6570\u636e\u6587\u4ef6"); return; }
        var proj = sanitizeImportedProject(data.project);
        if (!proj) { showToast("\u63a5\u529b\u6587\u4ef6\u683c\u5f0f\u975e\u6cd5"); return; }
        proj.key = "proj_relay_" + Date.now();
        proj._relayImported = true;
        var req = indexedDB.open(DB_NAME, 2);
        req.onsuccess = function (e2) {
          var db = e2.target.result;
          var tx = db.transaction(DB_STORE, "readwrite");
          tx.objectStore(DB_STORE).put(proj, proj.key);
          tx.oncomplete = function () {
            showToast("\u2705 \u5df2\u5bfc\u5165\u300c" + (proj.name || "\u9879\u76ee") + "\u300d\uff0c\u53ef\u7ee7\u7eed\u9a8c\u6536", 4000);
            if (typeof refreshHome === "function") refreshHome();
          };
        };
      } catch (err) {
        showToast("\u5bfc\u5165\u5931\u8d25\uff1a" + err.message, 4000);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function exportAllData() {
  var data = { projects: [], aiConfig: {}, exportTime: new Date().toISOString() };
  try { data.aiConfig = JSON.parse(localStorage.getItem("jf_ai_config") || "{}"); } catch (e) {}
  var req = indexedDB.open(DB_NAME, 2);
  req.onsuccess = function (e) {
    var db = e.target.result;
    var tx = db.transaction(DB_STORE, "readonly");
    var store = tx.objectStore(DB_STORE);
    var all = store.getAll();
    all.onsuccess = function () {
      data.projects = all.result || [];
      var blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      var a2 = document.createElement("a");
      a2.href = URL.createObjectURL(blob);
      a2.download = "JF\u9a8c\u6536\u6570\u636e\u5907\u4efd_" + localDateStr() + ".json";
      a2.click();
      showToast("\ud83d\udcbe \u5df2\u5bfc\u51fa" + data.projects.length + "\u6761\u6570\u636e\uff0c\u8bf7\u4fdd\u5b58\u5230\u5b89\u5168\u4f4d\u7f6e", 4000);
    };
  };
}

function sanitizeImportedProject(proj) {
  /* 导入白名单清洗：结构/字段长度/dataUrl格式/哈希格式（防恶意备份·接力文件注入） */
  if (!proj || typeof proj !== 'object') return null;
  if (typeof proj.name === 'string' && proj.name.length > 200) proj.name = proj.name.slice(0, 200);
  if (!Array.isArray(proj.items)) proj.items = [];
  proj.items.forEach(function (it) {
    if (!it || typeof it !== 'object') return;
    ['sortKey', 'displayNum', 'displayName', 'origQty', 'origUnit', 'origPrice', 'origAmount',
     'quoteQty', 'quotePrice', 'acceptQty', 'acceptPrice', 'acceptAmount', 'aiMatch',
     'acceptNo', 'contractNo'].forEach(function (f) {
      if (it[f] != null) it[f] = String(it[f]).slice(0, 80);
    });
    ['remark', 'aiReview'].forEach(function (f) {
      if (it[f] != null) it[f] = String(it[f]).slice(0, 300);
    });
    if (!Array.isArray(it.photos)) it.photos = [];
    it.photos.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      if (!/^data:image\/(jpeg|png|gif|webp);base64,/i.test(p.dataUrl || '')) p.dataUrl = '';
      if (typeof p.hash === 'string' && !/^[0-9a-fA-F]{8,64}$/.test(p.hash)) p.hash = '';
      if (typeof p.fileHash === 'string' && !/^[0-9a-fA-F]{8,64}$/.test(p.fileHash)) p.fileHash = '';
    });
  });
  return proj;
}

function importAllData() {
  var input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var data = JSON.parse(ev.target.result);
        if (!data.projects) { showToast("\u5907\u4efd\u6587\u4ef6\u683c\u5f0f\u9519\u8bef"); return; }
        var req = indexedDB.open(DB_NAME, 2);
        req.onsuccess = function (e2) {
          var db = e2.target.result;
          var tx = db.transaction(DB_STORE, "readwrite");
          var store = tx.objectStore(DB_STORE);
          var cnt = 0;
          data.projects.forEach(function (p0) {
            var p = sanitizeImportedProject(p0);
            if (!p) return;
            var key = (typeof p.key === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(p.key)) ? p.key : ("proj_restore_" + Date.now() + "_" + cnt);
            store.put(p, key);
            cnt++;
          });
          tx.oncomplete = function () {
            showToast("\u2705 \u5df2\u6062\u590d" + cnt + "\u6761\u6570\u636e", 4000);
            if (typeof refreshHome === "function") refreshHome();
          };
        };
      } catch (err) {
        showToast("\u6062\u590d\u5931\u8d25\uff1a" + err.message, 4000);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function exportLedgerExcel() {
  var el = document.getElementById("ldTable");
  var rows = el._rows || [];
  if (!rows.length) { showToast("\u65e0\u53ef\u5bfc\u51fa\u6570\u636e"); return; }
  var aoa = [["\u7269\u6599", "\u62a5\u4ef7\u57fa\u51c6(\u5143)", "\u9a8c\u6536\u5747\u4ef7(\u5143)", "\u5dee\u5f02", "\u9a8c\u6536\u6b21\u6570", "\u9a8c\u6536\u603b\u989d(\u5143)", "\u590d\u6838\u63d0\u793a"]];
  rows.forEach(function (g) {
    aoa.push([g.name, g.basePrice || "", g.avgAcceptPrice ? g.avgAcceptPrice.toFixed(2) : "",
      g.diffPct !== null && isFinite(g.diffPct) ? (g.diffPct > 0 ? "+" : "") + g.diffPct.toFixed(1) + "%" : "",
      g.count, g.amountSum.toFixed(2), (g.reviews || []).join(" / ")]);
  });
  var ws = XLSX.utils.aoa_to_sheet(aoa);
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "\u6708\u5ea6\u53f0\u8d26");
  XLSX.writeFile(wb, "\u9a8c\u6536\u6708\u62a5_" + (el._month || "") + ".xlsx");
  showToast("\u5df2\u5bfc\u51fa Excel");
}

/* ===================== 项目索引管理 ===================== */
function getIndex() {
  return dbGet(DB_INDEX_KEY).then(function (raw) {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
  }).catch(function () { return []; });
}

function saveIndex(idx) { return dbPut(DB_INDEX_KEY, JSON.stringify(idx)); }

function updateProjectIndex() {
  if (!currentProject || !currentProject.key) return;
  getIndex().then(function (idx) {
    var found = false;
    var doneCount = currentProject.items.filter(function (x) { return x.accepted; }).length;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].key === currentProject.key) {
        idx[i].name = currentProject.name;
        idx[i].done = doneCount;
        idx[i].total = currentProject.items.length;
        idx[i].updatedAt = Date.now();
        idx[i].contractNo = currentProject.contractNo || "";
        idx[i].acceptNo = currentProject.acceptNo || "";
        idx[i].amount = acceptedAmountSum();
        found = true;
        break;
      }
    }
    if (!found) {
      idx.push({
        key: currentProject.key, name: currentProject.name,
        done: doneCount, total: currentProject.items.length, updatedAt: Date.now(),
        contractNo: currentProject.contractNo || "", acceptNo: currentProject.acceptNo || "",
        amount: acceptedAmountSum()
      });
    }
    saveIndex(idx);
  });
}

function acceptedAmountSum() {
  if (!currentProject) return 0;
  var sum = 0;
  currentProject.items.forEach(function (x) {
    if (x.accepted) sum += parseFloat(x.acceptAmount) || 0;
  });
  return Math.round(sum * 100) / 100;
}

/* 集团照片哈希：批量上报 + 批量比对（100张=1次请求，秒级） */
var hashQueue = [];       /* 待上报/比对的指纹队列 */
var hashFlushTimer = null;

function queueHashCheck(rec) {
  hashQueue.push(rec);
  updateHashStatus();
  if (hashFlushTimer) clearTimeout(hashFlushTimer);
  hashFlushTimer = setTimeout(flushHashQueue, 600); /* 静默期后批量提交 */
}

function flushHashQueue() {
  if (!hashQueue.length) return Promise.resolve();
  updateHashStatus();
  var batch = hashQueue.slice();
  hashQueue = [];
  var hashes = batch.map(function (r) { return r.hash; }).filter(Boolean);
  /* 顺序关键：必须先查重、后上传指纹。
     若先上传，照片会匹配到自己刚入库的记录（距离0），导致全部误判重复 */
  var req = fetch(DEFAULT_AI_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "checkHash", hashes: hashes })
  }).then(function (res) { return res.json(); }).then(function (d) {
    if (d && d.matches && d.matches.length) applyHashMatches(d.matches, batch);
    batch.forEach(function (r) { markHashChecked(r.hash); });
  }).catch(function () {
    /* 失败不标"已检"：回队10秒后重试（防弱网下查重静默失效/指纹丢失） */
    batch.forEach(function (r) {
      if (!hashQueue.some(function (q) { return q.hash === r.hash && q.fileHash === r.fileHash; })) hashQueue.push(r);
    });
    updateHashStatus();
    if (hashFlushTimer) clearTimeout(hashFlushTimer);
    hashFlushTimer = setTimeout(flushHashQueue, 10000);
  }).then(function () {
    /* 查重完成后再上传指纹入集团库 + 立即更新本地索引（下次查重必命中） */
    fetch(DEFAULT_AI_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "hashes", wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""),  rows: batch })
    }).then(function () {
      /* ★上传成功后立即入本地索引缓存 */
      if (!hashIndexCache) hashIndexCache = [];
      batch.forEach(function (r) {
        if (r.hash) {
          var exists = hashIndexCache.some(function (x) { return x.hash === r.hash; });
          if (!exists) hashIndexCache.push(r);
        }
      });
    }).catch(function () {});
    var i2 = hashCheckPending.indexOf(req);
    if (i2 > -1) hashCheckPending.splice(i2, 1);
  });
  hashCheckPending.push(req);
  return req;
}

function applyHashMatches(matches, ownRows) {
  if (!currentProject || !matches || !matches.length) return;
  /* 自我排除：本验收单自己上传的指纹记录不算重复 */
  matches = matches.filter(function (m) {
    /* 本验收单自己上传的指纹=自己，不算重复 */
    if (currentProject && currentProject.acceptNo && (m.acceptNo || "") === currentProject.acceptNo) return false;
    return !(ownRows || []).some(function (o) {
      return o.hash === m.hash && (o.acceptNo || "") === (m.acceptNo || "") && (o.name || "") === (m.name || "");
    });
  });
  if (!matches.length) return;
  var changed = false;
  var first = matches[0];
  var label = (first.project || first.acceptNo || "\u96c6\u56e2") + (first.acceptNo ? "/" + first.acceptNo : "");
  var hitHashes = {};
  matches.forEach(function (m) { if (m.hash) hitHashes[m.hash] = m; });
  currentProject.items.forEach(function (it) {
    (it.photos || []).forEach(function (p) {
      if (p.hash && hitHashes[p.hash]) {
        var m = hitHashes[p.hash];
        var _dist = m.dist || 0;
        if (_dist <= DUP_TOLERANCE && !p.dupGlobal) { /* 按客户端阈值重新分级，不依赖服务端 hard 布尔 */
          p.dupGlobal = 1;
          p.dupGlobalOf = "\u96c6\u56e2:" + label;
          p.duplicate = 1;
          p.dupOf = p.dupGlobalOf;
          changed = true;
        } else if (_dist <= DUP_SIMILAR && !p.duplicate && !p.dupSimilar) {
          p.dupSimilar = 1;
          p.dupSimilarOf = "\u96c6\u56e2:" + label;
          changed = true;
        }
      }
    });
  });
  if (changed) {
    saveProject();
    renderPhotoGrid();
    showToast("\u26a0 \u68c0\u51fa " + matches.length + " \u5f20\u7167\u7247\u4e0e\u96c6\u56e2\u5176\u4ed6\u5355\u636e\u91cd\u590d\uff1a" + label + "\uff0c\u8bf7\u6838\u5b9e", 5000);
  }
}

function markHashChecked(phash) {
  try {
    if (!currentProject) return;
    currentProject.items.forEach(function (it) {
      (it.photos || []).forEach(function (p) {
        if (p.hash === phash) p.groupChecked = 1;
      });
    });
  } catch (e) {}
}

function whenHashChecksDone() {
  return Promise.all(hashCheckPending.slice()).catch(function () {});
}

/* ===== 全量图文核对（自动）：每张照片AI核对是否与报价明细对应 ===== */
var AUTO_VERIFY_KEY = "JF-auto-verify";
var verifyQueue = {};
var verifyTimer = null;
var verifyBusy = false;

function autoVerifyEnabled() {
  try { return localStorage.getItem(AUTO_VERIFY_KEY) !== "0"; } catch (e) { return true; }
}

function toggleAutoVerify() {
  var on = !autoVerifyEnabled();
  try { localStorage.setItem(AUTO_VERIFY_KEY, on ? "1" : "0"); } catch (e) {}
  var btn = document.getElementById("btnAutoVerify");
  if (btn) btn.textContent = "\ud83e\udd16 \u81ea\u52a8\u56fe\u6587\u6838\u5bf9\uff1a" + (on ? "\u5f00" : "\u5173");
  showToast("\u81ea\u52a8\u56fe\u6587\u6838\u5bf9\u5df2" + (on ? "\u5f00\u542f" : "\u5173\u95ed") + (on ? "\uff08\u6d88\u8017\u5c11\u91cfAI\u989d\u5ea6\uff09" : ""));
  updateHashStatus();
}

function queueAutoVerify(item) {
  if (!autoVerifyEnabled() || !item) return;
  verifyQueue[item.sortKey || item.displayNum || "x"] = true;
  if (verifyTimer) clearTimeout(verifyTimer);
  verifyTimer = setTimeout(runAutoVerify, 2500);
  updateHashStatus();
}

function runAutoVerify() {
  if (verifyBusy || !currentProject) return;
  var keys = Object.keys(verifyQueue);
  verifyQueue = {};
  if (!keys.length) return;
  verifyBusy = true;
  setTimeout(function () { if (verifyBusy) { verifyBusy = false; updateHashStatus(); if (Object.keys(verifyQueue).length) runAutoVerify(); } }, 120000); /* 看门狗：AI挂起2分钟自动解锁防死锁 */
  var chain = Promise.resolve();
  keys.forEach(function (k) {
    var item = currentProject.items.filter(function (it) { return (it.sortKey || it.displayNum) === k; })[0];
    if (item) chain = chain.then(function () { return verifyItemPhotos(item); });
  });
  chain.then(function () {
    verifyBusy = false;
    if (Object.keys(verifyQueue).length) runAutoVerify();
  }).catch(function () { verifyBusy = false; updateHashStatus(); });
}

function verifyItemPhotos(item) {
  var pend = [];
  (item.photos || []).forEach(function (p, idx) {
    if (!p.aiVerify && !p.duplicate) pend.push({ p: p, idx: idx });
  });
  if (!pend.length) return Promise.resolve();
  var batches = [];
  for (var i = 0; i < pend.length; i += 4) batches.push(pend.slice(i, i + 4));
  var chain = Promise.resolve();
  batches.forEach(function (batch) {
    chain = chain.then(function () { return verifyBatch(item, batch); });
  });
  return chain;
}

function verifyBatch(item, batch) {
  var prompt = "\u4f60\u662f\u8d39\u7528\u9a8c\u6536\u56fe\u6587\u6838\u5bf9\u5458\u3002\u9a8c\u6536\u6761\u76ee\uff1a\u300a" + item.displayName +
    "\u300b\uff0c\u89c4\u683c\uff1a" + (item.sku || "\u65e0") +
    "\u3002\u9644\u4e0a" + batch.length + "\u5f20\u7167\u7247\uff0c\u8bf7\u9010\u5f20\u5224\u65ad\u7167\u7247\u62cd\u6444\u5bf9\u8c61\u662f\u5426\u4e0e\u8be5\u6761\u76ee\u5bf9\u5e94\uff08\u5546\u54c1/\u7269\u6599/\u670d\u52a1\u5185\u5bb9\u4e00\u81f4\uff09\u3002" +
    "\u53ea\u8f93\u51faJSON\uff0c\u4e0d\u8981\u5176\u4ed6\u6587\u5b57\uff1a{\"photos\":[{\"idx\":1,\"match\":\"high|medium|low\",\"note\":\"\u7406\u7531\u226410\u5b57\"}]}\uff0cidx\u4e3a\u7167\u7247\u5e8f\u53f7\u4e00\u5f20\u5f00\u59cb\u3002\uff08high=\u660e\u786e\u4e00\u81f4 medium=\u5b58\u7591 low=\u660e\u663e\u4e0d\u7b26\uff09";
  return aiFetchTextMulti(prompt, batch.map(function (x) { return x.p.dataUrl; })).then(function (txt) {
    var res = extractJson(txt) || {};
    (res.photos || []).forEach(function (r) {
      var t = batch[(parseInt(r.idx, 10) || 1) - 1];
      if (t) { t.p.aiVerify = String(r.match || "").toLowerCase(); t.p.aiVerifyNote = r.note || ""; }
    });
    batch.forEach(function (x) { if (!x.p.aiVerify) x.p.aiVerify = "skip"; });
    renderPhotoGrid();
    updateHashStatus();
  }).catch(function () {
    batch.forEach(function (x) { if (!x.p.aiVerify) x.p.aiVerify = "skip"; });
    updateHashStatus();
  });
}

/* ===== 防伪/核对状态透明化 ===== */
function reverifyProjectGroupDups() {
  if (!currentProject) return;
  var rows = [];
  currentProject.items.forEach(function (it) {
    (it.photos || []).forEach(function (p, idx) {
      if (!p.hash) return;
      if (p.dupOf && p.dupOf.indexOf("\u96c6\u56e2") === 0) {
        p.duplicate = 0; p.dupOf = ""; p.dupGlobal = 0; p.dupGlobalOf = "";
      }
      rows.push({ hash: p.hash, acceptNo: currentProject.acceptNo || "", project: currentProject.name || "", name: it.displayName, idx: idx });
    });
  });
  if (!rows.length) return;
  fetch(DEFAULT_AI_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "checkHash", hashes: rows.map(function (r) { return r.hash; }) })
  }).then(function (res) { return res.json(); }).then(function (d) {
    if (d && d.matches && d.matches.length) applyHashMatches(d.matches, rows);
    saveProject();
    renderPhotoGrid();
    updateHashStatus();
  }).catch(function () {});
}

function updateHashStatus() {
  var el = document.getElementById("hashStatus");
  if (!el) return;
  var item = (currentProject && currentIndex > -1) ? currentProject.items[currentIndex] : null;
  var parts = [];
  if (hashQueue.length || hashCheckPending.length) parts.push("\ud83d\udd0d \u9632\u4f2a\u6821\u9a8c\u4e2d\u2026");
  else parts.push("\ud83d\udd0d \u9632\u4f2a\u5df2\u6821\u9a8c");
  var dups = item ? (item.photos || []).filter(function (p) { return p.duplicate; }).length : 0;
  if (dups) parts.push("\u26a0 " + dups + "\u5f20\u91cd\u590d\u7528\u56fe\uff08\u62e6\u622a\uff09");
  var sims = item ? (item.photos || []).filter(function (p) { return p.dupSimilar; }).length : 0;
  if (sims) parts.push("\u26a1 " + sims + "\u5f20\u6781\u76f8\u4f3c\uff08\u4e0d\u62e6\u622a\uff09");
  if (autoVerifyEnabled() && item) {
    var pend = (item.photos || []).filter(function (p) { return !p.aiVerify && !p.duplicate; }).length;
    if (pend) parts.push("\ud83e\udd16 \u56fe\u6587\u6838\u5bf9\u4f59" + pend + "\u5f20");
    else parts.push("\ud83e\udd16 \u56fe\u6587\u6838\u5bf9\u5b8c\u6210");
  }
  el.textContent = parts.join(" \u00b7 ");
}

/* ===================== 合同预警 + 照片查重 ===================== */
function updateContractWarn() {
  /* 合同累计验收金额超限预警 */
  var warnEl = document.getElementById("contractWarn");
  if (!warnEl) return;
  warnEl.style.display = "none";
  warnEl.textContent = "";
  if (!currentProject || !currentProject.contractAmount) return;
  getIndex().then(function (idx) {
    var sum = 0;
    idx.forEach(function (e) {
      if (e.contractNo && e.contractNo === currentProject.contractNo && e.key !== currentProject.key) {
        sum += parseFloat(e.amount) || 0;
      }
    });
    sum += acceptedAmountSum();
    var limit = parseFloat(currentProject.contractAmount) || 0;
    if (limit > 0 && sum > limit + 0.001) {
      warnEl.textContent = "\u26a0 \u5408\u540c\u7d2f\u8ba1\u9a8c\u6536\u91d1\u989d " + sum.toFixed(2) + " \u5143\u5df2\u8d85\u51fa\u5408\u540c\u91d1\u989d " + limit.toFixed(2) + " \u5143";
      warnEl.style.display = "block";
    }
  });
}

/* 照片查重：感知哈希 dHash（本地计算，不上传） */
function perceptualHash(canvas) {
  try {
    var c = document.createElement("canvas");
    c.width = 9; c.height = 8;
    var ctx = c.getContext("2d");
    /* ★禁用插值：确保缩放确定性（同一张图必得同一哈希） */
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, 9, 8);
    var d = ctx.getImageData(0, 0, 9, 8).data;
    var bits = [];
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        var i = (y * 9 + x) * 4, j = (y * 9 + x + 1) * 4;
        var l1 = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        var l2 = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        bits.push(l1 > l2 ? 1 : 0);
      }
    }
    var hex = "";
    for (var k = 0; k < 64; k += 4) {
      hex += (bits[k] * 8 + bits[k + 1] * 4 + bits[k + 2] * 2 + bits[k + 3]).toString(16);
    }
    return hex;
  } catch (e) { return ""; }
}

/* 两级查重：≤2=同一张图(硬判重复拦截)；3~5=极相似(软提示不拦截)；
   同场景连拍/多角度一般≥6，不再误伤 */
var DUP_TOLERANCE = 2;   /* 硬判重复：0-2=同一张图（压缩/转发变体3-4归软提示，防不同照片误伤） */
var DUP_SIMILAR = 5;     /* 极相似：3-5=同场景多角度，只提示不拦截 */

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 99;
  var dist = 0;
  for (var i = 0; i < a.length; i++) {
    var x = (parseInt(a[i], 16) || 0) ^ (parseInt(b[i], 16) || 0);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

function findDuplicatePhoto(hash, excludePhoto) {
  /* excludePhoto=要排除的照片对象（用引用比较，不跳过同哈希的其他照片） */
  var hard = "", soft = "";
  currentProject.items.forEach(function (it) {
    (it.photos || []).forEach(function (p, j) {
      if (!p.hash) return;
      if (excludePhoto && p === excludePhoto) return; /* 只排除自己（对象引用），同哈希的其他照片照样报 */
      var d = hammingHex(p.hash, hash);
      if (!hard && d <= DUP_TOLERANCE) hard = it.displayNum + "-" + (j + 1);
      else if (!soft && d <= DUP_SIMILAR) soft = it.displayNum + "-" + (j + 1);
    });
  });
  return hard ? { dup: hard, similar: soft } : (soft ? { dup: "", similar: soft } : null);
}

function recomputeDupFlags() {
  if (!currentProject) return;
  var seen = {};
  currentProject.items.forEach(function (it) {
    (it.photos || []).forEach(function (p, j) {
      if (!p.hash) return;
      p.duplicate = 0; p.dupOf = ""; p.dupSimilar = 0; p.dupSimilarOf = "";
      var label = it.displayNum + "-" + (j + 1);
      for (var s2 in seen) {
        var d = hammingHex(seen[s2].hash, p.hash);
        if (d <= DUP_TOLERANCE) { p.duplicate = 1; p.dupOf = seen[s2].label; break; }
        if (d <= DUP_SIMILAR) { p.dupSimilar = 1; p.dupSimilarOf = seen[s2].label; }
      }
      if (!p.duplicate) seen[label] = { hash: p.hash, label: label };
    });
  });
}

/* ===================== 项目数据持久化 ===================== */
function saveProject() {
  if (!currentProject || !currentProject.key) return;
  var data = {
    key: currentProject.key, name: currentProject.name, createdAt: currentProject.createdAt,
    contractNo: currentProject.contractNo || "", contractName: currentProject.contractName || "",
    contractAmount: currentProject.contractAmount || "", acceptNo: currentProject.acceptNo || "",
    items: currentProject.items.map(function (item) {
      return {
        sortKey: item.sortKey, displayNum: item.displayNum, displayName: item.displayName,
        origQty: item.origQty, origUnit: item.origUnit, origPrice: item.origPrice, origAmount: item.origAmount,
        quoteQty: item.quoteQty, quotePrice: item.quotePrice,
        acceptQty: item.acceptQty || "", acceptPrice: item.acceptPrice || "",
        acceptAmount: item.acceptAmount || "", remark: item.remark || "",
        aiMatch: item.aiMatch || "", aiReview: item.aiReview || "",
        photos: item.photos.map(function (p) { return { date: p.date, location: p.location, hash: p.hash || "", duplicate: p.duplicate || 0, dupOf: p.dupOf || "", dupGlobal: p.dupGlobal || 0, dupGlobalOf: p.dupGlobalOf || "" }; }),
        accepted: item.accepted
      };
    })
  };
  dbPut(currentProject.key, JSON.stringify(data))
    .then(function () { return updateProjectIndex(); })
    .catch(function (e) {
      console.error("saveProject:", e);
      try { showToast("\u26a0 \u4fdd\u5b58\u5931\u8d25\uff1a\u672c\u5730\u5b58\u50a8\u7a7a\u95f4\u4e0d\u8db3\uff0c\u8bf7\u6e05\u7406\u540e\u91cd\u8bd5", 6000); } catch (e2) {}
    });
}

function loadProjectData(key) {
  return dbGet(key).then(function (raw) {
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !data.items) return null;
    return Promise.all(data.items.map(function (item) {
      return Promise.all((item.photos || []).map(function (photo, j) {
        return dbGet(photoDataKey(key, item.sortKey, j)).then(function (url) {
          if (url) photo.dataUrl = url;
        });
      })).then(function () { return item; });
    })).then(function () { return data; });
  }).catch(function () { return null; });
}

function deleteProject(key) {
  return loadProjectData(key).then(function (data) {
    if (data && data.items) {
      data.items.forEach(function (item) {
        for (var j = 0; j < (item.photos || []).length; j++) {
          dbDel(photoDataKey(key, item.sortKey, j));
        }
      });
    }
    dbDel(key);
    return getIndex().then(function (idx) {
      idx = idx.filter(function (e) { return e.key !== key; });
      return saveIndex(idx);
    });
  });
}

function photoDataKey(projectKey, itemSortKey, photoIndex) {
  return "pk_" + projectKey + "_" + itemSortKey + "_" + photoIndex;
}

/* ===================== 地理位置 ===================== */
function getLocation() {
  return new Promise(function (resolve) {
    try {
      if (!navigator.geolocation) return resolve("");
      var done = false;
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          if (done) return; done = true;
          var lat = pos.coords.latitude, lng = pos.coords.longitude;
          var coordStr = Math.abs(lat).toFixed(4) + "\u00b0" + (lat >= 0 ? "N" : "S") + ", " +
            Math.abs(lng).toFixed(4) + "\u00b0" + (lng >= 0 ? "E" : "W");
          /* 逆地理编码：坐标→具体地址（同坐标带缓存，失败/超时回退坐标） */
          var cacheKey = "geo_" + lat.toFixed(3) + "_" + lng.toFixed(3);
          try {
            var cached = localStorage.getItem(cacheKey);
            if (cached) return resolve(cached);
          } catch (e) {}
          var settled = false;
          var fallbackTimer = setTimeout(function () {
            if (!settled) { settled = true; resolve(coordStr); }
          }, 6000);
          fetch(DEFAULT_AI_PROXY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "geocode", wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""), lat: lat, lng: lng })
          }).then(function (res) { return res.json(); }).then(function (d) {
            if (settled) return;
            settled = true; clearTimeout(fallbackTimer);
            var addr = (d && d.address) ? String(d.address).trim() : "";
            if (addr) {
              try { localStorage.setItem(cacheKey, addr); localStorage.setItem("jf_last_addr", addr); } catch (e) {}
              resolve(addr);
            } else {
              resolve(coordStr);
            }
          }).catch(function () {
            if (settled) return;
            settled = true; clearTimeout(fallbackTimer);
            resolve(coordStr);
          });
        },
        function () {
          if (!done) {
            done = true;
            /* GPS失败 → 用上次成功定位兜底（避免水印无地址） */
            var last = "";
            try { last = localStorage.getItem("jf_last_addr") || ""; } catch (e) {}
            resolve(last || "");
          }
        },
        { timeout: 8000, maximumAge: 60000 }
      );
      setTimeout(function () {
        if (!done) {
          done = true;
          var last2 = "";
          try { last2 = localStorage.getItem("jf_last_addr") || ""; } catch (e) {}
          resolve(last2 || "");
        }
      }, 12000);
    } catch (e) { resolve(""); }
  });
}

/* ===================== 水印 ===================== */
function applyWatermark(canvas, dateStr, location) {
  var ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
  if (!ctx) return;
  /* 样式：底部居中 —— 大字 HH:mm + 小字 YYYY.MM.DD 星期X + 红色定位针 + 地点（小尺寸，不出画） */
  var m = String(dateStr || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  var timeText, dateText = "";
  if (m) {
    timeText = m[4] + ":" + m[5];
    var dt = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    var weekNames = ["\u661f\u671f\u65e5", "\u661f\u671f\u4e00", "\u661f\u671f\u4e8c", "\u661f\u671f\u4e09", "\u661f\u671f\u56db", "\u661f\u671f\u4e94", "\u661f\u671f\u516d"];
    dateText = m[1] + "." + m[2] + "." + m[3] + " " + weekNames[dt.getDay()];
  } else {
    timeText = String(dateStr || "");
  }
  var locText = location || "";
  var font = '"PingFang SC","Microsoft YaHei",sans-serif';

  var bigSize = Math.max(15, Math.round(h * 0.058));
  var smallSize = Math.max(9, Math.round(bigSize * 0.42));
  var pad = Math.round(h * 0.032);

  /* 时间超宽自适应 */
  ctx.font = "600 " + bigSize + "px " + font;
  var tw = ctx.measureText(timeText).width;
  if (tw > w * 0.5) {
    bigSize = Math.max(15, Math.floor(bigSize * w * 0.5 / tw));
    smallSize = Math.max(9, Math.round(bigSize * 0.42));
  }

  /* 第二行超宽自适应缩字 */
  var pinR = smallSize * 0.45;
  ctx.font = "500 " + smallSize + "px " + font;
  var lw = dateText ? ctx.measureText(dateText).width : 0;
  var rw = locText ? ctx.measureText(locText).width : 0;
  var pinW = (dateText && locText) ? pinR * 3.2 : 0;
  var total = lw + pinW + rw;
  if (total > w * 0.88) {
    smallSize = Math.max(9, Math.floor(smallSize * w * 0.88 / total));
    pinR = smallSize * 0.45;
    ctx.font = "500 " + smallSize + "px " + font;
    lw = dateText ? ctx.measureText(dateText).width : 0;
    rw = locText ? ctx.measureText(locText).width : 0;
    pinW = (dateText && locText) ? pinR * 3.2 : 0;
    total = lw + pinW + rw;
  }

  var y2 = h - pad;
  var y1 = y2 - smallSize * 2.2;

  /* 第一行：大字时间 */
  ctx.font = "600 " + bigSize + "px " + font;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = Math.max(2, bigSize / 12); ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,.30)";
  ctx.strokeText(timeText, w / 2, y1);
  ctx.fillStyle = "rgba(255,255,255,.93)";
  ctx.fillText(timeText, w / 2, y1);

  /* 第二行：日期星期 + 红色定位针 + 地点 */
  ctx.font = "500 " + smallSize + "px " + font;
  var startX = w / 2 - total / 2;
  ctx.textAlign = "left";
  ctx.lineWidth = Math.max(1.5, smallSize / 8); ctx.lineJoin = "round";
  function drawWhiteText(t, x) {
    ctx.strokeStyle = "rgba(0,0,0,.30)";
    ctx.strokeText(t, x, y2);
    ctx.fillStyle = "rgba(255,255,255,.93)";
    ctx.fillText(t, x, y2);
  }
  if (dateText) drawWhiteText(dateText, startX);
  if (dateText && locText) {
    var px = startX + lw + pinW / 2, py = y2 - pinR * 1.7;
    ctx.beginPath();
    ctx.arc(px, py, pinR, 0, Math.PI * 2);
    ctx.moveTo(px - pinR * 0.82, py + pinR * 0.45);
    ctx.lineTo(px + pinR * 0.82, py + pinR * 0.45);
    ctx.lineTo(px, py + pinR * 2.3);
    ctx.closePath();
    ctx.fillStyle = "#e0453e";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, pinR * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }
  if (locText) drawWhiteText(locText, startX + lw + pinW);
}

/* ===================== 文件转 Canvas ===================== */
function fileToCanvas(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (w <= 0 || h <= 0) { reject(new Error("Invalid image size")); return; }
          if (w > IMG_MAX_SIZE || h > IMG_MAX_SIZE) {
            var ratio = Math.min(IMG_MAX_SIZE / w, IMG_MAX_SIZE / h);
            w = Math.round(w * ratio); h = Math.round(h * ratio);
          }
          var c = document.createElement("canvas"); c.width = w; c.height = h;
          var ctx = c.getContext("2d");
          if (!ctx) { reject(new Error("Canvas not supported")); return; }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error("Image load failed")); };
      img.src = reader.result;
    };
    reader.onerror = function () { reject(new Error("File read failed")); };
    reader.readAsDataURL(file);
  });
}

/* ===================== 自动保存 ===================== */
var _autoSaveTimer = null;
function autoSave(immediate) {
  /* 防抖保存：输入变更500ms合并一次落库（大项目全量序列化开销大）；
     immediate=true 用于页面隐藏/关闭前，立即保存不等待 */
  if (immediate) {
    if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
    if (currentIndex < 0 || !currentProject) return;
    syncFormToItem();
    saveProject();
    return;
  }
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(function () {
    _autoSaveTimer = null;
    if (currentIndex < 0 || !currentProject) return;
    syncFormToItem();
    saveProject();
  }, 500);
}

/* ===================== 导入报价单 ===================== */
function pickFile() {
  try {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.xlsx,.xls,.csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv";
    input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;z-index:99999;overflow:hidden;pointer-events:auto";
    input.addEventListener("change", function (e) { handleFileImport(e); setTimeout(function () { try { document.body.removeChild(input); } catch (x) {} }, 5000); });
    document.body.appendChild(input);
    input.click();
  } catch (err) { showToast("打开文件选择器失败: " + err.message); }
}

/* XLSX解析库自愈加载：仅本地 vendor（v7.30 移除全部 CDN 兜底，防 DNS 劫持） */
function ensureXlsx() {
  return new Promise(function (resolve, reject) {
    if (typeof XLSX !== "undefined") return resolve();
    var urls = ["vendor/xlsx.full.min.js"]; /* v7.30：仅本地同源，CDN 全部移除（防劫持） */
    var i = 0;
    var tryNext = function () {
      if (i >= urls.length) return reject(new Error("xlsx-lib"));
      var s = document.createElement("script");
      s.src = urls[i++];
      s.onload = function () { (typeof XLSX !== "undefined") ? resolve() : tryNext(); };
      s.onerror = tryNext;
      document.head.appendChild(s);
    };
    tryNext();
  });
}

function handleFileImport(e) {
  var file = e.target.files[0];
  if (!file) return;
  var ext = file.name.replace(/.*\./, "").toLowerCase();
  console.log("文件:", file.name, "大小:", file.size, "格式:", ext);

  if (ext === "pdf") { handlePdfImport(file); return; }
  if (typeof XLSX === "undefined") {
    showToast("\u89e3\u6790\u5e93\u672a\u52a0\u8f7d\uff0c\u81ea\u52a8\u91cd\u8bd5\u4e2d\u2026");
    ensureXlsx().then(function () { parseExcelFile(file, ext); }).catch(function () {
      showToast("\u8868\u683c\u89e3\u6790\u5e93\u52a0\u8f7d\u5931\u8d25\uff08\u7f51\u7edc\u53d7\u9650\uff09\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5", 4000);
    });
    return;
  }
  parseExcelFile(file, ext);
}

function parseExcelFile(file, ext) {

  if (ext === "csv") {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var wb = XLSX.read(ev.target.result, { type: "string" });
        parseWorkbook(wb, file.name);
      } catch (err) { showToast("CSV解析失败: " + err.message); }
    };
    reader.onerror = function () { showToast("文件读取失败"); };
    reader.readAsBinaryString(file);
  } else {
    var reader = new FileReader();
    var readRetry = 0;
    reader.onload = function (ev) {
      try {
        var rawBuf = ev.target.result;
        console.log("ArrayBuffer读取完成, 大小:", rawBuf.byteLength, "/", file.size);
        /* 小米WebView读取完整性校验：文件读不全是Bad compressed size的根因 */
        if (rawBuf.byteLength !== file.size && readRetry < 2) {
          readRetry++;
          console.warn("读取不完整(" + rawBuf.byteLength + "/" + file.size + ")，重试", readRetry);
          reader.readAsArrayBuffer(file);
          return;
        }
        if (rawBuf.byteLength !== file.size) {
          showToast("\u274c \u6587\u4ef6\u8bfb\u53d6\u4e0d\u5b8c\u6574(" + rawBuf.byteLength + "/" + file.size + "B)\uff0c\u8bf7\u4ece\u6587\u4ef6\u7ba1\u7406\u5668\u91cd\u65b0\u9009\u62e9\u6587\u4ef6", 5000);
          return;
        }
        var u8 = new Uint8Array(new Uint8Array(rawBuf)); /* 防御性拷贝：小米XWeb分离原buffer致字节损坏 */
        /* 文件头校验：xlsx=PK(zip) / xls=OLE复合文档；都不是=链接/占位假文件 */
        var isZip = u8[0] === 0x50 && u8[1] === 0x4B;
        var isOle = u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0;
        if (!isZip && !isOle) {
          showToast("\u274c \u8be5\u6587\u4ef6\u4e0d\u662f\u6709\u6548\u7684Excel\uff08\u6587\u4ef6\u5934\u5f02\u5e38\uff0c\u53ef\u80fd\u662f\u94fe\u63a5/\u5360\u4f4d\u6587\u4ef6\uff09\uff0c\u8bf7\u5728WPS\u4e2d\u53e6\u5b58\u4e3a .xlsx \u540e\u91cd\u8bd5", 5000);
          return;
        }
        /* Uint8Array 兼容传参：部分安卓WebView下裸ArrayBuffer解析报错 */
        var wb = XLSX.read(u8, { type: "array" });
        parseWorkbook(wb, file.name);
      } catch (err1) {
        console.warn("ArrayBuffer解析失败(" + file.size + "B):", err1.message);
        tryParseAsText(file, file.name);
      }
    };
    reader.onerror = function () { showToast("文件读取失败"); };
    reader.readAsArrayBuffer(file);
  }
}

function tryParseAsText(file, fileName) {
  /* 降级路径：DataURL→base64（最可靠；readAsText会把zip二进制当UTF-8解码→字节损坏） */
  var reader = new FileReader();
  reader.onload = function (ev) {
    try {
      var b64 = String(ev.target.result || "").split(",")[1] || "";
      var wb = XLSX.read(b64, { type: "base64" });
      parseWorkbook(wb, fileName);
    } catch (err) {
      console.warn("base64模式也失败:", err.message);
      tryParseAsBase64(file, fileName);
    }
  };
  reader.readAsDataURL(file);
}

function tryParseAsBase64(file, fileName) {
  var reader = new FileReader();
  reader.onload = function (ev) {
    try {
      var b64 = ev.target.result.split(",")[1];
      var wb = XLSX.read(b64, { type: "base64" });
      parseWorkbook(wb, fileName);
    } catch (err) {
      console.error("所有解析方式均失败:", err.message);
      showToast("\u89e3\u6790\u5931\u8d25\uff1a" + (err && err.message ? err.message : "\u672a\u77e5") + "\n\u8bf7\u5c1d\u8bd5\uff1a1.\u7528WPS\u53e6\u5b58\u4e3a.xlsx 2.\u6216\u5bfc\u51faCSV", 5000);
    }
  };
  reader.readAsDataURL(file);
}

function parseWorkbook(workbook, fileName) {
  var sheet = workbook.Sheets[workbook.SheetNames[0]];
  var rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log("解析完成:", rows.length, "行");
  if (!rows.length || rows.length < 2) { showToast("Excel无数据或行数不足"); return; }

  var excelTitle = "";
  if (rows[0]) {
    var firstCell = String(rows[0][0] || "").trim();
    if (firstCell && firstCell !== "\u5e8f\u53f7" && !/^\d+$/.test(firstCell)) excelTitle = firstCell;
  }

  /* 缓存原始行：明细列选择器/重映射依赖它（此前Excel路径缺失，导致列选择失灵） */
  lastParsedRows = rows.map(function (r) { return (r || []).map(function (c) { return c == null ? "" : String(c); }); });

  /* 明细列自动检测：文本最丰富的列（真实报价单明细常在第2/3列，且有合并单元格） */
  var nameIdx = detectNameCol(lastParsedRows);
  var roles = detectRoles(lastParsedRows);
  var runParse = function (strict) {
    window.STRICT_ROWS = strict;
    var items = [];
    var carry = {};
    lastParsedRows.forEach(function (cells) {
      var row = cells.slice();
      /* 合并单元格语义：明细列左侧的组名/分类列向下继承 */
      for (var c = 0; c < nameIdx; c++) {
        var cv = String(row[c] == null ? "" : row[c]).trim();
        if (cv) carry[c] = cv;
        else if (carry[c]) row[c] = carry[c];
      }
      var it = mapRowCells(row, nameIdx, roles);
      if (it) items.push(it);
    });
    return items;
  };
  var items = runParse(true);
  if (!items.length) {
    /* 宽松兜底：限价/描述类报价单（数字不全）按宽松规则导入，人工在预览核对 */
    items = runParse(false);
    if (items.length) showToast("\u26a0 \u8be5\u62a5\u4ef7\u5355\u6570\u5b57\u4e0d\u5168\uff08\u5982\u9650\u4ef7/\u63cf\u8ff0\u7c7b\uff09\uff0c\u5df2\u6309\u5bbd\u677e\u6a21\u5f0f\u5bfc\u5165\uff0c\u8bf7\u5728\u9884\u89c8\u4e2d\u6838\u5bf9");
  }
  window.STRICT_ROWS = true;
  items.forEach(function (it, idx) { it.sortKey = idx; it.displayNum = String(idx + 1); });
  if (!items.length) { showToast("\u672a\u8bc6\u522b\u5230\u660e\u7ec6\uff0c\u8bf7\u5728\u9884\u89c8\u91cc\u9009\u62e9\u6b63\u786e\u7684\u660e\u7ec6\u5217"); return; }

  aiOptimizeDisplayNames(items); /* AI智能显示名（异步不阻塞） */
  var projName = excelTitle || fileName.replace(/\.[^.]+$/, "");
  var allText = "";
  for (var r = 0; r < rows.length && r < 30; r++) allText += " " + (rows[r] || []).join(" ");
  showImportConfirm(projName, items, extractContractNo(allText));
}

/* ===================== 导入确认（合同信息） ===================== */
function extractContractNo(text) {
  var m = String(text || "").match(/(?:合同编号|合同号|协议编号)[：:\s]*([A-Za-z0-9][A-Za-z0-9\-_\/]{2,})/);
  return m ? m[1] : "";
}

function showImportConfirm(name, items, contractNoHint) {
  pendingImport = { name: name, items: items, autoItems: JSON.parse(JSON.stringify(items)), contractNo: "", contractName: "", contractAmount: "", acceptNo: "" };
  document.getElementById("imName").value = name;
  document.getElementById("imContractNo").value = contractNoHint || "";
  document.getElementById("imContractName").value = "";
  document.getElementById("imContractAmount").value = "";
  try { document.getElementById("imNameCol").value = "-1"; } catch (e) {}
  bindImPreview();
  document.getElementById("importModal").classList.add("active");
}

/* 共享：行→明细映射。名称列后的数字列映射数量/单价/金额（≥3个取首/倒二/末） */
function mapRowCells(cells, nameIdx, roles) {
  /* 行级拦截：任一列是小计/合计标记 → 整行剔除（组名继承洗白也拦得住） */
  var labelCnt = 0;
  for (var si = 0; si < cells.length; si++) {
    if (subtotalCell(cells[si])) return null;
    if (headerLabel(cells[si])) labelCnt++;
  }
  /* 表头行识别：≥3个标签格（如"序号|报价名称|规格|单位|数量|单价"）→ 整行剔除 */
  if (labelCnt >= 3) return null;
  var name = String(cells[nameIdx] == null ? "" : cells[nameIdx]).replace(/\s+/g, " ").trim();
  if (!name) {
    /* 名称列为空 → 兜底：名称可能分布在其他列（如"区域"列=品名、"规格"列为空）。
       取本行最长文本列作为名称；必须含数值，否则视为分节标题行丢弃 */
    var hasNum = cells.some(function (v, ci) {
      if (ci === 0) return false; /* 序号列的数字不算（分节行常带序号） */
      var t = String(v == null ? "" : v).replace(/[,\s￥¥]/g, "").replace(/（[^）]*）|\([^)]*\)/g, "");
      return t && /^-?\d+(\.\d+)?$/.test(t);
    });
    if (!hasNum) return null;
    var bestT = "", bestLen = 0;
    cells.forEach(function (v, ci) {
      if (roles && ((roles.qty && roles.qty.indexOf(ci) >= 0) || (roles.price && roles.price.indexOf(ci) >= 0) || (roles.amount && roles.amount.indexOf(ci) >= 0))) return;
      var t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
      if (!t || isSubtotalRow(t) || /^[\d.\-]+$/.test(t)) return;
      if (headerLabel(t)) return;
      if (t.length > bestLen) { bestLen = t.length; bestT = t; }
    });
    if (!bestT || bestT.length > 40) return null; /* 超长文本视为条款/说明行，不作明细 */
    name = bestT;
  }
  if (!name || isSubtotalRow(name)) return null;
  if (/^[\d.\-]+$/.test(name)) return null;
  if (headerLabel(name)) return null;
  /* 显示名：只取名称列核心（去规格/数字），组名不进列表名避免同组混淆 */
  var rawName = String(cells[nameIdx] == null ? "" : cells[nameIdx]).replace(/\s+/g, " ").trim();
  var nameSeg = rawName.split(/[：:，,、（(【\[\s]/)[0].trim();
  name = nameSeg.length > 2 ? nameSeg : rawName;
  if (name.length > 14) name = name.substring(0, 14);
  var cleanNum = function (v) {
    var t = String(v == null ? "" : v).replace(/[,\s￥¥]/g, "").replace(/（[^）]*）|\([^)]*\)/g, "");
    return (t && /^-?\d+(\.\d+)?$/.test(t)) ? t : "";
  };
  var qty = "", price = "", amount = "";
  if (roles && roles.qty && roles.qty.length) {
    var pick = function (idxs) {
      for (var k = 0; k < (idxs || []).length; k++) {
        var t = cleanNum(cells[idxs[k]]);
        if (t) return t;
      }
      return "";
    };
    qty = pick(roles.qty); price = pick(roles.price); amount = pick(roles.amount);
  } else {
    /* 无表头：名称列后的数字列按位置映射 */
    var after = [];
    for (var i = 0; i < cells.length; i++) {
      if (i <= nameIdx) continue;
      var t = cleanNum(cells[i]);
      if (t) after.push(t);
    }
    if (after.length >= 3) { qty = after[0]; price = after[after.length - 2]; amount = after[after.length - 1]; }
    else if (after.length === 2) { qty = after[0]; price = after[1]; }
    else if (after.length === 1) { qty = after[0]; }
  }
  /* ★正向规则（用户规则）：数量有数 + 单价或合价有数 才算明细。
     小计/税金/表头/条款/无价行（如"酒店提供"）全部自然出局，不再依赖黑名单 */
  if (window.STRICT_ROWS !== false) {
    if (!qty || (!price && !amount)) return null;
  }
  return makeQuoteItem(0, name, qty, "", price, amount);
}

/* 表头语义角色检测：数量/单价/金额各自的列（最高限价≠单价，不混入） */
function detectRoles(rows) {
  if (!rows) return null;
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r] || [];
    var qty = [], price = [], amount = [], hitQ = false, hitP = false, hitA = false;
    for (var c = 0; c < cells.length; c++) {
      var h = String(cells[c] == null ? "" : cells[c]).replace(/\s+/g, "");
      if (!h) continue;
      if (/限价/.test(h)) continue;
      if (/数量|暂估|工程量|面积|个数/.test(h)) { qty.push(c); hitQ = true; }
      else if (/单价/.test(h)) { price.push(c); hitP = true; }
      else if (/金额|合价|总价/.test(h)) { amount.push(c); hitA = true; }
    }
    if (hitQ && hitP && hitA) return { qty: qty, price: price, amount: amount };
    if (hitQ && hitP) return { qty: qty, price: price, amount: amount };
  }
  return null;
}

/* 明细列自动检测：取"去重后非数字文本最多"的列（明细名最丰富） */
function detectNameCol(rows) {
  if (!rows || !rows.length) return 0;
  var ncols = 0;
  rows.forEach(function (r) { if (r && r.length > ncols) ncols = r.length; });
  var best = 0, bestScore = -1, bestLen = 0;
  for (var c = 0; c < ncols; c++) {
    var seen = {}, score = 0, textLen = 0;
    rows.forEach(function (r) {
      if (!r) return;
      var v = String(r[c] == null ? "" : r[c]).replace(/\s+/g, " ").trim();
      if (!v || isSubtotalRow(v) || /^[\d.\-/]+$/.test(v)) return;
      var v0 = v.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
      if (/^(序号|名称|物料名称|产品名称|产品|产品业态|项目|项目名称|规格|明细|说明|单价|投标单价|数量|暂估数量|暂估面积|金额|合价|报价|最高限价|限价|备注)$/.test(v0)) return;
      if (!seen[v]) { seen[v] = 1; score++; }
      textLen += v.length;
    });
    /* 同分优先取文本总长最大的列（信息量大=更可能是明细名称列） */
    if (score > bestScore || (score === bestScore && score > 0 && textLen > bestLen)) {
      bestScore = score; best = c; bestLen = textLen;
    }
  }
  return best;
}

/* 小计/合计/制表信息行过滤（非制式报价单中间常插小计行） */
function isSubtotalRow(name) {
  var t = String(name || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  /* 括号内出现"合计"不作小计行（如"手举牌（多次合计）"是正文明细） */
  t = t.replace(/（[^）]*）|\([^)]*\)/g, "");
  return /小计|合计|总计|金额合计|增值税|税金|税费|税额|税率|含税|不含税|人民币|大写|备注|签字|盖章|制表|审核|审批/.test(t);
}

/* 行级小计格判定：任一列（剥括号后）含小计/合计/总计 → 整行是小计行 */
function subtotalCell(v) {
  var t = String(v == null ? "" : v).replace(/\s+/g, " ").trim().replace(/（[^）]*）|\([^)]*\)/g, "");
  return /小计|合计|总计|增值税|税金|税费|含税总价|价税合计|不含税总价|含税合价|不含税合价/.test(t);
}

/* 表头标签判定：剥括号/单位后精确命中常见表头词（"报价名称/不含税单价（元）"等都算） */
function headerLabel(v) {
  var t = String(v == null ? "" : v).replace(/\s+/g, " ").trim().replace(/（[^）]*）|\([^)]*\)/g, "");
  return /^(序号|编号|名称|物料名称|报价名称|产品名称|产品|产品业态|区域|项目|项目名称|规格|规格与描述|明细|说明|单位|数量|暂估数量|暂估面积|暂估工程量|工程量|单价|投标单价|不含税单价|含税单价|最高限价|限价|金额|合价|不含税合价|含税合价|总价|报价|备注|税率|税额|序|类别|分类|品牌|型号|材质|工艺|服务内容|工作内容)$/.test(t);
}

/* 可编辑明细预览：名称/数量/单价/金额直接改，错行可删除 */
function bindImPreview() {
  var box = document.getElementById("imPreview");
  if (!box || !pendingImport) return;
  var html = pendingImport.items.map(function (it, i) {
    return '<div style="display:flex;gap:3px;align-items:center;margin:3px 0;">' +
      '<input style="flex:2.2;min-width:0;padding:4px 6px;font-size:.72rem;border:1px solid var(--bdr);border-radius:4px;" value="' + escapeHtml(it.displayName) + '" onchange="editImItem(' + i + ',\'name\',this.value)" title="明细名称">' +
      '<input style="flex:1;min-width:0;padding:4px 4px;font-size:.72rem;border:1px solid var(--bdr);border-radius:4px;" value="' + escapeHtml(it.origQty || "") + '" placeholder="数量" onchange="editImItem(' + i + ',\'qty\',this.value)">' +
      '<input style="flex:1;min-width:0;padding:4px 4px;font-size:.72rem;border:1px solid var(--bdr);border-radius:4px;" value="' + escapeHtml(it.origPrice || "") + '" placeholder="单价" onchange="editImItem(' + i + ',\'price\',this.value)">' +
      '<input style="flex:1.15;min-width:0;padding:4px 4px;font-size:.72rem;border:1px solid var(--bdr);border-radius:4px;" value="' + escapeHtml(it.origAmount || "") + '" placeholder="金额" onchange="editImItem(' + i + ',\'amount\',this.value)">' +
      '<button style="border:none;background:none;color:#e5484d;font-size:.85rem;padding:2px 5px;" onclick="delImItem(' + i + ')" title="删除此行">✕</button>' +
      '</div>';
  }).join("");
  box.innerHTML = html || '<div class="im-row" style="opacity:.6">无明细</div>';
  document.getElementById("imCount").textContent = "识别到 " + pendingImport.items.length + " 项（可编辑）";
}

function editImItem(i, field, val) {
  if (!pendingImport || !pendingImport.items[i]) return;
  var it = pendingImport.items[i];
  if (field === "name") { it.displayName = String(val).trim(); }
  else if (field === "qty") { it.origQty = String(val).replace(/[,\s]/g, ""); it.quoteQty = it.origQty; }
  else if (field === "price") { it.origPrice = String(val).replace(/[,\s￥¥]/g, ""); it.quotePrice = it.origPrice; }
  else if (field === "amount") { it.origAmount = String(val).replace(/[,\s￥¥]/g, ""); }
}

function delImItem(i) {
  if (!pendingImport) return;
  pendingImport.items.splice(i, 1);
  pendingImport.items.forEach(function (it, idx) { it.sortKey = idx; it.displayNum = String(idx + 1); });
  bindImPreview();
}

/* 明细列重映射：非模版报价单明细在第2/3列时手动指定，按位置映射数量/单价/金额 */
function reparseNameCol() {
  if (!pendingImport) return;
  var sel = parseInt(document.getElementById("imNameCol").value, 10);
  if (sel < 0 || !lastParsedRows) {
    if (pendingImport.autoItems) {
      pendingImport.items = JSON.parse(JSON.stringify(pendingImport.autoItems));
      bindImPreview();
    }
    return;
  }
  var roles = detectRoles(lastParsedRows);
  var runSel = function (strict) {
    window.STRICT_ROWS = strict;
    var items = [];
    var carry = {};
    lastParsedRows.forEach(function (cells) {
      var row = cells.slice();
      for (var c = 0; c < sel; c++) {
        var cv = String(row[c] == null ? "" : row[c]).trim();
        if (cv) carry[c] = cv;
        else if (carry[c]) row[c] = carry[c];
      }
      var it = mapRowCells(row, sel, roles);
      if (it) items.push(it);
    });
    return items;
  };
  var items = runSel(true);
  if (!items.length) items = runSel(false);
  window.STRICT_ROWS = true;
  items.forEach(function (it, idx) { it.sortKey = idx; it.displayNum = String(idx + 1); });
  pendingImport.items = items;
  bindImPreview();
}

function cancelImport() {
  document.getElementById("importModal").classList.remove("active");
  pendingImport = null;
}

function confirmImport() {
  if (!pendingImport) return;
  var cno = document.getElementById("imContractNo").value.trim();
  pendingImport.name = document.getElementById("imName").value.trim() || pendingImport.name;
  pendingImport.contractNo = cno;
  pendingImport.contractName = document.getElementById("imContractName").value.trim();
  pendingImport.contractAmount = document.getElementById("imContractAmount").value.trim();
  document.getElementById("importModal").classList.remove("active");
  /* 验收单自动编号：统一 YS-{序号}（全局递增，不带合同号） */
  getIndex().then(function (idx) {
    var maxSeq = 0;
    idx.forEach(function (e) {
      if (e.acceptNo) {
        var m = String(e.acceptNo).match(/^YS-(\d+)$/);
        if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10) || 0);
      }
    });
    pendingImport.acceptNo = "YS-" + ("00" + (maxSeq + 1)).slice(-3);
    doImport();
  });
}

/* ===================== PDF 报价单解析 ===================== */
function handlePdfImport(file) {
  if (typeof window.pdfjsLib === "undefined") {
    showToast("PDF解析库加载中，请稍后重试或刷新页面");
    return;
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  showLoading("正在解析PDF…");
  var reader = new FileReader();
  var pdfDoc = null;
  reader.onload = function (ev) {
    var task = window.pdfjsLib.getDocument({
    data: new Uint8Array(ev.target.result),
    /* 中文CID字体需要cMap映射表，否则提不出文本 */
    cMapUrl: "vendor/pdfjs_cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "vendor/pdfjs_fonts/"
  });
    task.promise.then(function (pdf) {
      pdfDoc = pdf;
      var pagePromises = [];
      for (var p = 1; p <= pdf.numPages; p++) {
        pagePromises.push(pdf.getPage(p).then(function (page) {
          return page.getTextContent().then(function (tc) {
            return tc.items.map(function (it) {
              return { text: it.str, x: it.transform[4], y: it.transform[5] };
            });
          });
        }));
      }
      return Promise.all(pagePromises);
    }).then(function (pagesItems) {
      hideLoading();
      var allItems = [];
      pagesItems.forEach(function (arr) { allItems = allItems.concat(arr); });
      /* 文字项过少 → 视为扫描件；文字量正常也先试文本解析，失败自动降级AI-OCR */
      if (allItems.length < 20) {
        handleScannedPdf(pdfDoc, file.name);
        return;
      }
      var rows = pdfItemsToRows(allItems);
      var result = pdfRowsToTable(rows);
      if (!result.items.length) {
        handleScannedPdf(pdfDoc, file.name); /* 文本解析失败 → 自动降级AI识别扫描件 */
        return;
      }
      var allText = allItems.map(function (it) { return it.text; }).join(" ");
      showImportConfirm(result.title || file.name.replace(/\.[^.]+$/, ""), result.items, extractContractNo(allText));
    }).catch(function (err) {
      hideLoading();
      console.error("PDF解析失败:", err);
      showToast("PDF解析失败: " + (err && err.message ? err.message : "未知错误"));
    });
  };
  reader.onerror = function () { hideLoading(); showToast("文件读取失败"); };
  reader.readAsArrayBuffer(file);
}

/* ===== 扫描件 PDF：AI-OCR 提取报价单（页面图片发送至AI服务） ===== */
function aiFetchTextMulti(prompt, images, fast) {
  var cfg = getAiConfig();
  /* ★所有图片压缩到300px再发AI（提速3-5倍，识图精度不受影响） */
  var compressAll = function (imgs) {
    return Promise.all((imgs || []).map(function (img) {
      if (!img || typeof img !== "string" || img.indexOf("data:image") !== 0) return img;
      return compressForAi(img, 800).catch(function () { return img; }); /* 800px保细节 */
    }));
  };
  var direct = function (compressedImages) {
    var p = AI_PROVIDERS[cfg.provider] || AI_PROVIDERS.deepseek;
    var content = [{ type: "text", text: prompt }];
    (compressedImages || []).forEach(function (img) { content.push({ type: "image_url", image_url: { url: img } }); });
    return fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": 'Bearer '  + cfg.key },
      body: JSON.stringify({ model: p.model, messages: [{ role: "user", content: content }], max_tokens: 2048 })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error("HTTP " + res.status + (data && data.error && data.error.message ? " " + String(data.error.message).slice(0, 60) : ""));
        if (data && data.error) throw new Error("模型返回错误：" + String((data.error && data.error.message) || data.error).slice(0, 80));
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        var t = msg && (msg.content != null && msg.content !== "" ? msg.content : (msg.reasoning_content || ""));
        if (t && Array.isArray(t)) t = t.map(function (c) { return (c && (c.text || c.content)) || ""; }).join("");
        t = String(t || "").trim();
        if (!t) throw new Error("模型返回为空（HTTP 200但无内容）");
        return rememberAiRaw(t);
      });
    });
  };
  return compressAll(images).then(function (compressed) {
    if (cfg.mode === "key") {
      if (!cfg.key) return Promise.reject(new Error("未配置API Key"));
      return direct(compressed);
    }
    return fetch(cfg.proxyUrl || DEFAULT_AI_PROXY || "/api/ai-count", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""), prompt: prompt, images: compressed, fast: true })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          if (res.status === 404 && cfg.key) return direct(compressed);
          throw new Error((data && data.error) || ("HTTP " + res.status));
        }
        return rememberAiRaw(String(data && data.content || ""));
      });
    });
  });
}

var lastAiRawText = "";
function rememberAiRaw(t) { try { lastAiRawText = String(t || ""); } catch (e) {} return t; }

function compressForAi(dataUrl, maxSize) {
  /* AI计数用图压缩：减小传输量和视觉噪声，提速不降准 */
  return new Promise(function (resolve) {
    try {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w <= maxSize && h <= maxSize) return resolve(dataUrl);
        var ratio = Math.min(maxSize / w, maxSize / h);
        var c = document.createElement("canvas");
        c.width = Math.round(w * ratio); c.height = Math.round(h * ratio);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    } catch (e) { resolve(dataUrl); }
  });
}

function aiFetchText(image, prompt) {
  var cfg = getAiConfig();
  var direct = function () {
    var p = AI_PROVIDERS[cfg.provider] || AI_PROVIDERS.deepseek;
    return fetch(p.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": 'Bearer '  + cfg.key
      },
      body: JSON.stringify({
        model: p.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image } }
          ]
        }],
        max_tokens: 2048
      })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error("HTTP " + res.status + (data && data.error && data.error.message ? " " + String(data.error.message).slice(0, 60) : ""));
        if (data && data.error) throw new Error("模型返回错误：" + String((data.error && data.error.message) || data.error).slice(0, 80));
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        var t = msg && (msg.content != null && msg.content !== "" ? msg.content : (msg.reasoning_content || ""));
        if (t && Array.isArray(t)) t = t.map(function (c) { return (c && (c.text || c.content)) || ""; }).join("");
        t = String(t || "").trim();
        if (!t) throw new Error("模型返回为空（HTTP 200但无内容）");
        return rememberAiRaw(t);
      });
    });
  };
  if (cfg.mode === "key") {
    if (!cfg.key) return Promise.reject(new Error("未配置API Key"));
    return direct();
  }
  return fetch(cfg.proxyUrl || DEFAULT_AI_PROXY || "/api/ai-count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wtoken: (typeof JF_WRITE_TOKEN !== "undefined" ? JF_WRITE_TOKEN : ""), image: image, prompt: prompt })
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        if (res.status === 404 && cfg.key) return direct();
        throw new Error((data && data.error) || ("HTTP " + res.status));
      }
      return rememberAiRaw(String(data && data.content || ""));
    });
  });
}

function parseAiOcr(text) {
  try {
    var m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    var o = JSON.parse(m[0]);
    if (!o || !Array.isArray(o.items)) return null;
    return o;
  } catch (e) { return null; }
}

function handleScannedPdf(pdfDoc, fileName) {
  if (!pdfDoc) { showToast("PDF读取失败，请重试"); return; }
  var cfg = getAiConfig();
  if (cfg.mode === "key" && !cfg.key) {
    showToast("扫描件识别需要AI服务：请在AI设置中配置后重试");
    openAiSettings();
    return;
  }
  showToast("检测到扫描件PDF，使用AI识别（页面图片将发送至AI服务）");
  var maxPages = Math.min(pdfDoc.numPages, 8);

  /* 渲染全部页为图片 */
  var renderChain = Promise.resolve();
  var pageImgs = [];
  for (var pn = 1; pn <= maxPages; pn++) {
    (function (n) {
      renderChain = renderChain.then(function () {
        showLoading("\u52a0\u8f7d\u626b\u63cf\u9875 " + n + "/" + maxPages + "\u2026");
        return pdfDoc.getPage(n).then(function (page) {
          var viewport = page.getViewport({ scale: 1.25 });
          var canvas = document.createElement("canvas");
          canvas.width = viewport.width; canvas.height = viewport.height;
          var ctx = canvas.getContext("2d");
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
            pageImgs.push(canvas.toDataURL("image/jpeg", 0.78));
          });
        });
      });
    })(pn);
  }

  renderChain.then(function () {
    /* 并行分块识别：每块2页并行请求，总耗时≈单块时间（原来串行/整包是慢的根源） */
    var chunks = [];
    for (var ci = 0; ci < pageImgs.length; ci += 2) chunks.push(pageImgs.slice(ci, ci + 2));
    showLoading("AI识别中（" + maxPages + "页并行" + chunks.length + "路）…");
    var multiPrompt = "这是报价单扫描件（多页连续的一部分）。请提取其中的报价明细数据行，只输出一个JSON对象不要输出其他文字：" +
      "{\"title\":\"标题(无则空字符串)\",\"contractNo\":\"合同编号(无则空字符串)\",\"items\":[{\"name\":\"名称\",\"qty\":\"数量\",\"unit\":\"单位\",\"price\":\"单价\",\"amount\":\"合价\"}]}。" +
      "要求：只提取明细数据行，不含表头和合计/小计；数字去掉千分位逗号和货币符号；没有的字段填空字符串；跨页重复的表头不要当成明细。";
    return Promise.all(chunks.map(function (chunk) {
      return aiFetchTextMulti(multiPrompt, chunk, true).then(function (t) { return parseAiOcr(t); }).catch(function () { return null; });
    }));
  }).then(function (parsedList) {
    hideLoading();
    var items = [], title = "", contractNo = "";
    (parsedList || []).forEach(function (parsed) {
      if (!parsed) return;
      if (!title && parsed.title) title = String(parsed.title).trim();
      if (!contractNo && parsed.contractNo) contractNo = String(parsed.contractNo).trim();
      (parsed.items || []).forEach(function (r) {
        var name = String(r.name || "").trim();
        if (!name) return;
        items.push(makeQuoteItem(items.length, name, r.qty || "", r.unit || "", r.price || "", r.amount || ""));
      });
    });
    if (!items.length) {
      var hint = "";
      try { hint = String((typeof lastAiRawText !== "undefined" && lastAiRawText) || "").replace(/\s+/g, " ").slice(0, 50); } catch (e0) {}
      showToast("\u274c AI\u8bc6\u522b\u5931\u8d25\uff08\u672a\u8fd4\u56de\u660e\u7ec6\uff09" + (hint ? "\u3002\u6a21\u578b\u56de\u590d\uff1a" + hint : "") + "\u3002\u53ef\u5728\u300cAI\u8bbe\u7f6e\u300d\u5207\u6362\u6a21\u578b\u91cd\u8bd5", 8000);
      return;
    }
    showImportConfirm(title || fileName.replace(/\.[^.]+$/, ""), items, contractNo);
  }).catch(function (e) {
    hideLoading();
    console.error("\u626b\u63cf\u4ef6\u8bc6\u522b\u5931\u8d25:", e);
    showToast("\u274c AI\u8bc6\u522b\u5931\u8d25\uff1a" + (e && e.message ? e.message : "\u7f51\u7edc\u6216\u6a21\u578b\u5f02\u5e38") + "\u3002\u53ef\u5728\u300cAI\u8bbe\u7f6e\u300d\u5207\u6362MiMo\u89c6\u89c9\u91cd\u8bd5", 5000);
  });
}

/* 文本项 → 行（按 y 坐标聚行，按 x 排序） */
function pdfItemsToRows(items) {
  var sorted = items.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; });
  var rows = [], cur = null;
  for (var i = 0; i < sorted.length; i++) {
    var it = sorted[i];
    if (!it.text || !it.text.trim()) continue;
    if (!cur || Math.abs(cur.y - it.y) > 4) {
      cur = { y: it.y, cells: [] };
      rows.push(cur);
    }
    cur.cells.push({ x: it.x, text: it.text.trim() });
  }
  rows.forEach(function (r) {
    r.cells.sort(function (a, b) { return a.x - b.x; });
  });
  return rows;
}

/* 行 → 表格（表头定位列 → 数据行映射） */
function pdfRowsToTable(rows) {
  var kwName = ["名称", "物料", "品名", "项目", "内容", "规格"];
  var kwNum = ["数量", "单价", "金额", "报价", "单位", "总价"];
  var headerIdx = -1;
  for (var i = 0; i < rows.length; i++) {
    var txt = rows[i].cells.map(function (c) { return c.text; }).join("|");
    var hasName = kwName.some(function (k) { return txt.indexOf(k) > -1; });
    var hasNum = kwNum.filter(function (k) { return txt.indexOf(k) > -1; }).length >= 2;
    if (hasName && hasNum) { headerIdx = i; break; }
  }

  lastParsedRows = rows.map(function (r) { return r.cells.map(function (c) { return c.text; }); });
  if (headerIdx < 0) {
    /* 无表头兜底：序号+5/6列的位置映射 */
    var items = [];
    rows.forEach(function (r) {
      if (r.cells.length < 5 || r.cells.length > 6) return;
      if (!/^\d+$/.test(r.cells[0].text)) return;
      var name = r.cells[1].text;
      if (!name) return;
      var qty = r.cells[2].text, unit = r.cells.length === 6 ? r.cells[3].text : "";
      var price = r.cells[r.cells.length - 2].text, amount = r.cells[r.cells.length - 1].text;
      if (!isSubtotalRow(name)) items.push(makeQuoteItem(items.length, name, qty, unit, price, amount));
    });
    return { title: "", items: items };
  }

  /* 标题 = 表头前首个非数字长行（排除合同信息行） */
  var title = "";
  for (var t = 0; t < headerIdx; t++) {
    var tt = rows[t].cells.map(function (c) { return c.text; }).join("").trim();
    if (tt.length >= 4 && !/^\d+$/.test(tt) && tt.indexOf("合同编号") < 0 && tt.indexOf("合同号") < 0) {
      title = tt;
      break;
    }
  }

  /* 列定义：按表头单元格左锚点，同字段取首个 */
  var fieldOf = function (text) {
    if (/合同/.test(text)) return null;
    if (/序号|编号/.test(text)) return "seq";
    if (/名称|物料|品名|项目|内容|规格/.test(text)) return "name";
    if (/数量/.test(text)) return "qty";
    if (/单位/.test(text)) return "unit";
    if (/单价/.test(text)) return "price";
    if (/金额|报价|总价|合计/.test(text)) return "amount";
    return null;
  };
  var colDefs = [], seen = {};
  rows[headerIdx].cells.forEach(function (c) {
    var f = fieldOf(c.text);
    if (f && !seen[f]) { seen[f] = true; colDefs.push({ field: f, x: c.x }); }
    else colDefs.push({ field: null, x: c.x }); /* 多余列（如规格/备注）作隔离区，防止污染数值列 */
  });
  if (!colDefs.some(function (d) { return d.field === "name"; })) {
    return { title: title, items: [] };
  }

  var items = [];
  for (var r = headerIdx + 1; r < rows.length; r++) {
    var row = rows[r];
    if (!row.cells.length) continue;
    var vals = {};
    row.cells.forEach(function (c) {
      /* 就近归列，隔离区列直接丢弃 */
      var best = colDefs[0], bd = Math.abs(c.x - colDefs[0].x);
      colDefs.forEach(function (d) {
        var dd = Math.abs(c.x - d.x);
        if (dd < bd) { bd = dd; best = d; }
      });
      if (best.field) vals[best.field] = (vals[best.field] || "") + c.text;
    });
    if (seen.seq && !/^\d+$/.test((vals.seq || "").trim())) continue;
    var name = (vals.name || "").trim();
    if (!name) continue;
    if (!vals.qty && !vals.price && !vals.amount) continue;
    if (!isSubtotalRow(name)) items.push(makeQuoteItem(items.length, name, vals.qty || "", vals.unit || "", vals.price || "", vals.amount || ""));
  }
  return { title: title, items: items };
}

function aiOptimizeDisplayNames(items) {
  if (!items || items.length < 2) return Promise.resolve(items);
  var sample = items.slice(0, 5).map(function (it, i) {
    return { idx: i, name: it.displayName, qty: it.origQty, price: it.origPrice, amount: it.origAmount };
  });
  var prompt = "\u4ee5\u4e0b\u662f\u62a5\u4ef7\u5355\u89e3\u6790\u540e\u7684\u6761\u76ee\u3002\u8bf7\u4e3a\u6bcf\u6761\u751f\u6210\u4e00\u4e2a\u7cbe\u7b80\u663e\u793a\u540d\uff08\u226410\u4e2a\u6c49\u5b57\uff09\uff0c\u89c4\u5219\uff1a" +
    "1)\u53ea\u4fdd\u7559\u6838\u5fc3\u7269\u6599/\u670d\u52a1\u540d\u79f0\uff0c\u53bb\u6389\u89c4\u683c/\u5c3a\u5bf8/\u6570\u91cf/\u5355\u4ef7/\u91d1\u989d\u7b49\u6570\u5b57\u548c\u53c2\u6570\uff1b" +
    "2)\u5982\u679c\u6709\u7ec4\u540d/\u5206\u7c7b\u524d\u7f00\uff0c\u4fdd\u7559\u7ec4\u540d+\u540d\u79f0\u6838\u5fc3\uff08\u603b\u957f\u226410\u5b57\uff09\uff1b" +
    "3)\u540c\u4e00\u7ec4\u7684\u6761\u76ee\u7528\u7ec4\u540d\u533a\u5206\uff0c\u4e0d\u8981\u91cd\u590d\uff1b" +
    "4)\u53ea\u8f93\u51faJSON\u6570\u7ec4\u4e0d\u8981\u5176\u4ed6\u6587\u5b57\uff1a[{\"idx\":0,\"short\":\"\u77ed\u540d\"}]\u3002" +
    "\u6837\u672c\u6570\u636e\uff1a" + JSON.stringify(sample);
  return aiFetchTextMulti(prompt, [], true).then(function (txt) {
    var res = extractJson(txt);
    if (!res || !Array.isArray(res)) return items;
    var map = {};
    res.forEach(function (r) {
      if (r && r.idx !== undefined && r.short) map[r.idx] = String(r.short).trim().substring(0, 12);
    });
    items.forEach(function (it, i) {
      if (map[i]) it.shortName = map[i];
    });
    return items;
  }).catch(function () { return items; });
}

function makeQuoteItem(idx, name, qty, unit, price, amount) {
  return {
    sortKey: idx, displayNum: String(idx + 1), displayName: String(name).trim(),
    origQty: String(qty || "").replace(/[,\s]/g, ""),
    origUnit: String(unit || "").trim(),
    origPrice: String(price || "").replace(/[,\s￥¥]/g, ""),
    origAmount: String(amount || "").replace(/[,\s￥¥]/g, ""),
    quoteQty: String(qty || "").replace(/[,\s]/g, ""),
    quotePrice: String(price || "").replace(/[,\s￥¥]/g, ""),
    acceptQty: "", acceptPrice: "", acceptAmount: "", remark: "",
    photos: [], accepted: false
  };
}

function doImport() {
  if (!pendingImport) return;
  if (currentProject && currentProject.key) { syncFormToItem(); saveProject(); }
  var key = "proj_" + Date.now();
  currentProject = {
    key: key, name: pendingImport.name, items: pendingImport.items, createdAt: Date.now(),
    contractNo: pendingImport.contractNo || "", contractName: pendingImport.contractName || "",
    contractAmount: pendingImport.contractAmount || "", acceptNo: pendingImport.acceptNo || ""
  };
  pendingImport = null;
  saveProject();
  recordPrices(currentProject.items, currentProject.acceptNo || currentProject.name);
  showList();
  showToast("导入成功，验收单号 " + (currentProject.acceptNo || "-") + "，共 " + currentProject.items.length + " 项");
}

/* ===================== 首页项目列表 ===================== */
function refreshHome() {
  getIndex().then(function (idx) {
    var area = document.getElementById("projListArea");
    if (!idx || !idx.length) {
      area.innerHTML = '<p style="color:#4a4535;font-size:.85rem;text-align:center;padding:10px 0;">暂无验收项目</p>';
      return;
    }
    idx.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var html = '';
    for (var i = 0; i < idx.length; i++) {
      var entry = idx[i];
      var pct = entry.total ? Math.round(entry.done / entry.total * 100) : 0;
      html += '<div class="project-card" onclick="openProject(\'' + escAttrJs(entry.key) + '\')">' +
        '<div class="project-card-header">' +
          '<div class="project-card-name">' + escapeHtml(entry.name) + '</div>' +
          '<button class="project-card-delete" onclick="event.stopPropagation();confirmDelete(\'' + escAttrJs(entry.key) + '\',\'' + escAttrJs(entry.name) + '\')">&#215;</button>' +
        '</div>' +
        '<div class="project-card-bar"><div class="project-card-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="project-card-footer"><span>' + entry.done + '/' + entry.total + ' 已验收</span>' +
        (entry.done >= entry.total ? '<span class="project-card-done">已完成</span>' : '<span>' + formatDate(entry.updatedAt) + '</span>') +
        '</div></div>';
    }
    area.innerHTML = html;
  });
}

function openProject(key) {
  showLoading("\u52a0\u8f7d...");
  loadProjectData(key).then(function (data) {
    hideLoading();
    if (data && data.items && data.items.length) {
      currentProject = data;
      showList();
    } else { showToast("\u52a0\u8f7d\u5931\u8d25"); }
  }).catch(function () { hideLoading(); showToast("\u52a0\u8f7d\u5931\u8d25"); });
}

function confirmDelete(key, name) {
  deleteTargetKey = key;
  document.getElementById("delProjName").textContent = name;
  document.getElementById("delModal").classList.add("active");
}

function cancelDelete() {
  document.getElementById("delModal").classList.remove("active");
  deleteTargetKey = null;
}

function executeDelete() {
  document.getElementById("delModal").classList.remove("active");
  if (!deleteTargetKey) return;
  var k = deleteTargetKey;
  deleteTargetKey = null;
  deleteProject(k).then(function () { refreshHome(); showToast("\u5df2\u5220\u9664"); });
}

/* ===================== 页面切换 ===================== */
function switchPage(pageId) {
  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) pages[i].classList.remove("active");
  document.getElementById(pageId).classList.add("active");
}

function goHome() {
  stopCamera();
  if (currentIndex >= 0 && currentProject) {
    syncFormToItem();
    saveProject();
    currentIndex = -1;
    document.getElementById("detailPage").classList.remove("active");
    document.body.style.overflow = "";
  }
  closeViewer();
  currentProject = null;
  switchPage("pgHome");
  refreshHome();
  document.getElementById("btnBack").style.display = "none";
  document.getElementById("topTitle").textContent = "采购智验助手";
}

function showList() {
  stopCamera();
  closeDetail();
  closeViewer();
  renderItemList();
  switchPage("pgList");
  document.getElementById("btnBack").style.display = "";
  document.getElementById("topTitle").textContent = currentProject.name;
}

function showDone() {
  stopCamera();
  closeViewer();
  if (currentIndex >= 0) {
    currentIndex = -1;
    document.getElementById("detailPage").classList.remove("active");
    document.body.style.overflow = "";
  }
  switchPage("pgDone");
  document.getElementById("btnBack").style.display = "";
  document.getElementById("topTitle").textContent = "\u9a8c\u6536\u9884\u89c8";
  renderDonePreview();
}

/* ★验收预览：清单+最终查重 */
function renderDonePreview() {
  if (!currentProject) return;
  var items = currentProject.items || [];
  var html = "";
  var dupItems = [];

  /* ★全量查重：项目内文件哈希互查 + 感知哈希互查 + 集团索引 */
  var allFileHashes = {};
  items.forEach(function (item, i) {
    (item.photos || []).forEach(function (p, j) {
      var key = (item.displayNum || "") + "-" + (j + 1);
      /* ① 文件哈希项目内互查 */
      if (p.fileHash) {
        if (allFileHashes[p.fileHash]) {
          dupItems.push({ idx: i, item: key, name: item.displayName, of: allFileHashes[p.fileHash], type: "文件重复" });
          p.duplicate = 1;
          p.dupOf = "文件重复:" + allFileHashes[p.fileHash];
        } else {
          allFileHashes[p.fileHash] = key;
        }
        /* ② 文件哈希集团查 */
        var fHits = localHashCheck(null, p.fileHash, currentProject.acceptNo || "");
        for (var k = 0; k < fHits.length; k++) {
          if (fHits[k].byFile) {
            dupItems.push({ idx: i, item: key, name: item.displayName, of: fHits[k].project || fHits[k].acceptNo, type: "集团重复" });
            p.duplicate = 1;
            p.dupOf = "集团重复:" + (fHits[k].project || "");
            break;
          }
        }
      }
      /* ③ 感知哈希项目内互查——只警告不拦 */
      if (p.hash && !p.duplicate && !p.dupCleared) {
        var dupR = findDuplicatePhoto(p.hash, p);
        if (dupR && dupR.dup) {
          dupItems.push({ idx: i, item: key, name: item.displayName, of: dupR.dup, type: "相似(仅提示)" });
          p.dupWarn = "相似:" + dupR.dup;
        }
      }
    });

    var dupCount = (item.photos || []).filter(function (p) { return p.duplicate; }).length;
    html += '<div style="padding:5px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">' +
      '<div style="flex:1;">' +
        '<b>' + item.displayNum + '.</b> ' + escapeHtml(item.displayName) +
        ' <span style="color:#888;">' + (item.photos || []).length + '张照片' +
        (dupCount ? ' · <span style="color:#e5484d;">' + dupCount + '张重复</span>' : '') + '</span>' +
        (item.accepted ? ' <span style="color:#27ae60;">✓已验收</span>' : ' <span style="color:#e67e22;">待验收</span>') +
      '</div>' +
      '<button onclick="openDetail(' + i + ');event.stopPropagation();" style="padding:3px 8px;font-size:10px;border:1px solid #2563eb;background:#fff;color:#2563eb;border-radius:4px;cursor:pointer;">&#9998; 修改</button>' +
      '</div>';
  });

  document.getElementById("donePreview").innerHTML = html || "暂无数据";

  /* 显示查重结果 */
  if (dupItems.length) {
    var list = dupItems.map(function (d) { return escapeHtml(d.item + " " + d.name + " → 与[" + d.of + "] " + d.type); }).join("<br>");
    document.getElementById("finalDupCheck").style.display = "";
    document.getElementById("finalDupList").innerHTML = list;
    document.getElementById("btnConfirmGen").innerHTML = "&#9888;&#65039; 有" + dupItems.length + "处重复，请先修改";
    document.getElementById("btnConfirmGen").className = "btn btn-gold";
    document.getElementById("btnConfirmGen").onclick = function () { showToast("请先点「修改」处理重复照片", 3000); };
  } else {
    document.getElementById("finalDupCheck").style.display = "none";
    document.getElementById("btnConfirmGen").innerHTML = "&#9989; 确认验收并生成文件";
    document.getElementById("btnConfirmGen").className = "btn btn-green";
    document.getElementById("btnConfirmGen").onclick = function () { confirmAndGenPDF(); };
  }
}

/* ★确认验收并生成 */
var _genBusy = false;
function confirmAndGenPDF() {
  if (_genBusy) return;
  _genBusy = true; setTimeout(function () { _genBusy = false; }, 3000); /* 防双击连发 */
  /* 防伪检测未完成先确认 */
  var elaPending = (currentProject && currentProject.items || []).some(function (it) {
    return (it.photos || []).some(function (p) { return p.dataUrl && p.forensics && p.forensics.ela === undefined; });
  });
  if (elaPending && !confirm("部分照片的防伪检测（ELA/元数据）尚未完成，仍要生成验收文件吗？")) { _genBusy = false; return; }
  /* ★最终查重（全量：文件哈希+感知哈希） */
  var dupCount = 0;
  var seenFiles = {};
  (currentProject.items || []).forEach(function (item) {
    (item.photos || []).forEach(function (p) {
      if (p.fileHash) {
        if (seenFiles[p.fileHash]) dupCount++;
        else seenFiles[p.fileHash] = true;
        var fHits = localHashCheck(null, p.fileHash, currentProject.acceptNo || "");
        for (var k = 0; k < fHits.length; k++) {
          if (fHits[k].byFile) { dupCount++; break; }
        }
      }
      if (p.hash && !p.duplicate && !p.dupCleared) {
        var dupR = findDuplicatePhoto(p.hash, p);
        if (dupR && dupR.dup) dupCount++;
      }
    });
  });
  if (dupCount > 0) {
    showToast("\u274c \u53d1\u73b0 " + dupCount + " \u5904\u91cd\u590d\u7528\u56fe\uff0c\u8bf7\u5148\u5904\u7406", 3000);
    renderDonePreview();
    return;
  }
  genPDF();
}

/* ★返回修改 */
function goBackFix() {
  /* 找到第一个有重复的条目 */
  for (var i = 0; i < currentProject.items.length; i++) {
    var item = currentProject.items[i];
    for (var j = 0; j < (item.photos || []).length; j++) {
      var p = item.photos[j];
      if (p.duplicate) {
        openDetail(i);
        showToast("请处理第" + item.displayNum + "条的重复照片", 3000);
        return;
      }
    }
  }
  /* 没找到就打开第一条 */
  openDetail(0);
}

/* ===================== 验收列表渲染 ===================== */
function renderItemList() {
  if (!currentProject || !currentProject.items) return;
  document.getElementById("projName").innerHTML =
    '<div>' + escapeHtml(currentProject.name) + '</div>' +
    ((currentProject.acceptNo || currentProject.contractNo) ?
      '<div class="proj-sub">' +
      (currentProject.acceptNo ? '验收单号：' + escapeHtml(currentProject.acceptNo) : '') +
      (currentProject.contractNo ? '　合同编号：' + escapeHtml(currentProject.contractNo) : '') +
      '</div>' : '');
  updateContractWarn();

  var doneCount = currentProject.items.filter(function (x) { return x.accepted; }).length;
  var total = currentProject.items.length;
  document.getElementById("progVal").textContent = doneCount + "/" + total;
  document.getElementById("progFill").style.width = (total ? doneCount / total * 100 : 0) + "%";

  var listEl = document.getElementById("itemList");
  listEl.innerHTML = "";

  for (var i = 0; i < currentProject.items.length; i++) {
    var item = currentProject.items[i];
    var status = item.accepted ? "done" : (item.photos.length ? "accepting" : "pending");
    var label = item.accepted ? "\u5df2\u5b8c\u6210" : (item.photos.length ? "\u9a8c\u6536\u4e2d" : "\u5f85\u9a8c\u6536");

    var div = document.createElement("div");
    div.className = "item-row";
    div.innerHTML =
      '<div class="item-num status-' + status + '">' + item.displayNum + '</div>' +
      '<div class="item-body">' +
        '<div class="item-name">' + escapeHtml(item.displayName) + '</div>' +
        '<div class="item-meta">\u62a5\u4ef7:' + escapeHtml(String(item.origQty)) + escapeHtml(String(item.origUnit || '')) + ' x \u00a5' + escapeHtml(String(item.origPrice)) +
        (item.acceptAmount ? ' \u00b7 \u9a8c\u6536:\u00a5' + escapeHtml(String(item.acceptAmount)) : '') +
        (item.photos.length ? ' \u00b7 \ud83d\udcf7' + item.photos.length : '') + '</div>' +
      '</div>' +
      '<span class="item-tag status-' + status + '">' + label + '</span>' +
      '<span class="item-arrow">\u203a</span>';

    (function (idx) { div.onclick = function () { openDetail(idx); }; })(i);
    listEl.appendChild(div);
  }

  var btn = document.getElementById("btnGen");
  btn.disabled = doneCount < total;
  btn.textContent = (total && doneCount === total) ?
    "\ud83d\udcc4 \u751f\u6210\u9a8c\u6536\u6587\u4ef6" :
    "\ud83d\udcc4 \u5168\u90e8\u9a8c\u6536\u540e\u53ef\u751f\u6210 (" + doneCount + "/" + total + ")";
  if (doneCount === total && total > 0) setTimeout(function () { showDone(); }, 300);
}

/* ===================== 验收详情 ===================== */
function openDetail(idx) {
  currentIndex = idx;
  var item = currentProject.items[idx];

  document.getElementById("dtlTitle").textContent = item.displayNum + ". " + item.displayName;
  document.getElementById("quoteTitle") && (document.getElementById("quoteTitle").textContent = "\ud83d\udccb \u62a5\u4ef7\u4fe1\u606f - " + item.displayName);
  closeAiResult();
  reverifyProjectGroupDups(); /* 修复历史误标+重校验集团防伪 */
  var qText = item.origQty || "";
  if (item.origUnit && qText.indexOf(item.origUnit) < 0) qText += (qText ? " " : "") + item.origUnit;
  document.getElementById("inpOQ").textContent = qText;
  document.getElementById("inpOP").textContent = "\u00a5" + item.origPrice;

  var origAmount = item.origAmount || "";
  if (!origAmount && item.origQty && item.origPrice) {
    var nq = parseFloat(item.origQty), np = parseFloat(item.origPrice);
    if (!isNaN(nq) && !isNaN(np)) origAmount = (nq * np).toFixed(2);
  }
  document.getElementById("inpOA").textContent = origAmount ? "\u00a5" + origAmount : "";
  document.getElementById("inpAQ").value = item.acceptQty || "";
  document.getElementById("inpAP").value = item.acceptPrice || "";
  document.getElementById("inpAA").value = item.acceptAmount || "";
  /* 验收信息预填：数量/单价/金额按报价单预填，人工确认或修改；缺项互算兜底 */
  if (!item.accepted && !item.acceptQty) {
    var pq = parseFloat(item.quoteQty || item.origQty);
    var pp = parseFloat(item.quotePrice || item.origPrice);
    var pa = parseFloat(item.quoteAmount || item.origAmount);
    if (!isFinite(pq) && isFinite(pa) && isFinite(pp) && pp > 0) pq = pa / pp;
    if (!isFinite(pp) && isFinite(pa) && isFinite(pq) && pq > 0) pp = pa / pq;
    if (isFinite(pq) && pq > 0) document.getElementById("inpAQ").value = String(Math.round(pq * 10000) / 10000);
    if (isFinite(pp) && pp > 0) document.getElementById("inpAP").value = String(Math.round(pp * 10000) / 10000);
    if (isFinite(pq) && isFinite(pp) && pq > 0 && pp > 0) {
      document.getElementById("inpAA").value = (Math.round(pq * pp * 100) / 100).toFixed(2);
    } else if (isFinite(pa) && pa > 0) {
      document.getElementById("inpAA").value = pa.toFixed(2);
    }
  }
  document.getElementById("inpR").value = item.remark || "";

  renderPhotoGrid();
  document.getElementById("detailPage").classList.add("active");
  document.body.style.overflow = "hidden";

  var fields = ["inpAQ", "inpAP", "inpR", "inpAA"];
  for (var i = 0; i < fields.length; i++) {
    var el = document.getElementById(fields[i]);
    el.removeEventListener("input", onFieldInput);
    el.addEventListener("input", onFieldInput);
  }
}

function onFieldInput() {
  var rawAQ = document.getElementById("inpAQ").value.trim();
  var rawAP = document.getElementById("inpAP").value.trim();
  var nq = parseFloat(rawAQ), np = parseFloat(rawAP);
  var hasBoth = rawAQ !== "" && rawAP !== "" && !isNaN(nq) && !isNaN(np);
  var aaField = document.getElementById("inpAA");

  if (this.id === "inpAQ" || this.id === "inpAP") {
    /* 总计实时同步：
       1) 数量/单价都填写（含0）→ 总计 = 数量 x 单价（数量填0则总计自动为0.00）；
       2) 数量或单价任一被清空/非法 → 总计同步清空，不残留旧值 */
    aaField.value = hasBoth ? (nq * np).toFixed(2) : "";
  }

  var aa = parseFloat(aaField.value) || 0;
  var calculated = hasBoth ? nq * np : 0;
  var remarkField = document.getElementById("inpR");

  if (nq > 0 && np > 0 && aa > 0 && Math.abs(aa - calculated) > 0.01) {
    remarkField.placeholder = "\u26a0 \u91d1\u989d\u4e0d\u4e00\u81f4\uff0c\u8bf7\u586b\u5907\u6ce8";
    remarkField.style.borderColor = "#c05050";
    remarkField.style.background = "rgba(192,80,80,.05)";
  } else {
    remarkField.placeholder = "\u8f93\u5165\u5907\u6ce8\u4fe1\u606f";
    remarkField.style.borderColor = "";
    remarkField.style.background = "";
  }
  autoSave();
}

function syncFormToItem() {
  if (currentIndex < 0 || !currentProject) return;
  var item = currentProject.items[currentIndex];
  item.acceptQty = document.getElementById("inpAQ").value;
  item.acceptPrice = document.getElementById("inpAP").value;
  item.acceptAmount = document.getElementById("inpAA").value;
  item.remark = document.getElementById("inpR").value;
}

function closeDetail() {
  syncFormToItem();
  if (currentIndex >= 0 && currentProject) saveProject();
  currentIndex = -1;
  document.getElementById("detailPage").classList.remove("active");
  document.body.style.overflow = "";
  if (currentProject) renderItemList();
}

function saveAccept() {
  if (currentIndex < 0 || !currentProject) return;
  /* 集团防伪校验未完成 → 等待完成后再验收，杜绝“拍完立刻保存”绕过查重 */
  flushHashQueue();
  doSaveAccept();
}

function doSaveAccept() {
  if (currentIndex < 0 || !currentProject) return;

  /* ★验收前强制同步查重（防竞态）——文件哈希硬拦+感知哈希只警告 */
  var item0 = currentProject.items[currentIndex];
  if (item0 && item0.photos) {
    item0.photos.forEach(function (p) {
      if (p.duplicate) return;
      /* 文件哈希=硬拦（同文件必拦） */
      if (p.fileHash) {
        item0.photos.forEach(function (q, j) {
          if (q.fileHash && q.fileHash === p.fileHash && q !== p) {
            p.duplicate = 1;
            p.dupOf = "\u6587\u4ef6\u91cd\u590d:" + (q.displayNum || "") + "-" + (j + 1);
          }
        });
      }
      /* ★fileHash 跨集团硬拦 */
      if (p.fileHash) {
        var fHits = localHashCheck(null, p.fileHash, currentProject.acceptNo || "");
        for (var fi = 0; fi < fHits.length; fi++) {
          if (fHits[fi].byFile) {
            p.duplicate = 1;
            p.dupOf = "\u96c6\u56e2\u6587\u4ef6\u91cd\u590d:" + (fHits[fi].project || fHits[fi].acceptNo || "");
            break;
          }
        }
      }
      /* 感知哈希=只警告 */
      if (!p.duplicate) {
        var hits = localHashCheck(p.hash, null, currentProject.acceptNo || "");
        if (hits.length) {
          p.dupWarn = "\u96c6\u56e2\u7591\u4f3c:" + (hits[0].project || hits[0].acceptNo || "");
        }
      }
    });
    renderPhotoGrid();
  }

  /* 有重复照片直接拒绝 */
  var dupCheck = (item0.photos || []).filter(function (p) { return p.duplicate; });
  if (dupCheck.length) {
    showToast("\u274c \u5b58\u5728 " + dupCheck.length + " \u5f20\u91cd\u590d\u7528\u56fe\uff0c\u8bf7\u5220\u9664\u540e\u518d\u9a8c\u6536", 4000);
    return;
  }

  /* 异步查重未完成 → 等待完成后再验 */
  if (hashCheckPending.length) {
    showLoading("\u9632\u4f2a\u6821\u9a8c\u4e2d\u2026");
    whenHashChecksDone().then(function () {
      hideLoading();
      doSaveAccept();
    });
    return;
  }
  syncFormToItem();
  var item = currentProject.items[currentIndex];

  if (!item.acceptQty || !item.acceptPrice) {
    showToast("\u8bf7\u586b\u5199\u9a8c\u6536\u6570\u91cf\u548c\u9a8c\u6536\u5355\u4ef7");
    return;
  }
  /* 疑似重复照片不允许验收 */


  var acceptQty = parseFloat(item.acceptQty) || 0;
  var acceptAmt = parseFloat(item.acceptAmount) || 0;
  if (acceptQty < 0 || acceptAmt < 0 || (parseFloat(item.acceptPrice) || 0) < 0) { showToast("\u6570\u91cf/\u5355\u4ef7/\u91d1\u989d\u4e0d\u80fd\u4e3a\u8d1f"); return; }
  var isZeroAccept = (acceptQty === 0 || acceptAmt === 0);

  if (isZeroAccept) {
    /* 数量或金额为0：不需要照片，但必须填备注 */
    if (!item.remark || !item.remark.trim()) {
      showToast("\u6570\u91cf\u6216\u91d1\u989d\u4e3a0\uff0c\u8bf7\u586b\u5199\u5907\u6ce8\u8bf4\u660e\u539f\u56e0");
      document.getElementById("inpR").focus();
      document.getElementById("inpR").style.borderColor = "#c05050";
      return;
    }
  } else {
    /* 数量和金额都不为0：需要照片 */
    if (!item.photos.length) {
      showToast("\u8bf7\u5148\u6dfb\u52a0\u9a8c\u6536\u7167\u7247");
      return;
    }
  }
  if (!item.acceptAmount) {
    var nq = parseFloat(item.acceptQty), np = parseFloat(item.acceptPrice);
    if (!isNaN(nq) && !isNaN(np)) item.acceptAmount = (nq * np).toFixed(2);
  }

  var calculated = parseFloat(item.acceptQty) * parseFloat(item.acceptPrice);
  var aa = parseFloat(item.acceptAmount) || 0;
  if (Math.abs(aa - Math.round(calculated * 100) / 100) > 0.05) {
    if (!item.remark || !item.remark.trim()) {
      showToast("\u91d1\u989d\u4e0d\u4e00\u81f4\uff0c\u8bf7\u586b\u5907\u6ce8");
      document.getElementById("inpR").focus();
      document.getElementById("inpR").style.borderColor = "#c05050";
      return;
    }
  }

  /* 相似/重复照片未删除 → 备注自动标注 */
  var dupCnt = (item.photos || []).filter(function (p) { return p.duplicate; }).length;
  var simCnt = (item.photos || []).filter(function (p) { return p.dupSimilar && !p.duplicate; }).length;
  if (dupCnt || simCnt) {
    var mark = [];
    if (dupCnt) mark.push(dupCnt + "\u5f20\u91cd\u590d");
    if (simCnt) mark.push(simCnt + "\u5f20\u76f8\u4f3c");
    var note = "\u2388\u5b58\u5728" + mark.join("\u3001") + "\u7167\u7247";
    if (item.remark && item.remark.indexOf("\u5b58\u5728") >= 0 && item.remark.indexOf("\u7167\u7247") >= 0) {
      /* 已有标注则更新 */
      item.remark = item.remark.replace(/\u2388\u5b58\u5728[^;；]*/, note);
    } else {
      item.remark = item.remark ? (item.remark + "\uff1b" + note) : note;
    }
  }

  item.accepted = true;
  saveProject();
  recordAcceptBrief(item);
  renderItemList();
  /* 验收并下一条：自动跳到下一个未验收条目 */
  var nextIdx = -1, i;
  for (i = currentIndex + 1; i < currentProject.items.length; i++) {
    if (!currentProject.items[i].accepted) { nextIdx = i; break; }
  }
  if (nextIdx < 0) {
    for (i = 0; i < currentProject.items.length; i++) {
      if (!currentProject.items[i].accepted) { nextIdx = i; break; }
    }
  }
  if (nextIdx >= 0) {
    openDetail(nextIdx);
    showToast("\u2705 \u5df2\u9a8c\u6536\uff0c\u8fdb\u5165\u4e0b\u4e00\u6761");
  } else {
    closeDetail();
    showToast("\ud83c\udf89 \u5168\u90e8\u9a8c\u6536\u5b8c\u6210");
  }
}

function saveOnly() {
  if (currentIndex < 0 || !currentProject) return;
  syncFormToItem();
  saveProject();
  renderItemList();
  showToast("\u5df2\u6682\u5b58");
}

/* ===================== 照片管理 ===================== */
function renderPhotoGrid() {
  if (currentIndex < 0) return;
  var item = currentProject.items[currentIndex];
  var grid = document.getElementById("phGrid");
  grid.innerHTML = "";
  document.getElementById("phCnt").textContent = item.photos.length + "\u5f20";

  for (var i = 0; i < item.photos.length; i++) {
    var photo = item.photos[i];
    var div = document.createElement("div");
    div.className = "photo-card";
    div.innerHTML =
      '<div class="photo-number">' + (i + 1) + '</div>' +
      '<img src="' + ((/^data:image\/(jpeg|png|gif|webp);base64,/i.test(photo.dataUrl || "")) ? escapeHtml(photo.dataUrl) : "") + '" onerror="this.style.opacity=0.3">' +
      '<button class="photo-delete" onclick="event.stopPropagation();deletePhoto(' + i + ')">\u2715</button>' +
      (photo.duplicate ?
        '<div class="photo-dup" onclick="event.stopPropagation();clearDupFlag(' + i + ')" title="\u4e0e[' + escapeHtml(photo.dupOf || "") + ']\u540c\u4e00\u5f20\u7167\u7247\uff0c\u70b9\u51fb\u53ef\u4eba\u5de5\u89e3\u9664">\u26a0 \u91cd\u590d\u7528\u56fe</div>' :
        '<div class="photo-info">' + (photo.video ? '<span class="pv pv-med" title="\u89c6\u9891\u5c01\u9762 ' + escapeHtml((photo.video.width || "?") + "\u00d7" + (photo.video.height || "?") + (photo.video.fps ? " " + photo.video.fps + "fps" : "") + (photo.video.duration ? " " + photo.video.duration + "\u79d2" : "")) + '">\ud83c\udfa5</span>' : '') + forensicIcon(photo) + (photo.dupSimilar ? '<span class="pv pv-med" title="\u4e0e[' + escapeHtml(photo.dupSimilarOf || "") + ']\u6781\u76f8\u4f3c\uff0c\u975e\u540c\u4e00\u5f20\uff0c\u4e0d\u62e6\u622a">\u26a1\u76f8\u4f3c</span>' : '') + verifyIcon(photo) + formatTimestamp(photo.date || "") + '</div>');
    (function (idx) { div.onclick = function () { openViewer(idx); }; })(i);
    grid.appendChild(div);
  }
  updateHashStatus();
}

function clearDupFlag(i) {
  if (!currentProject || currentIndex < 0) return;
  var item = currentProject.items[currentIndex];
  if (!item.photos[i]) return;
  if (!confirm("\u89e3\u9664\u6b64\u7167\u7247\u7684\u7591\u4f3c\u91cd\u590d\u6807\u8bb0\uff1f\uff08\u4ec5\u9650\u4eba\u5de5\u6838\u5b9e\u975e\u91cd\u590d\u540e\u4f7f\u7528\uff09")) return;
  item.photos[i].duplicate = 0;
  item.photos[i].dupOf = "";
  item.photos[i].dupGlobal = 0;
  item.photos[i].dupGlobalOf = "";
  item.photos[i].dupCleared = 1; /* 留痕：曾被标记并人工解除 */
  saveProject();
  renderPhotoGrid();
  showToast("\u2705 \u5df2\u89e3\u9664\u6807\u8bb0\uff08\u5df2\u7559\u75d5\uff09");
}

function verifyIcon(photo) {
  if (photo.aiVerify === "high") return '<span class="pv pv-high" title="AI\u56fe\u6587\u6838\u5bf9:\u4e0e\u62a5\u4ef7\u660e\u7ec6\u4e00\u81f4">\u2713\u4e00\u81f4</span>';
  if (photo.aiVerify === "medium") return '<span class="pv pv-med" title="AI\u56fe\u6587\u6838\u5bf9:\u4e0e\u62a5\u4ef7\u660e\u7ec6\u5b58\u7591">\u26a0\u5b58\u7591</span>';
  if (photo.aiVerify === "low") return '<span class="pv pv-low" title="AI\u56fe\u6587\u6838\u5bf9:\u4e0e\u62a5\u4ef7\u660e\u7ec6\u4e0d\u7b26 ' + escapeHtml(photo.aiVerifyNote || "") + '">\u2715\u4e0d\u7b26</span>';
  return "";
}

/* ===== 视频备注段管理：以照片为准重建，删旧自动清、换新自动更 ===== */
function buildVideoRemark(m) {
  return "视频素材：" + (m.width || "?") + "×" + (m.height || "?") +
    (m.fps ? " / " + m.fps + "fps" : "") +
    (m.duration ? " / " + m.duration + "秒" : "");
}
function refreshVideoRemarks(item) {
  if (!item) return "";
  var el = (typeof document !== "undefined" && currentProject && currentIndex > -1 &&
            currentProject.items[currentIndex] === item) ? document.getElementById("inpR") : null;
  var val = el ? el.value : (item.remark || "");
  var parts = String(val == null ? "" : val).split("；").filter(function (s) {
    return s.indexOf("视频素材：") !== 0;
  });
  (item.photos || []).forEach(function (p) {
    if (p && p.video) {
      if (!p.videoRemarkText) p.videoRemarkText = buildVideoRemark(p.video);
      if (parts.indexOf(p.videoRemarkText) < 0) parts.push(p.videoRemarkText);
    }
  });
  var out = parts.join("；");
  if (el) el.value = out;
  item.remark = out;
  return out;
}

function deletePhoto(idx) {
  if (currentIndex < 0 || !currentProject) return;
  var item = currentProject.items[currentIndex];
  var oldCount = item.photos.length;
  var removed = item.photos[idx];
  item.photos.splice(idx, 1);
  item.accepted = false; /* 删照片后重置验收状态 */
  if (removed && removed.video) refreshVideoRemarks(item); /* 删视频照片→对应备注段自动清 */
  if (!item.photos.length) item.accepted = false;

  /* 修复 v6.2.1：存储键必须与写入/读取一致（含项目 key、三个参数），
     否则删除后重建索引会写到错误的键上，刷新后删掉的照片复活、末尾照片丢失 */
  recomputeDupFlags(); /* 删除后重算疑似重复标记 */
  var cleanups = [];
  for (var k = 0; k < oldCount; k++) {
    cleanups.push(dbDel(photoDataKey(currentProject.key, item.sortKey, k)));
  }

  Promise.all(cleanups).then(function () {
    return Promise.all(item.photos.map(function (p, j) {
      if (p.dataUrl) return dbPut(photoDataKey(currentProject.key, item.sortKey, j), p.dataUrl);
      return Promise.resolve();
    }));
  }).catch(function (e) { console.error("reindex:", e); });

  saveProject();
  renderPhotoGrid();
  renderItemList();
  showToast("\u5df2\u5220\u9664");
}

/* ===================== 清理已验收照片（释放空间） ===================== */
function cleanupPhotos() {
  if (!currentProject) return;
  var count = 0, i, j;
  for (i = 0; i < currentProject.items.length; i++) {
    count += (currentProject.items[i].photos || []).length;
  }
  if (!count) { showToast("没有可清理的照片"); return; }

  var ok = confirm(
    "将删除本项目全部 " + count + " 张照片的本地原始数据（仅保留拍摄时间/位置记录）。\n\n" +
    "⚠ 请先确认已生成并下载PDF验收文件 —— PDF中包含全部照片证据，清理后照片将无法恢复！\n\n" +
    "确定继续清理？"
  );
  if (!ok) return;

  var jobs = [];
  for (i = 0; i < currentProject.items.length; i++) {
    var item = currentProject.items[i];
    var n = (item.photos || []).length;
    for (j = 0; j < n; j++) {
      jobs.push(dbDel(photoDataKey(currentProject.key, item.sortKey, j)));
      item.photos[j].dataUrl = "";
    }
  }
  Promise.all(jobs).then(function () {
    saveProject();
    quotaWarned = false; spaceWarned = false;
    showToast("已清理 " + count + " 张照片，空间已释放");
    if (currentProject) renderItemList();
  }).catch(function () {
    showToast("清理失败，请重试");
  });
}

/* ===================== 照片查看器 ===================== */
function openViewer(idx) {
  if (currentIndex < 0) return;
  viewerPhotos = currentProject.items[currentIndex].photos;
  viewerIndex = idx;
  updateViewer();
  document.getElementById("viewerPage").classList.add("active");
}

function closeViewer() { document.getElementById("viewerPage").classList.remove("active"); }

function viewerNavigate(dir) {
  viewerIndex = (viewerIndex + dir + viewerPhotos.length) % viewerPhotos.length;
  updateViewer();
}

function updateViewer() {
  if (!viewerPhotos.length) return;
  document.getElementById("viewerImg").src = viewerPhotos[viewerIndex].dataUrl || "";
  document.getElementById("viewerCt").textContent = (viewerIndex + 1) + " / " + viewerPhotos.length;
}

/* ===================== 图片来源选择 ===================== */
function openSheet() {
  if (currentIndex < 0) { showToast("\u8bf7\u5148\u9009\u9879"); return; }
  document.getElementById("pickSheet").classList.add("active");
}

function closeSheet() { document.getElementById("pickSheet").classList.remove("active"); }

/* ===================== 相机 ===================== */
function openCamera() {
  closeSheet();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("\u6b64\u8bbe\u5907\u4e0d\u652f\u6301\u62cd\u7167");
    return;
  }
  if (currentIndex < 0 || !currentProject) return;
  var item = currentProject.items[currentIndex];
  document.getElementById("camInfo").textContent = item.displayName + " (" + item.photos.length + "\u5f20)";
  document.getElementById("camPage").classList.add("active");

  /* ★打开相机时预热定位（一次GPS，后续拍照零等待） */
  window._camGeoCache = null;
  getLocation().then(function (loc) { window._camGeoCache = loc || ""; });

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  }).then(function (stream) {
    cameraStream = stream;
    var video = document.getElementById("camVid");
    video.srcObject = stream;
    video.play().catch(function () {});
  }).catch(function () {
    showToast("\u6444\u50cf\u5934\u4e0d\u53ef\u7528");
    stopCamera();
  });
}

function stopCamera() {
  if (cameraStream) {
    try { cameraStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    cameraStream = null;
  }
  var video = document.getElementById("camVid");
  if (video) video.srcObject = null;
  document.getElementById("camPage").classList.remove("active");
}

function takeSnapshot() {
  if (!cameraStream) { showToast("\u6444\u50cf\u5934\u672a\u6253\u5f00"); return; }
  var video = document.getElementById("camVid");
  var vw = video.videoWidth || 0, vh = video.videoHeight || 0;
  if (vw < 10 || vh < 10) { showToast("\u89c6\u9891\u672a\u5c31\u7eea"); return; }

  try {
    var canvas = document.createElement("canvas");
    canvas.width = vw; canvas.height = vh;
    canvas.getContext("2d").drawImage(video, 0, 0, vw, vh);
    document.getElementById("camFlash").classList.add("on");
    setTimeout(function () { document.getElementById("camFlash").classList.remove("on"); }, 150);

    /* 即时反馈：不等处理完成就更新计数（视觉上零延迟） */
    var snapItem = currentProject && currentIndex >= 0 ? currentProject.items[currentIndex] : null;
    if (snapItem) {
      document.getElementById("camInfo").textContent =
        snapItem.displayName + " (" + (snapItem.photos.length + 1) + "\u5f20\u2026\u5904\u7406\u4e2d)";
    }
    addPhoto(canvas).then(function () {
      if (snapItem) {
        document.getElementById("camInfo").textContent =
          snapItem.displayName + " (" + snapItem.photos.length + "\u5f20)";
      }
    }).catch(function () {
      if (snapItem) {
        document.getElementById("camInfo").textContent =
          snapItem.displayName + " (" + snapItem.photos.length + "\u5f20)";
      }
    });
  } catch (e) { showToast("\u62cd\u7167\u5931\u8d25"); }
}

/* ===================== 相册选择 ===================== */
function openGallery() {
  closeSheet();
  if (currentIndex < 0 || !currentProject) { showToast("\u8bf7\u5148\u6253\u5f00\u9879"); return; }
  if (isGalleryProcessing) { showToast("\u6b63\u5728\u5904\u7406"); return; }

  var inp = document.getElementById("galInput");
  inp.value = "";
  var newInp = inp.cloneNode(true);
  inp.parentNode.replaceChild(newInp, inp);
  newInp.addEventListener("change", onGallerySelect);
  requestAnimationFrame(function () { try { newInp.click(); } catch (e) { showToast("\u65e0\u6cd5\u6253\u5f00\u76f8\u518c"); } });
}

function openVideoPicker() {
  closeSheet();
  if (currentIndex < 0 || !currentProject) { showToast("\u8bf7\u5148\u6253\u5f00\u9879"); return; }
  if (isGalleryProcessing) { showToast("\u6b63\u5728\u5904\u7406"); return; }
  var inp = document.getElementById("vidInput");
  inp.value = "";
  var newInp = inp.cloneNode(true);
  inp.parentNode.replaceChild(newInp, inp);
  newInp.addEventListener("change", onGallerySelect);
  requestAnimationFrame(function () { try { newInp.click(); } catch (e) { showToast("\u65e0\u6cd5\u6253\u5f00\u89c6\u9891\u9009\u62e9"); } });
}

function onGallerySelect(e) {
  var files = e.target.files;
  if (!files || !files.length) return;
  isGalleryProcessing = true;
  dupImportCount = 0;
  dupSimilarCount = 0;
  var fileArray = [];
  for (var i = 0; i < files.length; i++) fileArray.push(files[i]);

  showToast("\u5904\u7406 " + fileArray.length + " \u5f20...");
  var addedCount = 0, errorCount = 0;

  function processNext(idx) {
    if (idx >= fileArray.length) {
      isGalleryProcessing = false;
      showToast(addedCount > 0 ? "\u2705 " + addedCount + "\u5f20" + (dupImportCount ? " \u00b7 \u26a0" + dupImportCount + "\u91cd\u590d" : "") + (dupSimilarCount ? " \u00b7 \u26a1" + dupSimilarCount + "\u76f8\u4f3c" : "") + (errorCount ? " \u00b7 \u274c" + errorCount : "") : "\u5904\u7406\u5931\u8d25");
      return;
    }
    (function (f) {
      window._pendingFileHash = null;
      var isVideo = (f.type && f.type.indexOf("video/") === 0) || /\.(mp4|mov|m4v|avi|mkv|3gp)$/i.test(f.name || "");
      /* ★fileByteHash 必须先完成再处理（哈希就绪才能查重） */
      var prep = fileByteHash(f).then(function (fh) {
        window._pendingFileHash = fh || "";
        return isVideo
          ? videoToCover(f).then(function (r) { pendingVideoMeta = r.meta; pendingFileForensics = null; return r.canvas; })
          : scanFileForensics(f).then(function (fx) { pendingFileForensics = fx; pendingVideoMeta = null; return fileToCanvas(f); });
      });
      prep.then(function (canvas) {
        return addPhoto(canvas);
      }).then(function () { addedCount++; })
        .catch(function (e) {
          errorCount++;
          showToast("❌ " + (f.name || "文件") + " 处理失败：" + (e && e.message ? e.message : "未知"), 3500);
        })
        .then(function () { processNext(idx + 1); });
    })(fileArray[idx]);
  }
  processNext(0);
}

/* ===================== 视频素材：封面帧+参数提取（纯本地） =====================
   视频只保存封面帧（入册走照片全流程：水印/查重/核对），
   帧率/时长/分辨率自动提取并写入验收备注；视频原件不存储（省空间） */
var pendingVideoMeta = null;

function parseMp4Meta(file) {
  /* MP4/MOV容器二进制解析：时长(mdhd)、分辨率(tkhd)、帧率(stts)——不依赖解码器 */
  return new Promise(function (resolve) {
    try {
      var settled = false;
      var fin = function (val) { if (!settled) { settled = true; resolve(val || {}); } };
      setTimeout(function () { fin({}); }, 5000);
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var dv = new DataView(reader.result);
          var meta = {};
          var walk = function (start, end) {
            var p = start;
            while (p + 8 <= end) {
              var size = dv.getUint32(p);
              if (size < 8 || p + size > end) break;
              var type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
              if (type === "moov" || type === "trak" || type === "mdia") {
                if (walkNest < 60) { walkNest++; walk(p + 8, p + size); walkNest--; }
              } else if (type === "mdhd" && !meta.timescale) {
                var ver = dv.getUint8(p + 8);
                if (ver === 1) {
                  meta.timescale = dv.getUint32(p + 28);
                  meta.durationTicks = Number(dv.getUint32(p + 32)) * 4294967296 + dv.getUint32(p + 36);
                } else {
                  meta.timescale = dv.getUint32(p + 20);
                  meta.durationTicks = dv.getUint32(p + 24);
                }
              } else if (type === "stts" && !meta.fps) {
                var cnt = dv.getUint32(p + 12);
                if (cnt >= 1) {
                  var delta = dv.getUint32(p + 20);
                  if (delta > 0 && meta.timescale) meta.fps = Math.round((meta.timescale / delta) * 100) / 100;
                }
              } else if (type === "tkhd") {
                var v2 = dv.getUint8(p + 8);
                var wOff = v2 === 1 ? p + 96 : p + 84;
                var w = dv.getUint32(wOff) >>> 16, h = dv.getUint32(wOff + 4) >>> 16;
                if (w > 0 && h > 0 && !meta.width) { meta.width = w; meta.height = h; }
              }
              p += size;
            }
          };
          var walkNest = 0;
          walk(0, dv.byteLength);
          if (meta.timescale && meta.durationTicks) {
            meta.duration = Math.round((meta.durationTicks / meta.timescale) * 10) / 10;
          }
          fin(meta);
        } catch (e) { fin({}); }
      };
      reader.onerror = function () { fin({}); };
      reader.readAsArrayBuffer(file.slice(0, 4194304));
    } catch (e) { resolve({}); }
  });
}


function videoToCover(file) {
  return new Promise(function (resolve, reject) {
    try {
      var url = URL.createObjectURL(file);
      var v = document.createElement("video");
      v.preload = "auto";
      v.muted = true;
      v.playsInline = true;
      var done = false;
      var watchdog = null;
      /* 兜底：解码失败/超时 → 占位封面 + MP4二进制参数（小米H.265等不支持解码的场景） */
      var fallback = function () {
        if (done) return; done = true;
        if (watchdog) clearTimeout(watchdog);
        URL.revokeObjectURL(url);
        parseMp4Meta(file).then(function (m) {
          var w = m.width || 800, h = m.height || 450;
          var c = document.createElement("canvas");
          c.width = w; c.height = h;
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#2c3a4f"; ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = "#8fa6c4"; ctx.textAlign = "center";
          ctx.font = "bold " + Math.round(h / 8) + "px sans-serif";
          ctx.fillText("\ud83c\udfa5 \u89c6\u9891\u7d20\u6750", w / 2, h / 2 - h / 16);
          ctx.font = Math.round(h / 22) + "px sans-serif";
          ctx.fillText("\u7f16\u7801\u4e0d\u652f\u6301\u9884\u89c8\uff0c\u53c2\u6570\u5df2\u7559\u8bc1" + (m.width ? " \u00b7 " + m.width + "\u00d7" + m.height : ""), w / 2, h / 2 + h / 12);
          resolve({
            canvas: c,
            meta: {
              duration: m.duration || 0, width: m.width || 0, height: m.height || 0,
              fps: m.fps || null, size: file.size, name: file.name || "", placeholder: true
            }
          });
        }).catch(function () { reject(new Error("video parse fail")); });
      };
      watchdog = setTimeout(fallback, 8000);
      var extract = function () {
        if (done) return; done = true;
        clearTimeout(watchdog);
        try {
          var meta = {
            duration: Math.round((v.duration || 0) * 10) / 10,
            width: v.videoWidth, height: v.videoHeight,
            size: file.size, name: file.name || ""
          };
          var c = document.createElement("canvas");
          c.width = v.videoWidth || 640; c.height = v.videoHeight || 360;
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          parseMp4Meta(file).then(function (m) {
            meta.fps = m.fps || meta.fps || null;
            if (!meta.duration && m.duration) meta.duration = m.duration;
            resolve({ canvas: c, meta: meta });
          }).catch(function () { resolve({ canvas: c, meta: meta }); });
        } catch (e) { done = false; fallback(); } /* 复位 done 再兑底，否则 fallback 被守卫拦住→挂死+URL泄漏 */
      };
      v.onloadeddata = extract;
      v.onerror = fallback;
      v.src = url;
    } catch (e) { try { URL.revokeObjectURL(url); } catch (e2) {} reject(e); }
  });
}

/* ===================== 文件字节哈希（查重主哈希） =====================
   从文件原始字节算哈希，100%确定性：同一个文件 = 同一个哈希 */
function fileByteHash(file) {
  return new Promise(function (resolve) {
    try {
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var buf = new Uint8Array(ev.target.result);
          var h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
          for (var i = 0; i < buf.length; i++) {
            h1 ^= buf[i]; h1 = (h1 * 0x01000193) >>> 0;
            h2 ^= buf[buf.length - 1 - i]; h2 = (h2 * 0x01000193) >>> 0;
          }
          resolve(h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
        } catch (e) { resolve(""); }
      };
      reader.onerror = function () { resolve(""); };
      reader.readAsArrayBuffer(file.slice(0, 4 * 1024 * 1024));
    } catch (e) { resolve(""); }
  });
}

/* ===================== 照片防篡改轻量体检（纯本地） =====================
   ① EXIF/元数据：编辑软件痕迹（PS/美图/醒图等会留标记）、相机直拍信息
   ② ELA误差水平分析：局部PS修改会暴露噪声异常（缩到420px，毫秒级）
   全程照片不出手机 */
var pendingFileForensics = null;

function scanFileForensics(file) {
  return new Promise(function (resolve) {
    try {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var bytes = new Uint8Array(reader.result);
          var s = "";
          for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
          /* 字节级匹配（中文关键字按UTF-8字节搜，规避编码问题） */
          var bytesIndexOf = function (pat) {
            outer: for (var i2 = 0; i2 + pat.length <= bytes.length; i2++) {
              for (var j = 0; j < pat.length; j++) { if (bytes[i2 + j] !== pat[j]) continue outer; }
              return i2;
            }
            return -1;
          };
          var enc = new TextEncoder();
          var soft = "";
          var marks = [["Adobe Photoshop", "PS"], ["Photoshop", "PS"], ["ACDSee", "ACDSee"],
            ["Lightroom", "Lightroom"], ["Snapseed", "Snapseed"], ["PicsArt", "PicsArt"],
            ["\u7f8e\u56fe", "\u7f8e\u56fe"], ["\u9192\u56fe", "\u9192\u56fe"], ["\u5929\u5929P\u56fe", "\u5929\u5929P\u56fe"],
            ["\u6cfc\u8fa3", "\u6cfc\u8fa3"], ["GIMP", "GIMP"], ["Canva", "Canva"],
            ["\u7a3f\u5b9a", "\u7a3f\u5b9a"], ["\u521b\u5ba2\u8d34", "\u521b\u5ba2\u8d34"], ["PhotoScape", "PhotoScape"]];
          for (var m = 0; m < marks.length; m++) {
            if (bytesIndexOf(enc.encode(marks[m][0])) >= 0) { soft = marks[m][1]; break; }
          }
          var camera = /Apple|iPhone|HUAWEI|HONOR|XIAOMI|Xiaomi|OPPO|vivo|samsung|Canon|Nikon|SONY|Sony|Hasselblad|Exif/i.test(s);
          /* PNG文本块扫描：PNG编辑软件痕迹藏在tEXt/iTXt块中 */
          if (!soft) {
            var pngMarks = ["Adobe", "Photoshop", "GIMP", "Canva", "\u7f8e\u56fe", "\u9192\u56fe", "Illustrator", "InDesign"];
            for (var pm = 0; pm < pngMarks.length; pm++) {
              if (bytesIndexOf(enc.encode(pngMarks[pm])) >= 0) { soft = pngMarks[pm]; break; }
            }
          }
          /* 无相机EXIF + 无编辑标记 = 可疑（真照片必有相机信息） */
          var suspicious = !camera && !soft;
          resolve({ software: soft, camera: camera, suspicious: suspicious });
        } catch (e) { resolve({ software: "", camera: null }); }
      };
      reader.onerror = function () { resolve({ software: "", camera: null }); };
      reader.readAsArrayBuffer(file.slice(0, 262144)); /* 只读前256KB，轻量 */
    } catch (e) { resolve({ software: "", camera: null }); }
  });
}

/* ELA：重编码0.9质量后比对误差分布，局部修改区域误差异常凸起 */
function elaCheck(srcCanvas) {
  return new Promise(function (resolve) {
    try {
      var isWx = /MicroMessenger/i.test(navigator.userAgent) && !/wxwork/i.test(navigator.userAgent);
      var w = Math.min(srcCanvas.width, isWx ? 120 : 160); /* 微信WebView更慢，ELA画布压到120px */
      var h = Math.max(1, Math.round(srcCanvas.height * (w / srcCanvas.width)));
      var c1 = document.createElement("canvas");
      c1.width = w; c1.height = h;
      var x1 = c1.getContext("2d");
      x1.drawImage(srcCanvas, 0, 0, w, h);
      var orig = x1.getImageData(0, 0, w, h).data;
      var img = new Image();
      img.onload = function () {
        try {
          var c2 = document.createElement("canvas");
          c2.width = w; c2.height = h;
          var x2 = c2.getContext("2d");
          x2.drawImage(img, 0, 0, w, h);
          var dec = x2.getImageData(0, 0, w, h).data;
          /* 16px块误差统计 */
          var bs = 16, cols = Math.ceil(w / bs), rows = Math.ceil(h / bs);
          var blocks = [], total = 0;
          for (var by = 0; by < rows; by++) {
            for (var bx = 0; bx < cols; bx++) {
              var sum = 0, n = 0;
              for (var y = by * bs; y < Math.min((by + 1) * bs, h); y++) {
                for (var x = bx * bs; x < Math.min((bx + 1) * bs, w); x++) {
                  var i = (y * w + x) * 4;
                  sum += Math.abs(orig[i] - dec[i]) + Math.abs(orig[i + 1] - dec[i + 1]) + Math.abs(orig[i + 2] - dec[i + 2]);
                  n++;
                }
              }
              var e = n ? sum / (n * 3) : 0;
              blocks.push(e); total += e;
            }
          }
          var mean = total / Math.max(1, blocks.length);
          var varSum = 0;
          blocks.forEach(function (b) { varSum += (b - mean) * (b - mean); });
          var std = Math.sqrt(varSum / Math.max(1, blocks.length));
          var hot = 0, maxB = 0;
          blocks.forEach(function (b) {
            if (b > maxB) maxB = b;
            if (b > mean + 3 * std && b > 6) hot++;
          });
          var hotPct = hot / Math.max(1, blocks.length);
          resolve({
            score: Math.round(Math.min(100, hotPct * 400)),
            hot: hot,
            verdict: (hotPct >= 0.03 && maxB > mean * 3 + 6) ? "suspect" : "clean"
          });
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = c1.toDataURL("image/jpeg", 0.9);
    } catch (e) { resolve(null); }
  });
}

function forensicIcon(photo) {
  var f = photo.forensics;
  if (!f) return "";
  if (f.software) return '<span class="pv pv-low" title="\u5143\u6570\u636e\u542b\u7f16\u8f91\u8f6f\u4ef6\u75d5\u8ff9\uff1a' + escapeHtml(f.software) + '\uff0c\u8bf7\u6838\u5b9e\u662f\u5426\u4fee\u56fe">\u26a0PS</span>';
  if (f.ela && f.ela.verdict === "suspect") return '<span class="pv pv-med" title="ELA\u8bef\u5dee\u5206\u6790\u53d1\u73b0\u5c40\u90e8\u566a\u58f0\u5f02\u5e38\uff0c\u7591\u4f3c\u5c40\u90e8\u4fee\u6539\uff08\u70ed\u5757' + f.ela.hot + '\u4e2a\uff09">\u26a0\u4fee\u56fe</span>';
  if (f.suspicious) return '<span class="pv pv-med" title="\u65e0\u76f8\u673aEXIF\u4fe1\u606f\u4e14\u65e0\u7f16\u8f91\u8f6f\u4ef6\u6807\u8bb0\uff0c\u53ef\u80fd\u4e3a\u622b\u56fe/PNG\u5bfc\u51fa\u6216\u7ecf\u8f6c\u5b58\uff0c\u8bf7\u6838\u5b9e">\u26a0\u5b58\u7591</span>';
  if (!f.camera && !f.software) return '<span class="pv" title="\u672a\u505a\u6587\u4ef6\u7ea7\u53d6\u8bc1\uff08\u591a\u4e3a\u76f8\u673a\u76f4\u62cd\u6216\u622a\u56fe\uff09\uff0c\u4e0d\u4ee3\u8868\u5df2\u9a8c\u771f">\u26aa\u672a\u68c0\u6d4b</span>';
  return '<span class="pv pv-high" title="\u672a\u53d1\u73b0\u7f16\u8f91\u75d5\u8ff9\uff08\u5143\u6570\u636e' + (f.camera ? "\u542b\u76f8\u673a\u4fe1\u606f" : "\u65e0\u76f8\u673a\u4fe1\u606f") + '\uff0cELA\u6b63\u5e38">\ud83d\udee1</span>';
}

/* ===================== 保存照片 ===================== */
function addPhoto(sourceCanvas) {
  return new Promise(function (resolve, reject) {
    var targetIdx = currentIndex;
    var targetItem = (currentProject && targetIdx >= 0) ? currentProject.items[targetIdx] : null;
    if (targetIdx < 0 || !targetItem) {
      showToast("\u672a\u6253\u5f00\u9879");
      reject(new Error("No item selected"));
      return;
    }
    try {
      var max = Math.min(IMG_MAX_SIZE, 1080), w = sourceCanvas.width, h = sourceCanvas.height; /* 1080px：验收照片够用，处理提速 */
      if (w <= 0 || h <= 0) { reject(new Error("Invalid canvas")); return; }
      if (w > max || h > max) {
        var ratio = Math.min(max / w, max / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      var canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas ctx failed")); return; }
      ctx.drawImage(sourceCanvas, 0, 0, w, h);
      var phashRaw = perceptualHash(sourceCanvas); /* ★原始图哈希，不缩放→同图必同哈希 */

      var now = new Date();
      var dateStr = now.getFullYear() + "-" + padZero(now.getMonth() + 1) + "-" + padZero(now.getDate()) +
        " " + padZero(now.getHours()) + ":" + padZero(now.getMinutes()) + ":" + padZero(now.getSeconds());

      /* ★GPS完全非阻塞：有缓存用缓存，没有就立刻拍照（空地址），后台补定位 */
      var cachedLoc = window._camGeoCache || "";
      /* 后台持续定位（每次拍照都刷新缓存，微信GPS慢就多试几次） */
      if (!cachedLoc || !window._geoFresh) {
        window._geoFresh = true;
        getLocation().then(function (loc) {
          if (loc) {
            window._camGeoCache = loc;
            window._geoFresh = true;
            try { localStorage.setItem("jf_last_addr", loc); } catch (e) {}
          }
        }).catch(function () {});
      }
      if (cachedLoc) {
        savePhotoData(canvas, dateStr, cachedLoc, resolve, reject, targetItem, phashRaw);
      } else {
        savePhotoData(canvas, dateStr, "", resolve, reject, targetItem, phashRaw);
        /* 后台补定位（不阻塞拍照），拿到后回填到未填地址的照片 */
        getLocation().then(function (loc) {
          if (loc) {
            window._camGeoCache = loc;
            window._geoFresh = true;
            try { localStorage.setItem("jf_last_addr", loc); } catch (e) {}
            if (targetItem) {
              for (var pi = targetItem.photos.length - 1; pi >= 0; pi--) {
                if (!targetItem.photos[pi].location) {
                  targetItem.photos[pi].location = loc;
                  saveProject();
                  renderPhotoGrid();
                  break;
                }
              }
            }
          }
        }).catch(function () {});
      }
    } catch (e) { showToast("\u7167\u7247\u5931\u8d25"); reject(e); }
  });
}

function savePhotoData(canvas, dateStr, location, resolve, reject, targetItem, phashRaw) {
  try {
    var elaP = elaCheck(canvas); /* 水印烤入前做ELA分析 */
    if (!location && !window._geoWarnShown) {
      window._geoWarnShown = true;
      showToast("\ud83d\udccd \u5b9a\u4f4d\u83b7\u53d6\u4e2d\uff0c\u6c34\u5370\u5730\u5740\u7a0d\u540e\u8865\u4e0a\uff08\u8bf7\u5141\u8bb8\u5fae\u4fe1\u5b9a\u4f4d\u6388\u6743\uff09", 4000);
    }
    /* ★用原始图哈希（不缩放不水印），同图必同哈希→查重零误差 */
    var phash = phashRaw || perceptualHash(canvas);
    var fileHash = window._pendingFileHash || "";
    window._pendingFileHash = null; /* 用完即清，防止残留 */
    applyWatermark(canvas, dateStr, location);
    var dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    if (!dataUrl || dataUrl.indexOf("data:image/jpeg;base64,") !== 0 || dataUrl.length < 500) {
      showToast("\u7167\u7247\u751f\u6210\u5931\u8d25");
      reject(new Error("Invalid data URL"));
      return;
    }
    var item = targetItem || currentProject.items[currentIndex];
    var photoIdx = item.photos.length;
    var fileDup = null;
    if (fileHash) {
      currentProject.items.forEach(function (it) {
        (it.photos || []).forEach(function (p, j) {
          if (p.fileHash && p.fileHash === fileHash && !fileDup) {
            fileDup = it.displayNum + "-" + (j + 1);
          }
        });
      });
    }
    var synthetic = !!(pendingVideoMeta && pendingVideoMeta.placeholder); /* 视频解码失败占位封面=合成图，感知哈希无意义 */
    var dupR = synthetic ? null : findDuplicatePhoto(phash, null);
    /* ★文件哈希=硬拦（同文件必拦），感知哈希=只警告（人工确认） */
    var dup = fileDup ? fileDup : "";
    var localHits = localHashCheck(synthetic ? null : phash, fileHash, currentProject.acceptNo || "");
    /* ★fileHash 命中 = 硬拦（跨项目同文件必拦） */
    for (var li = 0; li < localHits.length; li++) {
      if (localHits[li].byFile) {
        dup = "\u96c6\u56e2\u6587\u4ef6\u91cd\u590d:" + (localHits[li].project || localHits[li].acceptNo || "");
        break;
      }
    }
    /* 感知哈希 = 只警告 */
    var localWarn = localHits.length && !dup ? ("\u96c6\u56e2\u7591\u4f3c:" + (localHits[0].project || localHits[0].acceptNo || "")) : "";
    /* 感知哈希只警告不拦（防误报：不同照片哈希偶有接近） */
    /* 确保索引已加载（异步，不阻塞） */
    if (!hashIndexCache) loadHashIndex();
    queueHashCheck({ hash: synthetic ? "" : phash, fileHash: fileHash || "", date: dateStr, acceptNo: currentProject.acceptNo || "", project: currentProject.name || "", name: item.displayName, idx: photoIdx });
    if (dup && phash) { dupImportCount++; addInterceptStat("dup"); } /* 硬判 */
    else if (dupR && dupR.similar && !dup) { dupSimilarCount++; addInterceptStat("similar"); }
    item.photos.push({ dataUrl: dataUrl, date: dateStr, location: location, hash: synthetic ? null : phash, hashSynthetic: synthetic ? 1 : 0, fileHash: fileHash, duplicate: dup ? 1 : 0, dupOf: dup || "", dupSimilar: (dupR && !dup && dupR.similar) ? 1 : 0, dupSimilarOf: (dupR && dupR.similar) || "", dupWarn: localWarn || "" });
    var ph = item.photos[item.photos.length - 1];
    if (pendingVideoMeta) {
      ph.video = pendingVideoMeta;
      ph.videoRemarkText = buildVideoRemark(pendingVideoMeta);
      refreshVideoRemarks(item); /* 视频备注以照片为准重建：删旧自动清、换新自动更 */
      pendingVideoMeta = null;
    }
    ph.forensics = {
      software: pendingFileForensics ? (pendingFileForensics.software || "") : "",
      camera: pendingFileForensics ? pendingFileForensics.camera : null
    };
    pendingFileForensics = null;
    elaP.then(function (r) {
      ph.forensics.ela = r;
      if (r && r.verdict === "suspect") showToast("\u26a0 \u7167\u7247\u7591\u4f3c\u5c40\u90e8\u4fee改（ELA异常），请核实", 4000);
      if (ph.forensics.software) showToast("\u26a0 \u7167片\u5143数据含\u7f16辑软件痕迹\uff1a" + ph.forensics.software, 4000);
      renderPhotoGrid();
    }).catch(function () {});
    queueAutoVerify(item);
    if (dup) showToast("\u26a0 \u4e0e [" + dup + "] \u540c\u4e00\u5f20\u7167\u7247\uff08\u91cd\u590d\u7528\u56fe\uff09\uff0c\u5df2\u6807\u8bb0\u62e6\u622a", 4000);
    else if (dupR && dupR.similar) showToast("\u26a1 \u4e0e [" + dupR.similar + "] \u6781\u76f8\u4f3c\uff08\u4e0d\u540c\u7167\u7247\uff0c\u4e0d\u62e6\u622a\uff0c\u4ec5\u63d0\u793a\uff09", 3500);
    renderPhotoGrid();
    renderItemList();

    dbPut(photoDataKey(currentProject.key, item.sortKey, photoIdx), dataUrl).then(function () {
      saveProject();
      checkStorageSpace();
      resolve(true);
    }).catch(function (e) {
      console.error("IDB save failed:", e);
      saveProject();
      showToast("\u5df2\u6dfb\u52a0(\u4ec5\u5185\u5b58)");
      resolve(true);
    });
  } catch (e) { showToast("\u4fdd\u5b58\u5931\u8d25"); reject(e); }
}

/* ===================== 生成PDF ===================== */
function genPDF() {
  if (!currentProject) return;
  var doneCount = currentProject.items.filter(function (x) { return x.accepted; }).length;
  var total = currentProject.items.length;
  if (doneCount < total) {
    showToast("\u8bf7\u5148\u5b8c\u6210\u5168\u90e8\u9a8c\u6536 (" + doneCount + "/" + total + ")");
    return;
  }
  if (typeof html2canvas === "undefined") { showToast("\u6e32\u67d3\u5e93\u672a\u52a0\u8f7d\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u5237\u65b0"); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { showToast("PDF\u5e93\u672a\u52a0\u8f7d\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u5237\u65b0"); return; }

  var hdMode = window.confirm("\u751f\u6210\u5e26\u300c\u539f\u56fe\u9644\u9875\u300d\u7684\u9ad8\u6e05\u7248PDF\uff1f\n\n\u3010\u786e\u5b9a\u3011\u9ad8\u6e05\u7248\uff1a\u7167\u7247\u539f\u56fe\u7cbe\u5ea6\u5355\u72ec\u6210\u9875 + \u53ef\u70b9\u51fb\u7d22\u5f15\uff0c\u653e\u5927\u53ef\u6838\u5b9e\uff08\u6587\u4ef6\u8f83\u5927\uff09\n\u3010\u53d6\u6d88\u3011\u7d27\u51d1\u7248\uff1a\u4ec5\u9a8c\u6536\u5355\u8868\u683c\uff08\u7167\u7247\u4e3a\u5c0f\u56fe\uff0c\u4e0d\u4fbf\u653e\u5927\uff09");

  showLoading("\u6b63\u5728\u751f\u6210...");

  var cleanName = currentProject.name
    .replace(/\u6d3b\u52a8\u8d39\u7528\u62a5\u4ef7\u6e05\u5355/g, "")
    .replace(/\u6d3b\u52a8\u8d39\u7528\u9a8c\u6536\u6e05\u5355/g, "")
    .replace(/\u62a5\u4ef7\u6e05\u5355/g, "").replace(/\u9a8c\u6536\u6e05\u5355/g, "")
    .replace(/\u62a5\u4ef7\u5355/g, "").replace(/\u9a8c\u6536\u5355/g, "")
    .replace(/\s+/g, "").trim();
  if (!cleanName) cleanName = "\u9879\u76ee";

  var title = cleanName + "\u6d3b\u52a8\u8d39\u7528\u9a8c\u6536\u6e05\u5355";
  var fontCSS = 'font-family:SimSun,\u5b8b\u4f53,serif;';
  var border = '0.5px solid #000';
  var colWidth = '76px';

  var html = '<div style="padding:32px 40px;' + fontCSS + 'color:#000;">';
  /* ★标题区：标题+验收单号（右上角） */
  var acceptNoStr = currentProject.acceptNo || "";
  html += '<div style="margin-bottom:20px;padding-bottom:10px;border-bottom:0.5pt solid #888;position:relative;">' +
    '<div style="text-align:center;font-size:22px;font-weight:900;letter-spacing:3px;">' + escapeForPdf(title) + '</div>' +
    (acceptNoStr ? '<div style="position:absolute;right:0;top:2px;font-size:11px;color:#555;font-weight:600;">验收单号：' + escapeForPdf(acceptNoStr) + '</div>' : '') +
    '</div>';
  html += '<table style="border-collapse:collapse;border-spacing:0;width:100%;font-size:12px;' + fontCSS + '">';

  var thStyle = 'border:' + border + ';padding:8px 6px;text-align:center;background:#dae4f0;font-weight:700;color:#000;';
  html += '<thead><tr>';
  html += '<th style="' + thStyle + 'width:36px;">\u5e8f\u53f7</th>';
  html += '<th style="' + thStyle + '">\u62a5\u4ef7\u540d\u79f0<br><span style="font-size:9px;font-weight:400;color:#555;">(\u5185\u5bb9/\u89c4\u683c/\u5de5\u827a/\u5c3a\u5bf8/\u7528\u9014\u63cf\u8ff0)</span></th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u6570\u91cf</th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u5355\u4f4d</th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u5355\u4ef7</th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u91d1\u989d</th>';
  html += '<th style="' + thStyle + 'min-width:180px;">\u9a8c\u6536\u7167\u7247</th>';
  html += '<th style="' + thStyle + 'min-width:120px;">\u5907\u6ce8</th>';
  html += '</tr></thead><tbody>';

  var totalAmount = 0;
  for (var i = 0; i < currentProject.items.length; i++) {
    var item = currentProject.items[i];
    totalAmount += parseFloat(item.acceptAmount) || 0;
    var photoHtml = '';
    for (var j = 0; j < item.photos.length; j++) {
      var p = item.photos[j];
      if (!p.dataUrl || p.duplicate) continue; /* 疑似重复照片不进验收单 */
      photoHtml += '<div style="display:inline-block;vertical-align:top;margin:2px;max-width:100px;text-align:center;">' +
        '<img src="' + ((/^data:image\/(jpeg|png|gif|webp);base64,/i.test(p.dataUrl || "")) ? escapeHtml(p.dataUrl) : "") + '" style="display:block;max-width:100px;max-height:68px;object-fit:contain;border:0.25px solid #bbb;" />' +
        '<div style="font-size:7px;color:#555;margin-top:1px;line-height:1.2;max-width:100px;overflow:hidden;">' + escapeForPdf(formatTimestamp(p.date)) + '</div></div>';
    }
    var tdStyle = 'border:' + border + ';padding:6px 8px;text-align:center;color:#000;';
    html += '<tr>' +
      '<td style="' + tdStyle + 'font-weight:600;">' + item.displayNum + '</td>' +
      '<td style="' + tdStyle + 'text-align:left;font-size:11.5px;line-height:1.4;">' + escapeForPdf(item.displayName) + '</td>' +
      '<td style="' + tdStyle + '">' + escapeForPdf(String(item.acceptQty || '-')) + '</td>' +
      '<td style="' + tdStyle + '">' + escapeForPdf(item.origUnit || '-') + '</td>' +
      '<td style="' + tdStyle + '">' + (item.acceptPrice ? Number(item.acceptPrice).toLocaleString('zh') : '-') + '</td>' +
      '<td style="' + tdStyle + 'font-weight:600;">' + (item.acceptAmount ? Number(item.acceptAmount).toLocaleString('zh', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-') + '</td>' +
      '<td style="border:' + border + ';padding:4px 6px;line-height:0;text-align:left;">' + (photoHtml || '<span style="font-size:11px;color:#aaa;line-height:1;">-</span>') + '</td>' +
      '<td style="' + tdStyle + 'text-align:left;font-size:11px;line-height:1.4;">' + escapeForPdf(item.remark || '') +
        /* ★复核意见只在有问题照片还存在时才显示 */
        (item.aiReview && String(item.remark || '').indexOf(item.aiReview) < 0 && (function() {
          var hasIssuePhoto = (item.photos || []).some(function(p) {
            return p.dataUrl && !p.duplicate && (p.aiVerify === 'low' || p.aiVerify === 'medium');
          });
          return hasIssuePhoto;
        })() ? '<div style="margin-top:3px;font-size:9.5px;color:#444;">AI\u590d\u6838\uff1a' + escapeForPdf(item.aiReview) + '</div>' : '') + '</td></tr>';
  }

  var totalTdStyle = 'border:' + border + ';padding:8px 6px;text-align:center;background:#e2e2e2;font-weight:900;color:#000;';
  html += '<tr><td style="' + totalTdStyle + '">\u5408\u8ba1</td>';
  for (var k = 0; k < 4; k++) html += '<td style="border:' + border + ';padding:6px;background:#e2e2e2;"></td>';
  html += '<td style="' + totalTdStyle + 'font-size:13px;">' + totalAmount.toLocaleString('zh', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>';
  html += '<td style="border:' + border + ';padding:6px;background:#e2e2e2;"></td>';
  html += '<td style="border:' + border + ';padding:6px;background:#e2e2e2;"></td></tr>';
  html += '</tbody></table>';

  /* 落款区：表格布局（html2canvas渲染稳定），每格显式统一13px，杜绝字号不一 */
  var ulStyle = 'border-bottom:1px solid #000;display:inline-block;height:1em;vertical-align:bottom;';
  var dateHtml = function (padTop) {
    return '<td style="font-size:13px;white-space:nowrap;text-align:right;vertical-align:bottom;padding-top:' + padTop + 'px;' + fontCSS + '">' +
      '\u65e5\u671f\uff1a<span style="' + ulStyle + 'width:52px;">&nbsp;</span>\u5e74' +
      '<span style="' + ulStyle + 'width:30px;">&nbsp;</span>\u6708' +
      '<span style="' + ulStyle + 'width:30px;">&nbsp;</span>\u65e5</td>';
  };
  var vcode = docVerifyCode();
  html += '<table style="width:100%;border-collapse:collapse;border-spacing:0;' + fontCSS + '" cellspacing="0" cellpadding="0">';
  html += '<tr>';
  html += '<td style="font-size:13px;white-space:nowrap;vertical-align:bottom;padding-top:32px;' + fontCSS + '">\u9a8c\u6536\u4eba\uff1a<span style="' + ulStyle + 'min-width:120px;">&nbsp;</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\u590d\u6838\u4eba\uff1a<span style="' + ulStyle + 'min-width:120px;">&nbsp;</span></td>';
  html += dateHtml(32);
  html += '</tr>';
  html += '<tr>';
  html += '<td style="font-size:13px;white-space:nowrap;vertical-align:bottom;padding-top:72px;' + fontCSS + '">\u4f9b\u5e94\u5546\u76d6\u7ae0\uff1a<span style="' + ulStyle + 'min-width:120px;">&nbsp;</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\u4f9b\u5e94\u5546\u7b7e\u5b57\uff1a<span style="' + ulStyle + 'min-width:110px;">&nbsp;</span></td>';
  html += dateHtml(72);
  html += '</tr>';
  html += '</table>';
  html += '<div style="margin-top:10px;font-size:10px;color:#555;text-align:right;">\u9632\u4f2a\u9a8c\u8bc1\u7801\uff1a' + vcode + '</div>';
  html += '</div>';

  var container = document.createElement("div");
  container.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;width:1120px;';
  container.innerHTML = html;
  document.body.appendChild(container);

  var images = container.querySelectorAll("img");
  var loadPromises = [];
  for (var idx = 0; idx < images.length; idx++) {
    (function (img) {
      if (img.complete && img.naturalWidth > 0) return;
      loadPromises.push(new Promise(function (ok) {
        var done = false;
        img.onload = function () { if (!done) { done = true; ok(); } };
        img.onerror = function () { if (!done) { done = true; ok(); } };
        setTimeout(function () { if (!done) { done = true; ok(); } }, 10000);
      }));
    })(images[idx]);
  }

  Promise.all(loadPromises)
    .then(function () { return new Promise(function (ok) { setTimeout(ok, 500); }); })
    .then(function () {
      return html2canvas(container, { scale: 2.5, useCORS: true, logging: false, backgroundColor: "#fff", allowTaint: true });
    })
    .then(function (canvas) {
      document.body.removeChild(container);
      var jsPDF = window.jspdf.jsPDF;
      var imgData = canvas.toDataURL("image/jpeg", 0.92);
      window.__lastPdfImgData = imgData; /* 图片版兜底复用（小米企微等PDF预览不可用场景） */
      var imgWidth = canvas.width, imgHeight = canvas.height;
      var pageWidth = 297, pageHeight = 210;
      var ratio = pageWidth / (imgWidth / 1.5);
      var totalHeight = imgHeight / 1.5 * ratio;

      var doc;
      if (totalHeight > pageHeight) {
        doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", encryption: { userPassword: "", ownerPassword: pdfOwnerPw(), userPermissions: ["print", "copy"] } });
        var remaining = totalHeight, yOffset = 0;
        while (remaining > 0) {
          if (yOffset > 0) doc.addPage();
          var srcY = yOffset / ratio * 1.5;
          var srcH = Math.min(pageHeight, remaining) / ratio * 1.5;
          var tmpCanvas = document.createElement("canvas");
          tmpCanvas.width = imgWidth; tmpCanvas.height = Math.ceil(srcH);
          tmpCanvas.getContext("2d").drawImage(canvas, 0, Math.floor(srcY), imgWidth, Math.ceil(srcH), 0, 0, imgWidth, Math.ceil(srcH));
          doc.addImage(tmpCanvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pageWidth, tmpCanvas.height / 1.5 * ratio);
          remaining -= pageHeight; yOffset += pageHeight;
        }
      } else {
        doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", encryption: { userPassword: "", ownerPassword: pdfOwnerPw(), userPermissions: ["print", "copy"] } });
        doc.addImage(imgData, "JPEG", 0, 0, pageWidth, totalHeight);
      }

      var finishGen = function () {
        pdfBlob = doc.output("blob");
        document.getElementById("pdfBody").innerHTML = html;
        document.getElementById("pdfPreview").classList.add("active");
        hideLoading();
        showToast("\u9a8c\u6536\u6587\u4ef6\u5df2\u751f\u6210");
      };
      if (hdMode) {
        appendPhotoPages(doc).then(finishGen).catch(function (e2) {
          console.error("\u7167\u7247\u9644\u9875\u751f\u6210\u5931\u8d25:", e2);
          finishGen();
        });
      } else {
        finishGen();
      }
    })
    .catch(function (e) {
      try { document.body.removeChild(container); } catch (x) {}
      hideLoading();
      showToast("\u751f\u6210\u5931\u8d25: " + (e.message || ""));
      console.error(e);
    });
}

/* ===================== 防伪验证码 / PDF防修改 ===================== */
function docVerifyCode() {
  try {
    var src = (currentProject.name || "") + "|" + (currentProject.acceptNo || "") + "|" +
      (currentProject.contractNo || "") + "|" +
      currentProject.items.map(function (it) {
        return [it.displayNum, it.acceptQty, it.acceptPrice, it.acceptAmount, it.remark].join("/");
      }).join(";");
    var h1 = 0x811c9dc5, h2 = 0x1000193;
    for (var i = 0; i < src.length; i++) {
      h1 = ((h1 ^ src.charCodeAt(i)) * 16777619) >>> 0;
      h2 = (h2 + src.charCodeAt(i) * (i + 7)) >>> 0;
    }
    var hex = (h1.toString(16) + h2.toString(16)).toUpperCase();
    while (hex.length < 12) hex += "0";
    return hex.slice(0, 4) + "-" + hex.slice(4, 8) + "-" + hex.slice(8, 12);
  } catch (e) { return "0000-0000-0000"; }
}

function pdfOwnerPw() {
  /* 密码学随机（旧 WebView 兑底 Math.random）：PDF owner 密码防随意破解 */
  var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  try {
    if (window.crypto && window.crypto.getRandomValues) {
      var a = new Uint8Array(18);
      window.crypto.getRandomValues(a);
      var out = "";
      for (var i = 0; i < a.length; i++) out += chars.charAt(a[i] % chars.length);
      return out + "#JF";
    }
  } catch (e) {}
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + "#JF";
}

/* ===================== PDF 高清附页（原图精度 + 可点击索引） ===================== */
function loadImgDims(dataUrl) {
  return new Promise(function (resolve) {
    var im = new Image();
    im.onload = function () { resolve({ w: im.naturalWidth || im.width, h: im.naturalHeight || im.height }); };
    im.onerror = function () { resolve({ w: 1400, h: 1050 }); };
    im.src = dataUrl;
  });
}

function buildPhotoIndexPage(photoItems, from, to, pageNo, totalPages) {
  var W = 2339, H = 1654; /* A4横向 200dpi */
  var c = document.createElement("canvas");
  c.width = W; c.height = H;
  var ctx = c.getContext("2d");
  var font = '"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = "#222"; ctx.font = "700 52px " + font;
  ctx.fillText("\u7167\u7247\u7d22\u5f15\uff08\u70b9\u51fb\u6761\u76ee\u8df3\u8f6c\u67e5\u770b\u539f\u56fe\uff0c\u53ef\u653e\u5927\u6838\u5b9e\uff09", W / 2, 70);
  ctx.fillStyle = "#666"; ctx.font = "400 30px " + font;
  ctx.fillText("\u7b2c " + pageNo + " / " + totalPages + " \u9875", W / 2, 145);
  var rows = [], y = 235, rowH = 70;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (var i = from; i < to; i++) {
    var pi = photoItems[i];
    var label = (i + 1) + ". " + pi.item.displayName + "    " + pi.photos.length + "\u5f20\u7167\u7247   \u2192  \u7b2c" + pi.startPage + "\u9875";
    ctx.fillStyle = "#1a1a1a"; ctx.font = "500 34px " + font;
    ctx.fillText(label, 130, y + rowH / 2);
    ctx.strokeStyle = "#d8d8d8"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(130, y + rowH); ctx.lineTo(W - 130, y + rowH); ctx.stroke();
    rows.push(y);
    y += rowH;
  }
  return { canvas: c, rows: rows, rowH: rowH };
}

function appendPhotoPages(doc) {
  var photoItems = [];
  currentProject.items.forEach(function (it) {
    var ph = (it.photos || []).filter(function (p) { return p.dataUrl && !p.duplicate; });
    if (ph.length) photoItems.push({ item: it, photos: ph });
  });
  if (!photoItems.length) return Promise.resolve();

  var ROWS_PER_PAGE = 18;
  var indexPages = Math.max(1, Math.ceil(photoItems.length / ROWS_PER_PAGE));
  var indexStart = doc.internal.getNumberOfPages() + 1;
  var cursor = indexStart + indexPages;
  photoItems.forEach(function (pi) {
    pi.startPage = cursor;
    cursor += pi.photos.length; /* 每张照片单独一页 */
  });

  /* 索引页（canvas 绘制中文 → 整页嵌入 → 行上叠可点击跳转） */
  var px2mm = 297 / 2339;
  for (var ip = 0; ip < indexPages; ip++) {
    var built = buildPhotoIndexPage(photoItems, ip * ROWS_PER_PAGE,
      Math.min((ip + 1) * ROWS_PER_PAGE, photoItems.length), ip + 1, indexPages);
    doc.addPage();
    doc.addImage(built.canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 297, 210);
    for (var r = 0; r < built.rows.length; r++) {
      var piRow = photoItems[ip * ROWS_PER_PAGE + r];
      doc.link(20, built.rows[r] * px2mm, 257, built.rowH * px2mm, { pageNumber: piRow.startPage });
    }
  }

  /* 原图附页：每张照片一页，JPEG 原字节嵌入（无损），放大可核实 */
  var chain = Promise.resolve();
  photoItems.forEach(function (pi) {
    pi.photos.forEach(function (photo, j) {
      chain = chain.then(function () {
        doc.addPage();
        /* 页眉（中文经 canvas 绘制） */
        var hc = document.createElement("canvas");
        hc.width = 2339; hc.height = 150;
        var hctx = hc.getContext("2d");
        hctx.fillStyle = "#ffffff"; hctx.fillRect(0, 0, 2339, 150);
        hctx.textBaseline = "middle";
        hctx.textAlign = "left";
        hctx.fillStyle = "#222";
        hctx.font = '600 46px "PingFang SC","Microsoft YaHei",sans-serif';
        hctx.fillText(pi.item.displayNum + ". " + pi.item.displayName + " \u2014 \u7167\u7247 " + (j + 1) + "/" + pi.photos.length, 60, 75);
        hctx.textAlign = "right";
        hctx.fillStyle = "#b8922e";
        hctx.fillText("\u2190 \u70b9\u51fb\u8fd4\u56de\u7167\u7247\u7d22\u5f15", 2279, 75);
        doc.addImage(hc.toDataURL("image/jpeg", 0.92), "JPEG", 0, 6, 297, 19);
        doc.link(210, 6, 77, 19, { pageNumber: indexStart });

        return loadImgDims(photo.dataUrl).then(function (d) {
          /* 等比缩放居中（保持原始分辨率嵌入） */
          var maxW = 262, maxH = 168, ox = 17.5, oy = 32;
          var pw = d.w || 1400, ph = d.h || 1050;
          var scale = Math.min(maxW / pw, maxH / ph);
          var dw = pw * scale, dh = ph * scale;
          doc.addImage(photo.dataUrl, "JPEG", ox + (maxW - dw) / 2, oy + (maxH - dh) / 2, dw, dh);
        });
      });
    });
  });
  return chain;
}

/* ===================== PDF 下载 / 分享 ===================== */
function isWeComUA() { return /wxwork/i.test(navigator.userAgent || ""); }

/* 企业微信内嵌PDF预览层（兜底）：预览页右上角"..."→发送给朋友 = 转发的是文件 */
function showPdfPreviewModal(url) {
  var old = document.getElementById("pdfPreviewModal");
  if (old) old.remove();
  var div = document.createElement("div");
  div.id = "pdfPreviewModal";
  div.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999;display:flex;flex-direction:column;";
  div.innerHTML =
    '<div style="padding:10px 14px;background:#1e40af;color:#fff;display:flex;justify-content:space-between;align-items:center;">' +
    '<span style="font-size:.9rem;">&#128196; &#39537;&#25910;&#21333; PDF &#39044;&#35272;</span>' +
    '<button onclick="document.getElementById(\'pdfPreviewModal\').remove()" style="background:none;border:none;color:#fff;font-size:1.1rem;padding:2px 8px;">&#10005;</button></div>' +
    '<div style="flex:1;overflow:hidden;"><iframe src="' + url + '" style="width:100%;height:100%;border:0;"></iframe></div>' +
    '<div style="padding:8px 14px;text-align:center;"><button onclick="exportImageVersion()" style="background:#22a06b;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:.88rem;">&#128247; \u8f6c\u56fe\u7247\u7248\u8f6c\u53d1\uff08\u5c0f\u7c73\u673a\u63a8\u8350\uff09</button></div>' +
    '<div style="padding:10px 14px;background:#fdf6e7;font-size:.75rem;color:#9a6410;line-height:1.6;">' +
    '&#128161; &#20256;&#32473;&#39044;&#23548;&#65306;&#22312;&#39044;&#35272;&#39029;&#21491;&#19978;&#35282; &#8943; &#8594; &#12304;&#21457;&#36865;&#32473;&#26379;&#21451;&#12305;&#65292;&#21457;&#20986;&#21435;&#30340;&#26159;<b>PDF&#25991;&#20214;</b>&#65307;&#22914;&#26524;&#20174;&#27963;&#21160;&#26412;&#24402;&#36864;&#20986;&#21457;&#23601;&#21464;&#25104;&#32593;&#39029;&#38142;&#25509;&#20102;&#12290;</div>';
  document.body.appendChild(div);
}

/* 图片版验收单：PDF预览/分享不可用时的终极兜底（图片长按即可转发） */
function exportImageVersion() {
  if (!window.__lastPdfImgData) { showToast("\u8bf7\u5148\u751f\u6210\u9a8c\u6536\u6587\u4ef6"); return; }
  var old = document.getElementById("imgPreviewModal");
  if (old) old.remove();
  var div = document.createElement("div");
  div.id = "imgPreviewModal";
  div.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999;display:flex;flex-direction:column;";
  div.innerHTML =
    '<div style="padding:10px 14px;background:#1e40af;color:#fff;display:flex;justify-content:space-between;align-items:center;">' +
    '<span style="font-size:.9rem;">&#128247; &#39537;&#25910;&#21333; &#22270;&#29255;&#29256;</span>' +
    '<button onclick="document.getElementById(\'imgPreviewModal\').remove()" style="background:none;border:none;color:#fff;font-size:1.1rem;padding:2px 8px;">&#10005;</button></div>' +
    '<div style="flex:1;overflow:auto;padding:8px;text-align:center;"><img src="' + window.__lastPdfImgData + '" style="max-width:100%;box-shadow:0 2px 12px rgba(0,0,0,.15);" /></div>' +
    '<div style="padding:10px 14px;background:#eef7f1;font-size:.75rem;color:#1d6b47;line-height:1.6;">' +
    '&#9989; <b>&#38271;&#25353;&#19978;&#26041;&#22270;&#29255; &#8594; &#21457;&#36865;&#32473;&#26379;&#21451;</b>&#65292;&#20219;&#20309;&#24494;&#20449;/&#20225;&#19994;&#24494;&#20449;&#37117;&#33021;&#36716;&#21457;&#22270;&#29255;&#65307;' +
    '&#9888;&#65039; &#22914;&#26524;&#20174;&#27963;&#21160;&#26412;&#21491;&#19978;&#35282;&#8220;&#8230;&#8221;&#36716;&#21457;&#65292;&#21457;&#20986;&#21435;&#30340;&#26159;&#32593;&#39029;&#38142;&#25509;&#65288;&#19981;&#26159&#25991;&#20214;&#65289;&#65292;&#35831;&#21152;&#36733;&#22270;&#29255;&#21518;&#20877;&#36716;&#21457;&#65307;' +
    '&#128203; &#22270;&#29255;&#29256;&#19982;PDF&#20869;&#23481;&#23436;&#20840;&#19968;&#33268;&#65292;&#21547;&#38450;&#20266;&#39564;&#35777;&#30721;&#12289;&#31614;&#31456;&#26639;&#19982;&#29031;&#29255;&#32034;&#24341;&#12290;</div>';
  document.body.appendChild(div);
}

function downloadPdf() {
  if (!pdfBlob) { showToast("\u8bf7\u5148\u751f\u6210"); return; }
  var fileName = "\u9a8c\u6536\u5355_" + (currentProject ? currentProject.name : "") + ".pdf";
  var url = URL.createObjectURL(pdfBlob);
  var ua = navigator.userAgent || "";
  var file = null;
  try { file = new File([pdfBlob], fileName, { type: "application/pdf" }); } catch (e) {}

  /* 企业微信：文件级分享优先（发出去=PDF文件），内嵌预览兜底 */
  if (isWeComUA()) {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: fileName }).then(function () {
        showToast("\u5df2\u6253\u5f00\u5206\u4eab\uff1a\u9009\u62e9\u4f1a\u8bdd\u5373\u53d1\u9001PDF\u6587\u4ef6", 3500);
      }).catch(function (e) {
        if (e && e.name === "AbortError") return;
        /* 小米等WebView PDF预览空白 → 直接图片版（长按转发万无一失） */
        exportImageVersion();
      });
    } else {
      /* 企微分享API不可用 → 直接图片版（PDF预览在部分WebView不渲染） */
      exportImageVersion();
    }
    showToast("\u4f01\u4e1a\u5fae\u4fe1\uff1a\u9884\u89c8\u9875\u53f3\u4e0a\u89d2 \u2026 \u2192 \u3010\u53d1\u9001\u7ed9\u670b\u53cb\u3011\u8f6c\u53d1\u6587\u4ef6\uff1b\u82e5\u9884\u89c8\u7a7a\u767d\u70b9\u3010\u8f6c\u56fe\u7247\u7248\u3011", 5000);
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    return;
  }

  if (/Android/i.test(ua)) {
    var win = null;
    try { win = window.open(url, "_blank"); } catch (e) {}
    if (!win) {
      var a = document.createElement("a");
      a.href = url; a.download = fileName;
      a.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;overflow:hidden";
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} }, 5000);
    }
  } else {
    var a2 = document.createElement("a");
    a2.href = url; a2.download = fileName; a2.style.display = "none";
    document.body.appendChild(a2); a2.click();
    setTimeout(function () { try { document.body.removeChild(a2); } catch (e) {} }, 5000);
  }
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  showToast("\u5df2\u6253\u5f00/\u4e0b\u8f7d");
}

function sharePdf() {
  if (!pdfBlob) { showToast("\u8bf7\u5148\u751f\u6210"); return; }
  /* 企业微信：直接走文件级分享/预览 */
  if (isWeComUA()) { downloadPdf(); return; }
  var fileName = "\u9a8c\u6536\u5355_" + (currentProject ? currentProject.name : "") + ".pdf";
  var file = new File([pdfBlob], fileName, { type: "application/pdf" });
  var ua = navigator.userAgent || "";
  var isWechat = /MicroMessenger/i.test(ua);

  if (isWechat) {
    showToast("\u5fae\u4fe1\u4e0d\u652f\u6301\u76f4\u63a5\u5206\u4eabPDF\uff0c\u8bf7\u70b9\u201c\u4e0b\u8f7dPDF\u201d\u540e\u5728\u5fae\u4fe1\u4e2d\u53d1\u9001", 4000);
    downloadPdf();
  } else if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ title: fileName, files: [file] }).catch(function (e) {
      if (e.name !== "AbortError") downloadPdf();
    });
  } else if (navigator.share) {
    navigator.share({ title: fileName }).catch(function () {});
  } else {
    downloadPdf();
  }
}

function closePdfPreview() { document.getElementById("pdfPreview").classList.remove("active"); }

/* ===================== UI 辅助 ===================== */
function showLoading(text) {
  document.getElementById("loadingText").textContent = text || "\u6b63\u5728\u5904\u7406...";
  document.getElementById("loadingOverlay").classList.add("active");
}
function hideLoading() { document.getElementById("loadingOverlay").classList.remove("active"); }

var toastTimer = null;
function showToast(message, duration) {
  var el = document.getElementById("toastBox");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove("visible"); }, duration || 2500);
}

/* ===================== 初始化 ===================== */
window.addEventListener("beforeunload", function () { autoSave(true); });
document.addEventListener("visibilitychange", function () { if (document.hidden) autoSave(true); });
document.addEventListener("focusin", function (e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")) {
    setTimeout(function () {
      try { e.target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (x) {}
    }, 350);
  }
});
initStorageGuard();
/* ★上报队列：启动/联网恢复时自动补发（顺序单发，失败退避重试） */
try { flushUploadQueue(); } catch (e) {}
window.addEventListener("load", function () { try { flushUploadQueue(); } catch (e) {} });
window.addEventListener("online", function () { try { flushUploadQueue(); } catch (e) {} });
/* App启动即预热定位（微信GPS慢，提前拿到） */
try {
  getLocation().then(function (loc) {
    if (loc) {
      try { localStorage.setItem("jf_last_addr", loc); } catch (e) {}
      window._camGeoCache = loc;
    }
  }).catch(function () {});
} catch (e) {}
/* ★App启动即预加载集团哈希索引（首次拍照就能本地比对） */
try { loadHashIndex(); } catch (e) {}
refreshHome();
console.log("=== v7.40 done ===");
