'use strict';
/**
 * 腾讯云 SCF：采购智验 中心服务 v2（全国内链路版）
 * ----------------------------------------------------------
 * 功能：
 *   1) AI 点数代理：POST { image, prompt } → { content }
 *   2) 验收简报上报：POST { action:"report", record:{...} }
 *   3) 报价基准上报：POST { action:"prices", rows:[...] }
 *   4) 月度汇总查询：POST { action:"summary", month, token }
 *   5) GET 访问 → 直接返回【集团月度看板】页面（口令登录）
 *
 * 数据存储：Gitee 私有仓库（国内链路，GitHub 零依赖）
 *   reports/2026-10/xxx.json   每单一个文件
 *   prices/xxx.json            报价单价基准
 *
 * 环境变量：
 *   AI_API_KEY      = *** Gitee 私人令牌（projects 权限）
 *   GITEE_REPO      = JFACCPTANCE/acceptance-data（私有数据仓）
 *   DASHBOARD_TOKEN = ***
 */

const GITEE_API = 'https://gitee.com/api/v5';
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>采购智验 · 集团月度看板</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:"PingFang SC","Microsoft YaHei",sans-serif; background:#eaf1f9; color:#1f2d3d; min-height:100vh; }
.wrap { max-width:1080px; margin:0 auto; padding:20px 16px 40px; }
h1 { font-size:1.35rem; font-weight:800; color:#1f2d3d; text-align:center; margin:8px 0 2px; }
.sub { text-align:center; color:#7c8ba1; font-size:.8rem; margin-bottom:18px; }
.login { max-width:360px; margin:80px auto; background:#fff; border-radius:14px; padding:28px 22px; box-shadow:0 4px 18px rgba(37,99,235,.08); }
.login input { width:100%; padding:11px 12px; border:1px solid rgba(37,99,235,.2); border-radius:8px; font-size:.95rem; margin:10px 0 16px; }
.login button, .bar button { width:100%; padding:12px; border:none; border-radius:10px; background:#2563eb; color:#fff; font-size:.95rem; font-weight:600; cursor:pointer; }
.bar { display:flex; gap:10px; align-items:center; margin-bottom:16px; flex-wrap:wrap; }
.bar select { padding:9px 12px; border:1px solid rgba(37,99,235,.2); border-radius:8px; font-size:.9rem; background:#fff; }
.bar button { width:auto; padding:9px 18px; font-size:.85rem; background:#f59e0b; }
.kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:18px; }
.kpi { background:#fff; border-radius:12px; padding:16px 12px; text-align:center; box-shadow:0 2px 10px rgba(37,99,235,.06); }
.kpi .v { font-size:1.5rem; font-weight:800; color:#2563eb; }
.kpi .v.warn { color:#e5484d; }
.kpi .l { font-size:.72rem; color:#7c8ba1; margin-top:4px; }
.panel { background:#fff; border-radius:12px; padding:16px; box-shadow:0 2px 10px rgba(37,99,235,.06); margin-bottom:16px; }
.panel h2 { font-size:.95rem; color:#1f2d3d; margin-bottom:12px; }
table { width:100%; border-collapse:collapse; font-size:.8rem; }
th { background:#eef4fb; color:#5b6b7f; padding:8px 6px; font-weight:600; white-space:nowrap; }
td { padding:8px 6px; border-bottom:1px solid #eef2f7; text-align:center; }
td.name { text-align:left; }
.up { color:#e5484d; font-weight:700; }
.down { color:#22a06b; font-weight:700; }
.bar-row { display:flex; align-items:center; gap:8px; margin:6px 0; font-size:.75rem; }
.bar-row .lbl { width:110px; text-align:right; color:#5b6b7f; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bar-row .track { flex:1; background:#eef4fb; border-radius:4px; height:14px; overflow:hidden; }
.bar-row .fill { height:100%; background:linear-gradient(90deg,#2563eb,#4f8ef7); border-radius:4px; }
.bar-row .val { width:72px; color:#1f2d3d; }
.empty { text-align:center; color:#8a99ab; padding:30px 0; font-size:.85rem; }
.footer-note { text-align:center; color:#9fb0c2; font-size:.68rem; margin-top:20px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>采购智验 · 集团月度看板</h1>
  <p class="sub">全集团验收数据自动汇总 · 报价基准智能比对</p>

  <div class="login" id="loginBox">
    <h2 style="font-size:1rem;margin-bottom:4px;">访问验证</h2>
    <p style="font-size:.75rem;color:#7c8ba1;">请输入看板口令</p>
    <input type="password" id="tokenInput" placeholder="看板口令">
    <button onclick="doLogin()">进入看板</button>
  </div>

  <div id="mainBox" style="display:none;">
    <div class="bar">
      <select id="monthSel" onchange="loadData()"></select>
      <button onclick="loadData()">刷新</button>
    </div>
    <div class="kpis">
      <div class="kpi kpi-amount"><div class="l">验收总金额</div><div class="v" id="kpiAmount">-</div></div>
      <div class="kpi kpi-warn" onclick="jumpAll()"><div class="v" id="kpiCount">-</div><div class="l">验收单数▸看全部</div></div>
      <div class="kpi"><div class="v" id="kpiMaterial">-</div><div class="l">物料种类</div></div>
      <div class="kpi kpi-warn" onclick="jumpWarn()"><div class="v warn" id="kpiWarn">-</div><div class="l">价格异常▸点击筛选</div></div>
    </div>
    <div class="panel">
      <h2>物料验收金额 TOP 10</h2>
      <div id="chartBox"><div class="empty">加载中…</div></div>
    </div>
    <div class="panel" id="tablePanel">
      <h2>报价基准比对（单内比对 · 差异 ≥ ±5% 标注）<span id="filterTip" style="font-size:.7rem;color:#e5484d;font-weight:400;"></span></h2>
      <div id="tableBox"><div class="empty">加载中…</div></div>
    </div>
    <p class="footer-note">数据来源：各项目经办人验收简报自动上报 · 更新于 <span id="updateTime">-</span></p>
  </div>
</div>

<script>
var API_URL = "https://1514325591-klg147a60r.ap-guangzhou.tencentscf.com";

function getToken() {
  try { return sessionStorage.getItem("jf_dash_token") || ""; } catch (e) { return ""; }
}

function doLogin() {
  var t = document.getElementById("tokenInput").value.trim();
  if (!t) { alert("请输入口令"); return; }
  try { sessionStorage.setItem("jf_dash_token", t); } catch (e) {}
  showMain();
  initMonths();
  loadData();
}

function showMain() {
  document.getElementById("loginBox").style.display = "none";
  document.getElementById("mainBox").style.display = "";
}

function initMonths() {
  var now = new Date();
  var sel = document.getElementById("monthSel");
  var opts = "";
  for (var i = 0; i < 6; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var m = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2);
    opts += '<option value="' + m + '">' + m + '</option>';
  }
  sel.innerHTML = opts;
}

function loadData(keepFilter) {
  if (!keepFilter) warnOnly = warnOnly;
  var month = document.getElementById("monthSel").value;
  document.getElementById("chartBox").innerHTML = '<div class="empty">加载中…</div>';
  document.getElementById("tableBox").innerHTML = '<div class="empty">加载中…</div>';
  fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "summary", month: month, token: getToken() })
  }).then(function (res) { return res.json(); }).then(function (data) {
    if (data.error) {
      document.getElementById("chartBox").innerHTML = '<div class="empty">' + data.error + '</div>';
      document.getElementById("tableBox").innerHTML = '';
      return;
    }
    render(data);
  }).catch(function (e) {
    document.getElementById("chartBox").innerHTML = '<div class="empty">加载失败：' + e.message + '</div>';
  });
}

var warnOnly = false;

function jumpWarn() {
  warnOnly = true;
  render();
  var el = document.getElementById("tablePanel");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function jumpAll() {
  warnOnly = false;
  render();
}

function render(data) {
  if (data === undefined) { loadData(true); return; }
  var k = data.kpi || {};
  document.getElementById("kpiAmount").textContent = fmtMoney(k.totalAmount || 0);
  document.getElementById("kpiCount").textContent = k.totalCount || 0;
  document.getElementById("kpiMaterial").textContent = k.materialCount || 0;
  document.getElementById("kpiWarn").textContent = k.warnCount || 0;
  document.getElementById("updateTime").textContent = new Date().toLocaleString("zh");

  var allRows = data.rows || [];
  var rows = warnOnly ? allRows.filter(function (g) { return g.diffPct !== null && Math.abs(g.diffPct) >= 5; }) : allRows;
  var tip = document.getElementById("filterTip");
  if (tip) tip.textContent = warnOnly ? "　（仅显示异常项，点「验收单数」看全部）" : "";
  /* 金额条形图 TOP10（按金额从大到小排序） */
  var top = rows.slice().sort(function (x, y) { return (y.amountSum || 0) - (x.amountSum || 0); }).slice(0, 10);
  var max = 1;
  top.forEach(function (g) { if (g.amountSum > max) max = g.amountSum; });
  var chart = top.map(function (g) {
    return '<div class="bar-row"><div class="lbl">' + esc(g.name) + '</div>' +
      '<div class="track"><div class="fill" style="width:' + Math.max(2, g.amountSum / max * 100) + '%"></div></div>' +
      '<div class="val">' + fmtMoney(g.amountSum) + '</div></div>';
  }).join("");
  document.getElementById("chartBox").innerHTML = chart || '<div class="empty">暂无数据</div>';

  /* 比对表 */
  var table = '<table><tr><th style="width:38%">物料</th><th>基准</th><th>均价</th><th>差异</th><th>次数·金额</th></tr>';
  rows.forEach(function (g) {
    var diff = "—", cls = "";
    if (g.diffPct !== null && isFinite(g.diffPct)) {
      diff = (g.diffPct > 0 ? "+" : "") + g.diffPct.toFixed(1) + "%";
      cls = Math.abs(g.diffPct) >= 5 ? (g.diffPct > 0 ? "up" : "down") : "";
    }
    var warn = (g.reviews && g.reviews.length) ? '<span style="color:#e5484d;">⚠</span> ' : '';
    table += '<tr><td class="name" title="' + esc(g.name) + '">' + warn + esc(g.name) + '</td>' +
      '<td>' + (g.basePrice ? g.basePrice.toFixed(2) : ((g.baseList && g.baseList.length) ? esc(g.baseList.map(function (x) { return Number(x).toFixed(2); }).join("/")) + '<span style="font-size:.62rem;color:#8a99ab" title="多报价源：各笔验收按各自报价单基准比对，不互扰">·多源</span>' : "—")) + '</td>' +
      '<td>' + (g.avgAcceptPrice ? g.avgAcceptPrice.toFixed(2) : "—") + '</td>' +
      '<td class="' + cls + '">' + diff + '</td>' +
      '<td>' + g.count + '次·' + fmtMoney(g.amountSum) + '</td></tr>';
  });
  table += "</table>";
  document.getElementById("tableBox").innerHTML = rows.length ? table : '<div class="empty">' + (warnOnly ? '本月无价格异常项 ✓' : '本月暂无验收数据') + '</div>';
}

function fmtMoney(v) {
  v = Number(v) || 0;
  return v >= 10000 ? (v / 10000).toFixed(2) + "万" : v.toLocaleString("zh");
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 已有口令则直接进入 */
window.addEventListener("load", function () {
  if (getToken()) { showMain(); initMonths(); loadData(); }
});
</script>
<style>
/* ===== 布局修正(覆盖式)：金额独条一行 + 三指标一行 + 整体压缩 ===== */
.kpis { grid-template-columns: repeat(3, 1fr) !important; gap: 8px !important; margin-bottom: 14px !important; }
.kpi { padding: 7px 6px !important; }
.kpi .v { font-size: 1.08rem !important; }
.kpi .l { font-size: .66rem !important; }
.kpi-amount { grid-column: 1 / -1; display: flex !important; justify-content: space-between; align-items: center; padding: 8px 14px !important; text-align: left !important; }
.kpi-amount .v { font-size: 1.45rem !important; }
.kpi-amount .l { font-size: .72rem !important; }
</style>
</body>
</html>
`;

function json(obj, status) {
  return {
    statusCode: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type'
    },
    body: JSON.stringify(obj)
  };
}

function html(body) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'inline; filename="dashboard.html"'
    },
    body: body
  };
}

function giteeBase() {
  return GITEE_API + '/repos/' + (process.env.GITEE_REPO || '');
}

async function giteePut(path, data) {
  const res = await fetch(giteeBase() + '/contents/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: process.env.GITEE_TOKEN || '',
      content: Buffer.from(JSON.stringify(data)).toString('base64'),
      message: 'report ' + path
    })
  });
  return res.ok;
}

async function giteeList(path) {
  const res = await fetch(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''));
  if (!res.ok) return [];
  const arr = await res.json();
  return Array.isArray(arr) ? arr : [];
}

async function giteeGet(path) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const d = await res.json();
    try { return JSON.parse(Buffer.from(d.content || '', 'base64').toString('utf8')); } catch (e) { return null; }
  } catch (e) { return null; }
}

/* ---------- AI 点数 ---------- */
function cleanKey(raw) {
  /* 容错清洗：自动去除误粘贴的前缀/引号/空白 */
  return String(raw || '')
    .replace(/^AI_API_KEY\s*=\s*/, '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
}

async function aiCount(body) {
  /* ★双模型路由：model=qwen → 千问视觉（点数快准）；默认 → MiMo（OCR强） */
  const useQwen = body && body.model === 'qwen';
  const key = cleanKey(useQwen ? process.env.QWEN_API_KEY : process.env.AI_API_KEY);
  if (!key) return json({ error: useQwen ? 'QWEN_API_KEY 未配置' : 'AI_API_KEY 未配置' }, 500);
  const prompt = body && body.prompt;
  const images = Array.isArray(body.images) && body.images.length
    ? body.images.slice(0, 6)
    : (body.image ? [body.image] : []);
  if (!images.length || !prompt) return json({ error: '请求参数缺失（需要 image/images 和 prompt）' }, 400);
  if (images.some(i => String(i).length > 8 * 1024 * 1024)) return json({ error: '图片过大（单张超过8MB）' }, 413);
  let baseUrl, reqBody;
  if (useQwen) {
    baseUrl = 'https://ws-7lagrr2kknu4z2rs.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
    reqBody = {
      model: 'qwen3-vl-plus',
      messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt).slice(0, 2000) }].concat(images.map(i => ({ type: 'image_url', image_url: { url: i } }))) }],
      max_tokens: 2048
    };
  } else {
    baseUrl = process.env.AI_BASE_URL || 'https://api.xiaomimimo.com/v1/chat/completions';
    reqBody = {
      model: process.env.AI_MODEL || 'mimo-v2.6-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt).slice(0, 2000) }].concat(images.map(i => ({ type: 'image_url', image_url: { url: i } }))) }],
      max_tokens: 4096
    };
    reqBody.thinking = { type: 'disabled' };
  }
  const upstream = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '  + key },
    body: JSON.stringify(reqBody)
  });
  if (!upstream.ok) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 300); } catch (e) {}
    let msg = '上游模型服务错误 ' + upstream.status;
    if (upstream.status === 401) msg = 'AI_API_KEY 无效/已禁用/已过期';
    else if (upstream.status === 402) msg = 'API 余额或资源包不足';
    else if (upstream.status === 429) msg = 'AI 服务繁忙，请稍后再试';
    console.error('[AI上游错误]', upstream.status, detail);
    /* Key格式指纹（不含任何Key字符）：定位环境变量问题 vs 平台侧问题 */
    const keyInfo = {
      len: key.length,
      startsWithSk: key.indexOf('sk-') === 0,
      hasWhitespace: /\s/.test(key),
      hasEqOrPrefix: key.indexOf('=') > -1 || key.indexOf('AI_API_KEY') > -1,
      head3: key.slice(0, 3)
    };
    return json({ error: msg, detail: detail, keyInfo: keyInfo }, 502);
  }
  const data = await upstream.json();
  let content = '';
  if (useQwen) {
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    content = msg && msg.content;
    if (Array.isArray(content)) content = content.map(c => (c && (c.text || c.content)) || '').join('');
  } else {
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    content = msg && msg.content;
    if (Array.isArray(content)) content = content.map(c => (c && (c.text || c.content)) || '').join('');
    if ((!content || !String(content).trim()) && msg && msg.reasoning_content) content = msg.reasoning_content;
  }
  if (!content) return json({ error: '模型返回为空' }, 502);
  return json({ content: content });
}



/* ---------- 逆地理编码：坐标→具体地址 ---------- */
async function geocode(lat, lng) {
  const la = parseFloat(lat), ln = parseFloat(lng);
  if (!isFinite(la) || !isFinite(ln)) return json({ error: '坐标无效' }, 400);
  /* 优先高德（需 AMAP_KEY 环境变量，国内地址最准） */
  if (process.env.AMAP_KEY) {
    try {
      const res = await fetch('https://restapi.amap.com/v3/geocode/regeo?location=' + ln + ',' + la +
        '&key=' + encodeURIComponent(process.env.AMAP_KEY) + '&extensions=base&radius=300');
      const d = await res.json();
      const addr = d && d.regeocode && d.regeocode.formatted_address;
      if (addr && addr !== '[]' && String(addr).length > 2) return json({ address: String(addr), source: 'amap' });
    } catch (e) {}
  }
  /* 兜底：开放地图服务（免Key） */
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + la + '&lon=' + ln +
      '&format=json&zoom=18&accept-language=zh', {
      headers: { 'User-Agent': 'jf-acceptance/1.0' }
    });
    const d = await res.json();
    const addr = d && d.display_name;
    if (addr) return json({ address: String(addr), source: 'osm' });
  } catch (e) {}
  return json({ address: '' });
}

/* ---------- 集团照片哈希库（跨项目查重） ---------- */
function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 99;
  var dist = 0;
  for (var i = 0; i < a.length; i++) {
    var x = (parseInt(a[i], 16) || 0) ^ (parseInt(b[i], 16) || 0);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

async function uploadHashes(rows) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ok = await giteePut('hashes/' + id + '.json', rows || []);
  if (ok && Array.isArray(rows)) {
    if (hashCache.rows.length) {
      hashCache.rows.push.apply(hashCache.rows, rows); /* 新指纹即时入缓存 */
    }
    hashCache.ts = Date.now();
    /* 同步更新索引文件（单文件读写，查重1次请求搞定） */
    if (hashCache.rows.length) {
      giteePut('hashes-index.json', hashCache.rows).catch(() => {});
    }
  }
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

/* 哈希库内存缓存：45秒内多张照片批量比对只拉一次全库 */
let hashCache = { ts: 0, rows: [] };

async function loadHashRows() {
  const now = Date.now();
  if (hashCache.rows.length && now - hashCache.ts < 300000) return hashCache.rows;
  /* 优先读单一索引文件（1次请求），没有才回退逐文件扫描（兼容旧数据） */
  const idx = await giteeGet('hashes-index.json');
  if (Array.isArray(idx) && idx.length) {
    hashCache = { ts: now, rows: idx };
    return idx;
  }
  const files = (await giteeList('hashes')).filter(f => f.name && f.name.endsWith('.json'));
  const results = await Promise.all(files.map(f => giteeGet('hashes/' + f.name)));
  const rows = [];
  results.forEach(r => { if (Array.isArray(r)) rows.push.apply(rows, r); });
  hashCache = { ts: now, rows: rows };
  /* 回写索引文件，下次1次请求搞定 */
  giteePut('hashes-index.json', rows).catch(() => {});
  return rows;
}

async function checkHash(hashes) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);
  const rows = await loadHashRows();
  const matches = [];
  for (const r of rows) {
    for (const h of (hashes || [])) {
      if (r.hash && h) {
        const d = hammingHex(String(r.hash), String(h));
        if (d <= 8) {
          matches.push({ hash: r.hash, date: r.date || '', acceptNo: r.acceptNo || '', project: r.project || '', name: r.name || '', idx: r.idx, dist: d, hard: d <= 4 });
        }
      }
    }
    if (matches.length > 20) break;
  }
  return json({ matches: matches });
}

/* ---------- 简报/基准上报 ---------- */
/* ---------- 匿名使用统计（轻量计数器） ---------- */
async function usageTrack(body) {
  /* body: { action:'usage', deviceId:'xxx', type:'photo|accept|ai' } */
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ ok: true });
  try {
    const stats = await giteeGet('usage-stats.json');
    const s = stats || { devices: {}, totalPhoto: 0, totalAccept: 0, totalAi: 0, lastUpdate: '' };
    const devId = String(body.deviceId || '').slice(0, 32) || 'unknown';
    if (!s.devices[devId]) s.devices[devId] = { first: new Date().toISOString().slice(0, 10), count: 0 };
    s.devices[devId].count++;
    if (body.type === 'photo') s.totalPhoto++;
    if (body.type === 'accept') s.totalAccept++;
    if (body.type === 'ai') s.totalAi++;
    s.lastUpdate = new Date().toISOString();
    giteePut('usage-stats.json', s).catch(() => {});
    return json({ ok: true });
  } catch (e) { return json({ ok: true }); }
}

async function usageQuery() {
  const s = await giteeGet('usage-stats.json');
  if (!s) return json({ devices: 0, totalPhoto: 0, totalAccept: 0, totalAi: 0 });
  return json({ devices: Object.keys(s.devices || {}).length, totalPhoto: s.totalPhoto || 0, totalAccept: s.totalAccept || 0, totalAi: s.totalAi || 0, lastUpdate: s.lastUpdate || '' });
}

async function reportOne(rec) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置（GITEE_TOKEN/GITEE_REPO）' }, 500);
  const month = String(rec.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const row = {
    date: rec.date || '', acceptNo: rec.acceptNo || '', contractNo: rec.contractNo || '',
    project: rec.project || '', name: rec.name || '', unit: rec.unit || '',
    qty: rec.qty || '', price: rec.price || '', amount: rec.amount || '',
    review: String(rec.review || '').slice(0, 15), match: rec.match || '', ts: Date.now()
  };
  const ok = await giteePut('reports/' + month + '/' + id + '.json', row);
  /* ★同步更新聚合索引（单文件，下次查1次请求搞定） */
  if (ok) {
    try {
      const idx = await giteeGet('reports-index.json');
      const rows = Array.isArray(idx) ? idx : [];
      rows.push(row);
      giteePut('reports-index.json', rows).catch(() => {});
      /* 同时更新内存缓存 */
      if (summaryCache[month]) {
        summaryCache[month] = { data: null, time: 0 }; /* 使缓存失效 */
      }
    } catch (e) {}
  }
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

async function reportPrices(rows) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ok = await giteePut('prices/' + id + '.json', rows || []);
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

/* ---------- 月度汇总 ---------- */
/* ★summary 缓存（5分钟）：避免每次请求都拉 Gitee 全部文件（提速10倍+） */
const summaryCache = {};
const SUMMARY_TTL = 5 * 60 * 1000;

async function summary(month, token) {
  const expect = process.env.DASHBOARD_TOKEN || '';
  if (expect && token !== expect) return json({ error: '口令错误' }, 401);
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);

  /* 缓存命中直接返回（5分钟内不重复拉 Gitee） */
  const cacheKey = month;
  const cached = summaryCache[cacheKey];
  if (cached && Date.now() - cached.time < SUMMARY_TTL) {
    return json(cached.data);
  }

  /* ★索引+增量合并：先读索引，再扫全部文件补齐（保证新数据不丢） */
  let records = [];
  const idx = await giteeGet('reports-index.json');
  if (Array.isArray(idx) && idx.length) {
    records = idx.filter(r => r && r.name && String(r.date || '').slice(0, 7) === month);
  }
  /* 扫本月文件增量补齐 */
  {
    let files;
    try {
      files = (await giteeList('reports/' + month)).filter(f => f.name && f.name.endsWith('.json'));
    } catch (e) { files = []; }
    if (files && files.length) {
      try {
        const results = await Promise.all(files.map(f => giteeGet('reports/' + month + '/' + f.name)));
        const scanned = results.filter(r => r && r.name);
        const seen = {};
        records.forEach(r => { if (r.ts) seen[r.ts + '-' + r.name] = 1; });
        scanned.forEach(r => {
          const k = r.ts + '-' + r.name;
          if (!seen[k]) { seen[k] = 1; records.push(r); }
        });
        if (records.length) giteePut('reports-index.json', records).catch(() => {});
      } catch (e) { /* 超时用已有数据 */ }
    }
  }
  if (!records.length) {
    return json({ month: month, rows: [], kpi: { totalAmount: 0, totalCount: 0, materialCount: 0, warnCount: 0 } });
  }
  /* 报价基准（少量文件，不慢） */
  let priceFiles = [];
  try {
    priceFiles = (await giteeList('prices')).filter(f => f.name && f.name.endsWith('.json'));
  } catch (e) {}
  const priceResults = await Promise.all(priceFiles.map(f => giteeGet('prices/' + f.name)));
  const baseMap = {};
  priceResults.forEach(rows => {
    if (Array.isArray(rows)) rows.forEach(r => { if (r && r.name && r.price > 0) baseMap[r.name] = r.price; });
  });
  const groups = {};
  records.forEach(r => {
    const k = r.name;
    if (!groups[k]) groups[k] = { name: k, unit: r.unit, count: 0, amountSum: 0, priceSum: 0, hasPrice: 0, reviews: [], bases: {}, diffs: [] };
    const g = groups[k];
    g.count++;
    g.amountSum += parseFloat(r.amount) || 0;
    const p = parseFloat(r.price);
    if (isFinite(p) && p > 0) {
      g.priceSum += p; g.hasPrice++;
      /* 比对口径：优先"单内基准"（本单验收价 vs 本单报价），A报价100按100比、B报价150按150比，
         多报价源互不干扰；缺单内报价回落全局基准（旧数据兼容） */
      const qb = parseFloat(r.quotePrice);
      const base = (isFinite(qb) && qb > 0) ? qb : (baseMap[k] || null);
      if (base && base > 0) {
        g.bases[base] = 1;
        g.diffs.push((p - base) / base * 100);
      }
    }
    if (r.review) g.reviews.push(r.review);
  });
  const rows = Object.keys(groups).map(k => {
    const g = groups[k];
    g.avgAcceptPrice = g.hasPrice ? g.priceSum / g.hasPrice : 0;
    const baseKeys = Object.keys(g.bases || {}).map(Number);
    g.baseList = baseKeys;
    g.basePrice = baseKeys.length === 1 ? baseKeys[0] : null;
    g.multiBase = baseKeys.length > 1;
    /* 差异 = 各笔验收相对"自家基准"的最大偏离（只报警真实偏离，不报多源价差） */
    g.diffPct = (g.diffs && g.diffs.length)
      ? g.diffs.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m), 0)
      : null;
    return g;
  });
  rows.sort((x, y) => Math.abs(y.diffPct || 0) - Math.abs(x.diffPct || 0));
  let totalAmount = 0, totalCount = 0, warnCount = 0;
  rows.forEach(g => {
    totalAmount += g.amountSum; totalCount += g.count;
    if (g.diffPct !== null && Math.abs(g.diffPct) >= 5) warnCount++;
  });
  const result = {
    month: month, rows: rows,
    kpi: { totalAmount: Math.round(totalAmount * 100) / 100, totalCount: totalCount, materialCount: rows.length, warnCount: warnCount }
  };
  summaryCache[cacheKey] = { data: result, time: Date.now() }; /* 存缓存 */
  return json(result);
}

exports.main_handler = async (event, context) => {
  const method = (event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    'GET').toUpperCase();
  if (method === 'OPTIONS') return json({ ok: true });

  if (method !== 'POST') {
    /* GET → 302跳转Pages看板（微信对函数URL直出HTML仍强制下载，跳转是唯一稳定路径）
       ?raw=1 可看内嵌直出版 */
    const raw = (event.queryString && event.queryString.raw) ||
      (event.queryStringParameters && event.queryStringParameters.raw);
    if (raw === '1') return html(DASHBOARD_HTML);
    return {
      statusCode: 302,
      headers: { 'Location': 'https://dapaoheti.github.io/acceptance1/dashboard.html?v=7' },
      body: ''
    };
  }
  let raw = event.body || '{}';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  let body = {};
  try { body = JSON.parse(raw); } catch (e) { return json({ error: '请求体不是合法JSON' }, 400); }
  try {
    const action = body.action || 'ai';
    if (action === 'report') return await reportOne(body.record || {});
    if (action === 'hashes') {
      if (!body.rows || !body.rows.length) return json(await loadHashRows());
      return await uploadHashes(body.rows);
    }
    if (action === 'geocode') return await geocode(body.lat, body.lng);
    if (action === 'checkHash') return await checkHash(body.hashes || []);
    if (action === 'prices') return await reportPrices(body.rows || []);
    if (action === 'usage') {
      if (body.query) return await usageQuery();
      return await usageTrack(body);
    }
    if (action === 'ping') {
      /* 诊断接口：秒回，测试 Gitee 连通性 */
      const giteeOk = process.env.GITEE_TOKEN ? 'token已设置' : 'token未设置';
      const repoOk = process.env.GITEE_REPO || '未设置';
      let giteeTest = '未测试';
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(giteeBase() + '/contents/?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''), { signal: ctrl.signal });
        giteeTest = 'Gitee HTTP ' + r.status;
      } catch (e) { giteeTest = 'Gitee连接失败: ' + (e.message || e); }
      return json({ status: 'ok', gitee_token: giteeOk, gitee_repo: repoOk, gitee_test: giteeTest, cache: Object.keys(summaryCache).length + '条缓存' });
    }
    if (action === 'summary') return await summary(String(body.month || ''), String(body.token || ''));
    return await aiCount(body);
  } catch (err) {
    return json({ error: '服务异常：' + (err && err.message ? err.message : '未知错误') }, 500);
  }
};
