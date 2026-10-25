/**
 * JF智能费用验收 v6.0
 * 优化：变量可读性 / IndexedDB 连接缓存 / 错误处理 / 兼容性
 */
console.log("=== JF v6.0 ===");

/* ===================== 配置常量 ===================== */
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
var pdfBlob = null;
var viewerIndex = 0;
var viewerPhotos = [];
var isGalleryProcessing = false;
var dupImportCount = 0; /* 本批导入的疑似重复计数 */
var hashCheckPending = []; /* 集团查重进行中的请求（验收前必须全部完成） */
var deleteTargetKey = null;

/* ===================== 缓存的 IndexedDB 连接 ===================== */
var cachedDb = null;

/* ===================== 工具函数 ===================== */
function padZero(n) { return String(n).padStart(2, "0"); }

function escapeHtml(str) {
  var el = document.createElement("div");
  el.textContent = str;
  return el.innerHTML;
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
  deepseek: {
    name: "DeepSeek 视觉",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-v4-flash-vision-exp"
  },
  qwen: {
    name: "通义千问VL",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-vl-max-latest"
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
  return "你是物料验收助手。图中是现场验收照片。报价单条目名称：「" + item.displayName +
    "」，计价单位：" + (item.origUnit || "未注明") + "。" +
    "请完成三件事并只输出一个JSON对象，不要输出其他任何文字，格式：" +
    "{\"material\":\"识别到的物料\",\"qty\":数量数字或null,\"unit\":\"单位\",\"confidence\":\"high|medium|low\",\"match\":\"high|medium|low\",\"review\":\"15字内复核意见,无异常填空字符串\",\"note\":\"20字内判断依据\"}。" +
    "字段说明：qty=估算数量（无法确定填null）；confidence=数量置信度；" +
    "match=图中物料与条目名称的一致性（high=一致,medium=存疑,low=不一致）；" +
    "review=复核意见（如金额异常、图文不符、信息缺失等风险提示，无则空字符串）。";
}


function aiCount() {
  if (currentIndex < 0 || !currentProject) return;
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
  if (cfg.mode === "key") {
    aiCallDirect(cfg, photo, prompt);
  } else {
    aiCallProxy(cfg, photo, prompt);
  }
}

/* 平台代理模式：Key 托管在 EdgeOne 环境变量，团队共享，前端零密钥 */
function aiCallProxy(cfg, photo, prompt) {
  var proxyUrl = cfg.proxyUrl || "/api/ai-count";
  showLoading("AI 识别中…");
  fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: photo.dataUrl, prompt: prompt })
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

function parseAiCount(text) {
  try {
    var m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) { return null; }
}

function applyAiCount(result) {
  if (!result) { showToast("AI 返回内容无法解析，请重试"); return; }
  var item = currentProject.items[currentIndex];
  var qty = result.qty;
  var conf = String(result.confidence || "").toLowerCase();
  var match = String(result.match || "").toLowerCase();
  var review = String(result.review || "").trim();
  if (item) { item.aiMatch = match; item.aiReview = review; }
  var matchTxt = match === "high" ? "\u56fe\u6587\u4e00\u81f4" : (match === "medium" ? "\u56fe\u6587\u5b58\u7591" : (match === "low" ? "\u26a0 \u56fe\u6587\u4e0d\u7b26" : ""));
  var summary = "AI\u8bc6\u522b\uff1a" + (result.material || "?") +
    (qty !== null && qty !== undefined ? "\uff0c\u4f30\u6570 " + qty + (result.unit || "") : "\uff0c\u6570\u91cf\u65e0\u6cd5\u786e\u5b9a") +
    "\uff08\u7f6e\u4fe1\u5ea6 " + (conf || "?") + "\uff09";
  if (matchTxt) summary += "\uff0c" + matchTxt;
  var num = parseFloat(qty);
  if ((conf === "high" || conf === "medium") && qty !== null && qty !== undefined && isFinite(num)) {
    var qField = document.getElementById("inpAQ");
    qField.value = String(num);
    if (qField.dispatchEvent) qField.dispatchEvent(new Event("input", { bubbles: true }));
    summary += "\uff0c\u5df2\u9884\u586b\u8bf7\u6838\u5bf9";
  }
  if (review) summary += "\u3002\u590d\u6838\uff1a" + review;
  showToast(summary);
  saveProject();
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

/* 报价单导入时：同类物料报价单价入账 */
function recordPrices(items, source) {
  var rows = [];
  (items || []).forEach(function (it) {
    var p = parseFloat(it.origPrice);
    if (isFinite(p) && p > 0 && it.displayName) {
      rows.push({ name: it.displayName, unit: it.origUnit || "", price: p, source: source || "", date: new Date().toISOString().slice(0, 10) });
    }
  });
  if (!rows.length) return;
  getLedger("ledger_prices").then(function (arr) {
    saveLedger("ledger_prices", arr.concat(rows));
  });
  uploadPrices(rows);
}

/* 验收完成时：自动上传验收简报（数量/单价/总价） */
function recordAcceptBrief(item) {
  var rec = {
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toTimeString().slice(0, 5),
    acceptNo: currentProject.acceptNo || "",
    contractNo: currentProject.contractNo || "",
    project: currentProject.name || "",
    name: item.displayName,
    unit: item.origUnit || "",
    qty: item.acceptQty || "",
    price: item.acceptPrice || "",
    amount: item.acceptAmount || "",
    remark: item.remark || "",
    match: item.aiMatch || "",
    review: item.aiReview || ""
  };
  getLedger("ledger_accepts").then(function (arr) {
    arr.push(rec);
    saveLedger("ledger_accepts", arr);
  });
  sendBriefToWebhook(rec);
  uploadBrief(rec);
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

/* 中心上报：每单验收简报 / 报价基准 自动上传集团数据仓 */
function uploadBrief(rec) {
  try {
    fetch(DEFAULT_AI_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "report", record: rec })
    }).catch(function () {});
  } catch (e) {}
}

function uploadPrices(rows) {
  try {
    fetch(DEFAULT_AI_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prices", rows: rows })
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
    sel.innerHTML = months.map(function (m) { return '<option value="' + m + '">' + m + '</option>'; }).join("");
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

/* 集团照片哈希：上报 + 跨项目比对 */
function uploadPhotoHash(rec) {
  try {
    fetch(DEFAULT_AI_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "hashes", rows: [rec] })
    }).catch(function () {});
  } catch (e) {}
}

function checkHashGlobal(phash) {
  if (!phash) return;
  var req = fetch(DEFAULT_AI_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "checkHash", hashes: [phash] })
  }).then(function (res) { return res.json(); }).then(function (d) {
    markHashChecked(phash);
    if (!d || !d.matches || !d.matches.length || !currentProject) return;
    var m = d.matches[0];
    var label = (m.project || m.acceptNo || "\u96c6\u56e2") + (m.acceptNo ? "/" + m.acceptNo : "");
    var item = currentProject.items[currentIndex];
    if (!item) return;
    var changed = false;
    (item.photos || []).forEach(function (p) {
      if (p.hash === phash && !p.dupGlobal) {
        p.dupGlobal = 1;
        p.dupGlobalOf = "\u96c6\u56e2:" + label;
        p.duplicate = 1;
        p.dupOf = p.dupGlobalOf;
        changed = true;
      }
    });
    if (changed) {
      saveProject();
      renderPhotoGrid();
      showToast("\u26a0 \u6b64\u7167\u7247\u4e0e\u96c6\u56e2\u5176\u4ed6\u5355\u636e\u91cd\u590d\uff1a" + label + "\uff0c\u8bf7\u6838\u5b9e");
    }
  }).catch(function () { markHashChecked(phash); }).then(function () {
    var i2 = hashCheckPending.indexOf(req);
    if (i2 > -1) hashCheckPending.splice(i2, 1);
  });
  hashCheckPending.push(req);
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

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 99;
  var dist = 0;
  for (var i = 0; i < a.length; i++) {
    var x = (parseInt(a[i], 16) || 0) ^ (parseInt(b[i], 16) || 0);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

function findDuplicatePhoto(hash) {
  if (!hash || !currentProject) return null;
  for (var i = 0; i < currentProject.items.length; i++) {
    var it = currentProject.items[i];
    for (var j = 0; j < (it.photos || []).length; j++) {
      var h = it.photos[j].hash;
      if (h && hammingHex(h, hash) <= 8) return it.displayNum + "-" + (j + 1);
    }

  }
  return null;
}

function recomputeDupFlags() {
  if (!currentProject) return;
  var seen = [];
  currentProject.items.forEach(function (it) {
    (it.photos || []).forEach(function (p, j) {
      if (!p.hash) { p.duplicate = 0; p.dupOf = ""; return; }
      var dupLabel = null;
      for (var s2 = 0; s2 < seen.length; s2++) {
        if (hammingHex(seen[s2].hash, p.hash) <= 8) { dupLabel = seen[s2].label; break; }
      }
      if (dupLabel) { p.duplicate = 1; p.dupOf = dupLabel; }
      else if (p.dupGlobal) { p.duplicate = 1; p.dupOf = p.dupGlobalOf || "\u96c6\u56e2"; }
      else { p.duplicate = 0; p.dupOf = ""; }
      seen.push({ hash: p.hash, label: it.displayNum + "-" + (j + 1) });
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
  dbPut(currentProject.key, JSON.stringify(data)).catch(function (e) { console.error("saveProject:", e); });
  updateProjectIndex();
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
          }, 4500);
          fetch(DEFAULT_AI_PROXY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "geocode", lat: lat, lng: lng })
          }).then(function (res) { return res.json(); }).then(function (d) {
            if (settled) return;
            settled = true; clearTimeout(fallbackTimer);
            var addr = (d && d.address) ? String(d.address).trim() : "";
            if (addr) {
              try { localStorage.setItem(cacheKey, addr); } catch (e) {}
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
        function () { if (!done) { done = true; resolve(""); } },
        { timeout: 3000, maximumAge: 60000 }
      );
      setTimeout(function () { if (!done) { done = true; resolve(""); } }, 4000);
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
function autoSave() {
  if (currentIndex < 0 || !currentProject) return;
  syncFormToItem();
  saveProject();
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

function handleFileImport(e) {
  var file = e.target.files[0];
  if (!file) return;
  var ext = file.name.replace(/.*\./, "").toLowerCase();
  console.log("文件:", file.name, "大小:", file.size, "格式:", ext);

  if (ext === "pdf") { handlePdfImport(file); return; }
  if (typeof XLSX === "undefined") { showToast("表格解析库未加载，请刷新页面重试"); return; }

  if (ext === "csv") {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var wb = XLSX.read(ev.target.result, { type: "string" });
        parseWorkbook(wb, file.name);
      } catch (err) { showToast("CSV解析失败: " + err.message); }
    };
    reader.onerror = function () { showToast("文件读取失败"); };
    reader.readAsText(file, "utf-8");
  } else {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        console.log("ArrayBuffer读取完成, 大小:", ev.target.result.byteLength);
        var wb = XLSX.read(ev.target.result, { type: "array" });
        parseWorkbook(wb, file.name);
      } catch (err1) {
        console.warn("ArrayBuffer解析失败:", err1.message);
        tryParseAsText(file, file.name);
      }
    };
    reader.onerror = function () { showToast("文件读取失败"); };
    reader.readAsArrayBuffer(file);
  }
}

function tryParseAsText(file, fileName) {
  var reader = new FileReader();
  reader.onload = function (ev) {
    try {
      var wb = XLSX.read(ev.target.result, { type: "string", codepage: 65001 });
      parseWorkbook(wb, fileName);
    } catch (err) {
      console.warn("string模式也失败:", err.message);
      tryParseAsBase64(file, fileName);
    }
  };
  reader.readAsText(file, "utf-8");
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
      showToast("\u89e3\u6790\u5931\u8d25\uff0c\u8bf7\u5c1d\u8bd5\uff1a\n1. \u7528Excel/WPS\u6253\u5f00\u540e\u53e6\u5b58\u4e3a.xlsx\n2. \u6216\u5bfc\u51fa\u4e3aCSV\u683c\u5f0f\u91cd\u8bd5");
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

  var items = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row || !row.length) continue;
    var seqNum = row[0];
    if (seqNum === undefined || seqNum === null || seqNum === "") continue;
    seqNum = String(seqNum).trim();
    if (!/^\d+$/.test(seqNum)) continue;
    var name = String(row[1] || "").trim();
    if (!name) continue;
    items.push({
      sortKey: items.length, displayNum: String(items.length + 1), displayName: name,
      origQty: String(row[2] || ""), origUnit: String(row[3] || ""),
      origPrice: String(row[4] || ""), origAmount: String(row[5] || ""),
      quoteQty: String(row[2] || ""), quotePrice: String(row[4] || ""),
      acceptQty: "", acceptPrice: "", acceptAmount: "", remark: "",
      photos: [], accepted: false
    });
  }
  if (!items.length) { showToast("\u672a\u627e\u5230\u6709\u6548\u6570\u636e\uff08\u9700\u8981\u5e8f\u53f7\u5217+\u540d\u79f0\u5217\uff09"); return; }

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
  pendingImport = { name: name, items: items, contractNo: "", contractName: "", contractAmount: "", acceptNo: "" };
  document.getElementById("imName").value = name;
  document.getElementById("imContractNo").value = contractNoHint || "";
  document.getElementById("imContractName").value = "";
  document.getElementById("imContractAmount").value = "";
  document.getElementById("imCount").textContent = "识别到 " + items.length + " 项";
  var prev = items.slice(0, 5).map(function (it) {
    return "<div class='im-row'>" + escapeHtml(it.displayNum + ". " + it.displayName +
      "  |  " + (it.origQty || "-") + (it.origUnit || "") + " x " + (it.origPrice || "-") + " = " + (it.origAmount || "-")) + "</div>";
  }).join("");
  if (items.length > 5) prev += "<div class='im-row' style='opacity:.6'>… 其余 " + (items.length - 5) + " 项略</div>";
  document.getElementById("imPreview").innerHTML = prev;
  document.getElementById("importModal").classList.add("active");
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
  /* 验收单自动编号：有合同号 → {合同号}-YS-{序号}；无合同号 → YS-{全局序号}
     合同维度为下一阶段功能，现在留空不影响使用，数据结构已预留 */
  getIndex().then(function (idx) {
    var maxSeq = 0;
    idx.forEach(function (e) {
      if (cno && e.contractNo === cno) {
        var m = String(e.acceptNo || "").match(/-YS-(\d+)$/);
        if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10) || 0);
      } else if (!cno && !e.contractNo && e.acceptNo) {
        var m2 = String(e.acceptNo).match(/^YS-(\d+)$/);
        if (m2) maxSeq = Math.max(maxSeq, parseInt(m2[1], 10) || 0);
      }
    });
    pendingImport.acceptNo = (cno ? cno + "-YS-" : "YS-") + ("00" + (maxSeq + 1)).slice(-3);
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
        if (!res.ok) throw new Error("HTTP " + res.status);
        var t = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (t && Array.isArray(t)) t = t.map(function (c) { return c.text || ""; }).join("");
        return String(t || "");
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
    body: JSON.stringify({ image: image, prompt: prompt })
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        if (res.status === 404 && cfg.key) return direct();
        throw new Error((data && data.error) || ("HTTP " + res.status));
      }
      return String(data && data.content || "");
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
  var maxPages = Math.min(pdfDoc.numPages, 5);
  var allRows = [], pageNo = 0;

  var chain = Promise.resolve();
  for (var pn = 1; pn <= maxPages; pn++) {
    (function (n) {
      chain = chain.then(function () {
        pageNo = n;
        showLoading("AI识别扫描件 " + n + "/" + maxPages + "…");
        return pdfDoc.getPage(n).then(function (page) {
          var viewport = page.getViewport({ scale: 1.5 });
          var canvas = document.createElement("canvas");
          canvas.width = viewport.width; canvas.height = viewport.height;
          var ctx = canvas.getContext("2d");
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
            var dataUrl = canvas.toDataURL("image/jpeg", 0.82);
            var prompt = "这是报价单扫描件的第" + n + "页。请提取其中的报价明细表格，只输出一个JSON对象，不要输出其他任何文字，格式：" +
              '{"title":"标题(无则空字符串)","contractNo":"合同编号(无则空字符串)","items":[{"name":"名称","qty":"数量","unit":"单位","price":"单价","amount":"金额"}]}。' +
              "要求：只提取明细数据行，不含表头和合计；数字去掉千分位逗号和货币符号；没有的字段填空字符串。";
            return aiFetchText(dataUrl, prompt);
          });
        }).then(function (text) {
          var parsed = parseAiOcr(text);
          if (parsed) allRows.push(parsed);
        }).catch(function (e) {
          console.error("扫描件识别失败(第" + n + "页):", e);
        });
      });
    })(pn);
  }

  chain.then(function () {
    hideLoading();
    var items = [], title = "", contractNo = "";
    allRows.forEach(function (pg) {
      if (!title && pg.title) title = String(pg.title).trim();
      if (!contractNo && pg.contractNo) contractNo = String(pg.contractNo).trim();
      (pg.items || []).forEach(function (r) {
        var name = String(r.name || "").trim();
        if (!name) return;
        items.push(makeQuoteItem(items.length, name, r.qty || "", r.unit || "", r.price || "", r.amount || ""));
      });
    });
    if (!items.length) {
      showToast("AI未能从扫描件中识别出报价明细\n请确认图片清晰，或改用Excel导入");
      return;
    }
    showImportConfirm(title || fileName.replace(/\.[^.]+$/, ""), items, contractNo);
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
      items.push(makeQuoteItem(items.length, name, qty, unit, price, amount));
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
    items.push(makeQuoteItem(items.length, name, vals.qty || "", vals.unit || "", vals.price || "", vals.amount || ""));
  }
  return { title: title, items: items };
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
      html += '<div class="project-card" onclick="openProject(\'' + entry.key + '\')">' +
        '<div class="project-card-header">' +
          '<div class="project-card-name">' + escapeHtml(entry.name) + '</div>' +
          '<button class="project-card-delete" onclick="event.stopPropagation();confirmDelete(\'' + entry.key + '\',\'' + escapeHtml(entry.name).replace(/'/g, "\\'") + '\')">&#215;</button>' +
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
  document.getElementById("topTitle").textContent = "JF\u8d39\u7528\u667a\u80fd\u9a8c\u6536";
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
  document.getElementById("topTitle").textContent = "\u9a8c\u6536\u5b8c\u6210";
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
        '<div class="item-meta">\u62a5\u4ef7:' + item.origQty + (item.origUnit || '') + ' x \u00a5' + item.origPrice +
        (item.acceptAmount ? ' \u00b7 \u9a8c\u6536:\u00a5' + item.acceptAmount : '') +
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
  document.getElementById("quoteTitle").textContent = "\ud83d\udccb \u62a5\u4ef7\u4fe1\u606f - " + item.displayName;
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
  item.origQty = document.getElementById("inpOQ").value || item.origQty;
  item.origPrice = document.getElementById("inpOP").value || item.origPrice;
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
  if (hashCheckPending.length) {
    showLoading("\u9632\u4f2a\u6821\u9a8c\u4e2d\u2026\u8bf7\u7a0d\u5019");
    whenHashChecksDone().then(function () {
      hideLoading();
      doSaveAccept();
    });
    return;
  }
  doSaveAccept();
}

function doSaveAccept() {
  if (currentIndex < 0 || !currentProject) return;
  syncFormToItem();
  var item = currentProject.items[currentIndex];

  if (!item.acceptQty || !item.acceptPrice) {
    showToast("\u8bf7\u586b\u5199\u9a8c\u6536\u6570\u91cf\u548c\u9a8c\u6536\u5355\u4ef7");
    return;
  }
  /* 疑似重复照片不允许验收 */
  var dupPhotos = (item.photos || []).filter(function (p) { return p.duplicate; });
  if (dupPhotos.length) {
    showToast("\u5b58\u5728 " + dupPhotos.length + " \u5f20\u7591\u4f3c\u91cd\u590d\u7167\u7247\uff0c\u8bf7\u5220\u9664\u540e\u518d\u9a8c\u6536");
    return;
  }

  var acceptQty = parseFloat(item.acceptQty) || 0;
  var acceptAmt = parseFloat(item.acceptAmount) || 0;
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
  if (Math.abs(aa - calculated) > 0.01) {
    if (!item.remark || !item.remark.trim()) {
      showToast("\u91d1\u989d\u4e0d\u4e00\u81f4\uff0c\u8bf7\u586b\u5907\u6ce8");
      document.getElementById("inpR").focus();
      document.getElementById("inpR").style.borderColor = "#c05050";
      return;
    }
  }

  item.accepted = true;
  saveProject();
  recordAcceptBrief(item);
  renderItemList();
  showToast("\u9a8c\u6536\u5df2\u4fdd\u5b58");
  closeDetail();
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
      '<img src="' + (photo.dataUrl || "") + '" onerror="this.style.opacity=0.3">' +
      '<button class="photo-delete" onclick="event.stopPropagation();deletePhoto(' + i + ')">\u2715</button>' +
      (photo.duplicate ?
        '<div class="photo-dup">\u26a0 \u7591\u4f3c\u91cd\u590d</div>' :
        '<div class="photo-info">' + formatTimestamp(photo.date || "") + '</div>');
    (function (idx) { div.onclick = function () { openViewer(idx); }; })(i);
    grid.appendChild(div);
  }
}

function deletePhoto(idx) {
  if (currentIndex < 0 || !currentProject) return;
  var item = currentProject.items[currentIndex];
  var oldCount = item.photos.length;
  item.photos.splice(idx, 1);
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

    addPhoto(canvas).then(function () {
      if (currentIndex >= 0 && currentProject && currentProject.items[currentIndex]) {
        document.getElementById("camInfo").textContent =
          currentProject.items[currentIndex].displayName + " (" + currentProject.items[currentIndex].photos.length + "\u5f20)";
      }
    }).catch(function () {});
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

function onGallerySelect(e) {
  var files = e.target.files;
  if (!files || !files.length) return;
  isGalleryProcessing = true;
  dupImportCount = 0;
  var fileArray = [];
  for (var i = 0; i < files.length; i++) fileArray.push(files[i]);

  showToast("\u5904\u7406 " + fileArray.length + " \u5f20...");
  var addedCount = 0, errorCount = 0;

  function processNext(idx) {
    if (idx >= fileArray.length) {
      isGalleryProcessing = false;
      showToast(addedCount > 0 ? "\u5df2\u6dfb\u52a0 " + addedCount + " \u5f20" + (dupImportCount ? "\uff0c\u26a0 " + dupImportCount + " \u5f20\u7591\u4f3c\u91cd\u590d\uff0c\u8bf7\u67e5\u770b\u7ea2\u8272\u89d2\u6807" : "") + (errorCount ? " (" + errorCount + "\u5931\u8d25)" : "") : "\u5904\u7406\u5931\u8d25");
      return;
    }
    fileToCanvas(fileArray[idx]).then(function (canvas) {
      return addPhoto(canvas);
    }).then(function () { addedCount++; })
      .catch(function () { errorCount++; })
      .then(function () { processNext(idx + 1); });
  }
  processNext(0);
}

/* ===================== 保存照片 ===================== */
function addPhoto(sourceCanvas) {
  return new Promise(function (resolve, reject) {
    if (currentIndex < 0 || !currentProject || !currentProject.items[currentIndex]) {
      showToast("\u672a\u6253\u5f00\u9879");
      reject(new Error("No item selected"));
      return;
    }
    try {
      var max = IMG_MAX_SIZE, w = sourceCanvas.width, h = sourceCanvas.height;
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

      var now = new Date();
      var dateStr = now.getFullYear() + "-" + padZero(now.getMonth() + 1) + "-" + padZero(now.getDate()) +
        " " + padZero(now.getHours()) + ":" + padZero(now.getMinutes()) + ":" + padZero(now.getSeconds());

      getLocation().then(function (loc) {
        savePhotoData(canvas, dateStr, loc, resolve, reject);
      }).catch(function () {
        savePhotoData(canvas, dateStr, "", resolve, reject);
      });
    } catch (e) { showToast("\u7167\u7247\u5931\u8d25"); reject(e); }
  });
}

function savePhotoData(canvas, dateStr, location, resolve, reject) {
  try {
    applyWatermark(canvas, dateStr, location);
    var dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    if (!dataUrl || dataUrl.indexOf("data:image/jpeg;base64,") !== 0 || dataUrl.length < 500) {
      showToast("\u7167\u7247\u751f\u6210\u5931\u8d25");
      reject(new Error("Invalid data URL"));
      return;
    }
    var item = currentProject.items[currentIndex];
    var photoIdx = item.photos.length;
    var phash = perceptualHash(canvas);
    var dup = findDuplicatePhoto(phash);
    checkHashGlobal(phash);
    uploadPhotoHash({ hash: phash, date: dateStr, acceptNo: currentProject.acceptNo || "", project: currentProject.name || "", name: item.displayName, idx: photoIdx });
    if (dup) dupImportCount++;
    item.photos.push({ dataUrl: dataUrl, date: dateStr, location: location, hash: phash, duplicate: dup ? 1 : 0, dupOf: dup || "" });
    if (dup) showToast("\u26a0 \u7591\u4f3c\u4e0e [" + dup + "] \u7167\u7247\u91cd\u590d\uff0c\u8bf7\u786e\u8ba4\u662f\u5426\u91cd\u590d\u7528\u56fe");
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
  html += '<div style="text-align:center;margin-bottom:20px;padding-bottom:10px;border-bottom:0.5pt solid #888;">' +
    '<div style="font-size:22px;font-weight:900;letter-spacing:3px;">' + escapeForPdf(title) + '</div></div>';
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
        '<img src="' + p.dataUrl + '" style="display:block;max-width:100px;max-height:68px;object-fit:contain;border:0.25px solid #bbb;" />' +
        '<div style="font-size:7px;color:#555;margin-top:1px;line-height:1.2;max-width:100px;overflow:hidden;">' + escapeForPdf(formatTimestamp(p.date)) + '</div></div>';
    }
    var tdStyle = 'border:' + border + ';padding:6px 8px;text-align:center;color:#000;';
    html += '<tr>' +
      '<td style="' + tdStyle + 'font-weight:600;">' + item.displayNum + '</td>' +
      '<td style="' + tdStyle + 'text-align:left;font-size:11.5px;line-height:1.4;">' + escapeForPdf(item.displayName) + '</td>' +
      '<td style="' + tdStyle + '">' + (item.acceptQty || '-') + '</td>' +
      '<td style="' + tdStyle + '">' + escapeForPdf(item.origUnit || '-') + '</td>' +
      '<td style="' + tdStyle + '">' + (item.acceptPrice ? Number(item.acceptPrice).toLocaleString('zh') : '-') + '</td>' +
      '<td style="' + tdStyle + 'font-weight:600;">' + (item.acceptAmount ? Number(item.acceptAmount).toLocaleString('zh', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-') + '</td>' +
      '<td style="border:' + border + ';padding:4px 6px;line-height:0;text-align:left;">' + (photoHtml || '<span style="font-size:11px;color:#aaa;line-height:1;">-</span>') + '</td>' +
      '<td style="' + tdStyle + 'text-align:left;font-size:11px;line-height:1.4;">' + escapeForPdf(item.remark || '') +
        (item.aiReview ? '<div style="margin-top:3px;font-size:9.5px;color:#444;">AI\u590d\u6838\uff1a' + escapeForPdf(item.aiReview) + '</div>' : '') + '</td></tr>';
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
function downloadPdf() {
  if (!pdfBlob) { showToast("\u8bf7\u5148\u751f\u6210"); return; }
  var fileName = "\u9a8c\u6536\u5355_" + (currentProject ? currentProject.name : "") + ".pdf";
  var url = URL.createObjectURL(pdfBlob);
  var ua = navigator.userAgent || "";

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
    var a = document.createElement("a");
    a.href = url; a.download = fileName; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} }, 5000);
  }
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  showToast("\u5df2\u6253\u5f00/\u4e0b\u8f7d");
}

function sharePdf() {
  if (!pdfBlob) { showToast("\u8bf7\u5148\u751f\u6210"); return; }
  var fileName = "\u9a8c\u6536\u5355_" + (currentProject ? currentProject.name : "") + ".pdf";
  var file = new File([pdfBlob], fileName, { type: "application/pdf" });
  var ua = navigator.userAgent || "";
  var isWechat = /MicroMessenger/i.test(ua);

  if (isWechat) {
    /* \u5fae\u4fe1\u5185\u7f6e\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u6587\u4ef6\u5206\u4eab\uff0c\u63d0\u793a\u7528\u6237\u4e0b\u8f7d\u540e\u5728\u5fae\u4fe1\u4e2d\u53d1\u9001 */
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
function showToast(message) {
  var el = document.getElementById("toastBox");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove("visible"); }, 2500);
}

/* ===================== 初始化 ===================== */
window.addEventListener("beforeunload", function () { autoSave(); });
document.addEventListener("visibilitychange", function () { if (document.hidden) autoSave(); });
document.addEventListener("focusin", function (e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")) {
    setTimeout(function () {
      try { e.target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (x) {}
    }, 350);
  }
});
initStorageGuard();
refreshHome();
console.log("=== v6.2.1 done ===");
