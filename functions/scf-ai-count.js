'use strict';
/**
 * 腾讯云 SCF：采购智验助手 中心服务 v2（全国内链路版）
 * ----------------------------------------------------------
 * 功能：
 *   1) AI 点数代理：POST { image, prompt } → { content }
 *   2) 验收简报上报：POST { action:"report", record:{...} }
 *   3) 报价基准上报：POST { action:"prices", rows:[...] }
 *   4) 月度汇总查询：POST { action:"summary", month, token }
 *   5) GET 访问 → 直接返回【集团月度看板】页面（口令登录）
 *   6) 明细记录查询（只读）：POST { action:"records", month, token }
 *
 * 上报可靠性（v7.14）：report 追加采用「读(内容+sha)→拼接→带sha写回，冲突重读重试」，
 * 并发上报不会互相覆盖（杜绝 lost update）；且按 record.dupIdx 幂等去重，客户端重试不重复计数。
 *
 * 数据存储：Gitee 私有仓库（国内链路，GitHub 零依赖）
 *   reports/2026-10/xxx.json   每单一个文件
 *   prices/xxx.json            报价单价基准
 *
 * 环境变量：
 *   GITEE_TOKEN = Gitee 私人令牌（数据仓读写）；DASHBOARD_TOKEN=*** AI_API_KEY/QWEN_API_KEY = AI 模型 Key；AMAP_KEY = 高德定位 Key
 *   GITEE_REPO      = JFACCPTANCE/acceptance-data（私有数据仓）
 *   DASHBOARD_TOKEN = ***
 */

const GITEE_API = 'https://gitee.com/api/v5';
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>采购智验助手 · 集团月度看板</title>
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
  <h1>采购智验助手 · 集团月度看板</h1>
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
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

/* ===== v7.32 写接口防护：Origin白名单 + 写令牌（防URL泄露后被任意调用） ===== */
const WRITE_TOKEN = process.env.WRITE_TOKEN || 'jf-write-2026';
const ORIGIN_ALLOW = ['https://dapaoheti.github.io', 'https://JFACCPTANCE.gitee.io'];
let _REQ_ORIGIN = '';
function writeAuth(body) {
  if (_REQ_ORIGIN && ORIGIN_ALLOW.indexOf(_REQ_ORIGIN) < 0) return false;
  return String((body && body.wtoken) || '') === WRITE_TOKEN;
}
function validMonth(m) { return /^\d{4}-\d{2}$/.test(m); }

function json(obj, status) {
  return {
    statusCode: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': (ORIGIN_ALLOW.indexOf(_REQ_ORIGIN) >= 0 ? _REQ_ORIGIN : '*'),
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

/* 纯文本读写（用于JSONL文件） */
async function giteeGetRaw(path) {
  try {
    const res = await fetchTO(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''), {}, 8000);
    if (!res.ok) return '';
    const d = await res.json();
    return Buffer.from(d.content || '', 'base64').toString('utf8');
  } catch (e) { return ''; }
}

async function giteePutRaw(path, text) {
  /* Gitee 不能追加，只能读-改-写（用 sha 避免冲突） */
  try {
    const existing = await fetch(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''));
    let sha = null;
    if (existing.ok) {
      const d = await existing.json();
      sha = d.sha;
    }
    const body = {
      access_token: process.env.GITEE_TOKEN || '',
      content: Buffer.from(text).toString('base64'),
      message: 'update ' + path
    };
    if (sha) body.sha = sha;
    const res = await fetchTO(giteeBase() + '/contents/' + path, {
      method: sha ? 'PUT' : 'POST',   /* Gitee: POST=创建、PUT=更新（用POST更新会400"文件名已存在"） */
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 15000);
    return res.ok;
  } catch (e) { return false; }
}

/* 一次读回【内容+sha】（追加写专用：内容与sha必须来自同一次读取，杜绝 lost update） */
function fetchTO(url, opts, ms) {
  /* 带超时的 fetch：运行时无 AbortController 时自动退化为普通 fetch（绝不因兼容性报错） */
  if (typeof AbortController === 'function') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms || 8000);
    const o = Object.assign({}, opts || {}, { signal: ctrl.signal });
    return fetch(url, o).then(r => { clearTimeout(timer); return r; }, e => { clearTimeout(timer); throw e; });
  }
  return fetch(url, opts || {});
}
async function giteeGetRawSha(path) {
  try {
    const res = await fetchTO(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''), {}, 8000);
    if (res.status === 404) return { text: '', sha: null };          /* 文件不存在→下次走创建 */
    if (res.status === 403 || res.status === 429) return { error: true, rate: true, err: '读被拒 HTTP ' + res.status };  /* 限流→不烧重试 */
    if (!res.ok) return { error: true, err: '读失败 HTTP ' + res.status };  /* 读失败→禁止盲写，由调用方重读 */
    const d = await res.json();
    return { text: Buffer.from(d.content || '', 'base64').toString('utf8'), sha: d.sha || null };
  } catch (e) { return { error: true, err: '读异常: ' + (e && e.message ? e.message : e) }; }
}

/* 去重键：同一条验收记录的唯一标识 */
function briefRowKey(o) {
  return [o.acceptNo || '', o.name || '', o.qty || '', o.price || '', o.amount || '', o.date || ''].join('|');
}

/* 冲突可重试的 JSONL 追加：读(内容+sha)→追加→带sha写回；
   写失败(409/400/非2xx/网络异常)一律重读重试（最多3次），绝不带旧内容强写，杜绝 lost update。
   dedupKey/dupIdx：幂等去重——已出现次数 n > dupIdx 视为已上报，跳过写入直接成功。 */
async function giteeAppendJsonl(path, row, dedupKey, dupIdx) {
  const deadline = Date.now() + 25000;   /* 总预算25秒：SCF 30秒会被杀，宁可502也不能被杀 */
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (Date.now() > deadline) { lastErr = lastErr || '总预算用尽'; break; }
    const cur = await giteeGetRawSha(path);
    if (cur.rate) return { ok: false, rate: true, err: cur.err || '' };  /* 接口限流：不烧重试，交客户端稍后重试 */
    if (cur.error) { lastErr = cur.err || '读取失败'; await new Promise(r => setTimeout(r, 150 * attempt)); continue; }
    const lines = cur.text ? cur.text.split('\n').filter(Boolean) : [];
    if (dedupKey) {
      let n = 0;
      for (const l of lines) {
        let o = null;
        try { o = JSON.parse(l); } catch (e) {}
        if (o && briefRowKey(o) === dedupKey) n++;
      }
      if (n > dupIdx) return { ok: true, dedup: true };
    }
    lines.push(JSON.stringify(row));
    try {
      const body = {
        access_token: process.env.GITEE_TOKEN || '',
        content: Buffer.from(lines.join('\n')).toString('base64'),
        message: (cur.sha ? 'update ' : 'create ') + path
      };
      if (cur.sha) body.sha = cur.sha;                               /* 带sha写回：期间有人写过就失败→重读 */
      const res = await fetchTO(giteeBase() + '/contents/' + path, {
        method: cur.sha ? 'PUT' : 'POST',   /* Gitee: PUT=更新、POST=创建 */
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 15000);                                                     /* 单次写15秒上限（94KB 提交偏慢时不误杀） */
      if (res.ok) return { ok: true, dedup: false };
      if (res.status === 429) return { ok: false, rate: true, err: '写被拒 HTTP 429' };
      let detail = '';
      try { detail = (await res.text()).slice(0, 120); } catch (e) {}
      lastErr = '写失败 HTTP ' + res.status + (detail ? ' ' + detail : '');
    } catch (e) {
      lastErr = '写异常: ' + (e && e.message ? e.message : e);
    }
    await new Promise(r => setTimeout(r, 150 * attempt));
  }
  return { ok: false, err: lastErr };
}

async function giteePut(path, data) {
  /* 统一走 giteePutRaw：带 sha 自动判创建(POST)/更新(PUT) */
  return giteePutRaw(path, JSON.stringify(data));
}

async function giteeList(path) {
  const res = await fetchTO(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''), {}, 8000);
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
      hasEqOrPrefix: key.indexOf('=') > -1 || key.indexOf('AI_API_KEY') > -1
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
  /* 单次≤200条 + 字段白名单清洗（防哈希库灌爆/投毒） */
  let list = Array.isArray(rows) ? rows.slice(0, 200) : [];
  const hex = /^[0-9a-fA-F]{8,64}$/;
  list = list.filter(r => r && typeof r.hash === 'string' && hex.test(r.hash)).map(r => ({
    hash: String(r.hash).slice(0, 64),
    fileHash: (typeof r.fileHash === 'string' && hex.test(r.fileHash)) ? r.fileHash.slice(0, 64) : '',
    date: String(r.date || '').slice(0, 10), acceptNo: String(r.acceptNo || '').slice(0, 40),
    project: String(r.project || '').slice(0, 60), name: String(r.name || '').slice(0, 80),
    idx: Number(r.idx) || 0
  }));
  rows = list;
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
  const hexOk = /^[0-9a-fA-F]{8,64}$/;
  for (const r of rows) {
    if (matches.length > 20) break;
    for (const h of (hashes || [])) {
      if (matches.length > 20) break;
      if (r.hash && h && hexOk.test(String(r.hash)) && hexOk.test(String(h))) {
        const d = hammingHex(String(r.hash), String(h));
        if (d <= 8) {
          matches.push({ hash: r.hash, date: r.date || '', acceptNo: r.acceptNo || '', project: r.project || '', name: r.name || '', idx: r.idx, dist: d, hard: d <= 4 });
        }
      }
    }
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
    if (!s.devices || typeof s.devices !== 'object') s.devices = {};
    let devId = String(body.deviceId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unknown';
    if (devId === '__proto__' || devId === 'constructor' || devId === 'prototype') devId = 'unknown'; /* 防原型污染 */
    if (!Object.prototype.hasOwnProperty.call(s.devices, devId)) s.devices[devId] = { first: new Date().toISOString().slice(0, 10), count: 0 };
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
  if (!validMonth(month)) return json({ error: '\u65e5\u671f\u683c\u5f0f\u975e\u6cd5' }, 400);
  const dupIdxRaw = parseInt(rec.dupIdx, 10);
  const dupIdx = (isFinite(dupIdxRaw) && dupIdxRaw >= 0) ? dupIdxRaw : 0;  /* 客户端不带按0处理 */
  const _q = parseFloat(rec.qty), _p = parseFloat(rec.price), _a = parseFloat(rec.amount);
  const _mismatch = isFinite(_q) && isFinite(_p) && isFinite(_a) && _q > 0 && _p > 0 && _a > 0 &&
    Math.abs(_a - _q * _p) > Math.max(1, _q * _p * 0.02);
  const row = {
    date: String(rec.date || '').slice(0, 10), acceptNo: String(rec.acceptNo || '').slice(0, 40),
    contractNo: String(rec.contractNo || '').slice(0, 40), project: String(rec.project || '').slice(0, 60),
    name: String(rec.name || '').slice(0, 80), unit: String(rec.unit || '').slice(0, 16),
    qty: String(rec.qty != null ? rec.qty : '').slice(0, 16),
    price: String(rec.price != null ? rec.price : '').slice(0, 16),
    amount: String(rec.amount != null ? rec.amount : '').slice(0, 16),
    suspect: (_mismatch && !String(rec.remark || '').trim()) ? 1 : 0,
    review: String(rec.review || '').slice(0, 15), match: rec.match || '',
    quoteQty: String(rec.quoteQty != null ? rec.quoteQty : '').slice(0, 24),
    quotePrice: String(rec.quotePrice != null ? rec.quotePrice : '').slice(0, 24),
    remark: String(rec.remark || '').slice(0, 200), time: String(rec.time || '').slice(0, 10),
    dupIdx: dupIdx, ts: Date.now()
  };
  try {
    const monthFile = 'reports/' + month + '.jsonl';
    /* 幂等去重 + 冲突可重试追加：快速连续验收/客户端重试都不丢行、不重复计数 */
    const r = await giteeAppendJsonl(monthFile, row, briefRowKey(row), dupIdx);
    /* 使缓存失效 */
    if (summaryCache[month]) summaryCache[month] = { data: null, time: 0 };
    if (r.ok) return json(r.dedup ? { ok: true, dedup: true } : { ok: true });
    /* 重试仍失败 → 502 交客户端持久化队列退避重试（限流给明确提示） */
    return json({ error: r.rate ? '数据仓接口限流，已排队稍后自动重试' : ('上报失败：' + (r.err || '并发写入冲突，已排队稍后重试')) }, 502);
  } catch (e) {
    return json({ error: '上报失败: ' + (e.message || e) }, 502);
  }
}

async function reportPrices(rows) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ok = await giteePut('prices/' + id + '.json', rows || []);
  if (ok) {
    /* 同步维护报价索引 prices-index.json（1读1写，best-effort）：summary 此后永远1次请求拿基准 */
    try {
      const map = await loadPriceBase();
      (rows || []).forEach(r => { if (r && r.name && r.price > 0) map[r.name] = r.price; });
      priceBaseCache = { ts: Date.now(), map: map };
      giteePutRaw('prices-index.json', JSON.stringify(map)).catch(() => {});
      for (const mk of Object.keys(summaryCache)) summaryCache[mk] = { data: null, time: 0 }; /* 报价更新→看板缓存失效 */
    } catch (e) {}
  }
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

/* ---------- 报价基准：单文件索引+缓存（summary 提速，防 SCF 30s 函数超时） ---------- */
let priceBaseCache = { ts: 0, map: null };
const PRICE_BASE_TTL = 5 * 60 * 1000;

async function giteeGetJsonFast(path, ms) {
  /* 带短超时的 JSON 读取（报价文件多时防个别慢请求拖死整体） */
  try {
    const res = await fetchTO(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''), {}, ms || 4000);
    if (!res.ok) return null;
    const d = await res.json();
    return JSON.parse(Buffer.from(d.content || '', 'base64').toString('utf8'));
  } catch (e) { return null; }
}

async function loadPriceBase() {
  const now = Date.now();
  if (priceBaseCache.map && now - priceBaseCache.ts < PRICE_BASE_TTL) return priceBaseCache.map;
  /* 1) 单文件索引优先（1次请求） */
  const idx = await giteeGetJsonFast('prices-index.json', 6000);
  if (idx && typeof idx === 'object' && !Array.isArray(idx) && Object.keys(idx).length) {
    priceBaseCache = { ts: now, map: idx };
    return idx;
  }
  /* 2) 回退：扫 prices/ 全部文件（每个4秒超时；全部成功才固化索引，部分失败下次重扫） */
  let files = [];
  try { files = (await giteeList('prices')).filter(f => f.name && f.name.endsWith('.json')); } catch (e) {}
  files.sort((a, b) => (a.name < b.name ? -1 : 1));  /* id前缀=时间戳，按名升序=旧→新，新价覆盖旧价 */
  const results = await Promise.all(files.map(f => giteeGetJsonFast('prices/' + f.name, 4000)));
  const map = {};
  let complete = true;
  results.forEach(rows => {
    if (Array.isArray(rows)) rows.forEach(r => { if (r && r.name && r.price > 0) map[r.name] = r.price; });
    else complete = false;
  });
  priceBaseCache = { ts: now, map: map };
  if (files.length && complete) giteePutRaw('prices-index.json', JSON.stringify(map)).catch(() => {});
  return map;
}

/* ---------- 明细记录查询（只读，供客户端补传对账） ---------- */
async function recordsQuery(month, token) {
  const expect = process.env.DASHBOARD_TOKEN || '';
  if (!expect) return json({ error: '\u672a\u914d\u7f6e\u53e3\u4ee4\uff08DASHBOARD_TOKEN\uff09' }, 500);
  if (token !== expect) return json({ error: '口令错误' }, 401);
  if (!validMonth(String(month || ''))) return json({ error: '\u6708\u4efd\u683c\u5f0f\u975e\u6cd5' }, 400);
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);
  const raw = await giteeGetRaw('reports/' + String(month || '') + '.jsonl');
  const records = raw ? raw.trim().split('\n').filter(Boolean).map(function (l) {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(function (r) { return r && r.name; }) : [];
  return json({ month: String(month || ''), records: records });
}

/* ---------- 月度汇总 ---------- */
/* ★summary 缓存（5分钟）：避免每次请求都拉 Gitee 全部文件（提速10倍+） */
const summaryCache = {};
const SUMMARY_TTL = 5 * 60 * 1000;

async function summary(month, token) {
  const expect = process.env.DASHBOARD_TOKEN || '';
  if (!expect) return json({ error: '\u672a\u914d\u7f6e\u53e3\u4ee4\uff08DASHBOARD_TOKEN\uff09' }, 500);
  if (token !== expect) return json({ error: '口令错误' }, 401);
  if (!validMonth(String(month || ''))) return json({ error: '\u6708\u4efd\u683c\u5f0f\u975e\u6cd5' }, 400);
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);

  /* 缓存命中直接返回（5分钟内不重复拉 Gitee） */
  const cacheKey = month;
  const cached = summaryCache[cacheKey];
  if (cached && Date.now() - cached.time < SUMMARY_TTL) {
    return json(cached.data);
  }

  /* ★单文件读取（1次API拿全部数据） */
  let records = [];
  const raw = await giteeGetRaw('reports/' + month + '.jsonl');
  if (raw) {
    records = raw.trim().split('\n').filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(function (r) { return r && r.name; });
  }
  /* ★旧格式回退：仅当 JSONL 缺失/为空时才逐文件扫旧数据补齐。
     JSONL 非空时以 JSONL 为准（逐文件扫描动辄几百次请求，会拖过 30s 函数超时）；
     JSONL 缺行由客户端「补传数据仓」按 dupIdx 幂等补回 */
  if (!records.length) {
    try {
      const files = (await giteeList('reports/' + month)).filter(f => f.name && f.name.endsWith('.json'));
      if (files && files.length) {
        const results = await Promise.all(files.map(f => giteeGet('reports/' + month + '/' + f.name)));
        const scanned = results.filter(r => r && r.name);
        if (scanned.length) {
          records = scanned;
          const jsonl = records.map(r => JSON.stringify(r)).join('\n');
          giteePutRaw('reports/' + month + '.jsonl', jsonl).catch(() => {});
        }
      }
    } catch (e) {}
  }
  if (!records.length) {
    return json({ month: month, rows: [], kpi: { totalAmount: 0, totalCount: 0, materialCount: 0, warnCount: 0 } });
  }
  /* 报价基准：走单文件索引+缓存（1次请求），不再每次逐文件拉取 */
  let baseMap = {};
  try { baseMap = await loadPriceBase(); } catch (e) {}
  const groups = Object.create(null); /* 防原型污染：name=__proto__ 不再打到 Object.prototype */
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
    _REQ_ORIGIN = String((event.headers && (event.headers.origin || event.headers.Origin)) || '');
    /* 写接口统一鉴权：report/prices/hashes/usage/ai */
    if (['report', 'prices', 'hashes', 'usage', 'ai'].indexOf(action) >= 0 && !writeAuth(body)) {
      return json({ error: '\u7981\u6b62\u8bbf\u95ee' }, 403);
    }
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
    if (action === 'migrate') {
      /* 数据迁移：旧的多文件 → JSONL 单文件（需口令） */
      const migTok = process.env.WRITE_TOKEN || process.env.DASHBOARD_TOKEN || '';
      if (!migTok || String(body.token || '') !== migTok) return json({ error: '\u7981\u6b62\u8bbf\u95ee' }, 403);
      const month = String(body.month || '2026-10');
      if (!validMonth(month)) return json({ error: '\u6708\u4efd\u683c\u5f0f\u975e\u6cd5' }, 400);
      const files = (await giteeList('reports/' + month)).filter(f => f.name && f.name.endsWith('.json'));
      if (!files.length) return json({ error: '没有旧数据' }, 404);
      const results = await Promise.all(files.map(f => giteeGet('reports/' + month + '/' + f.name)));
      const records = results.filter(r => r && r.name);
      const jsonl = records.map(r => JSON.stringify(r)).join('\n');
      const ok = await giteePutRaw('reports/' + month + '.jsonl', jsonl);
      return json({ ok: ok, migrated: records.length, total: files.length });
    }
    if (action === 'ping') {
      /* 诊断接口：秒回，测试 Gitee 连通性 + 自诊断（全只读） */
      const giteeOk = process.env.GITEE_TOKEN ? 'token已设置' : 'token未设置';
      const repoOk = process.env.GITEE_REPO || '未设置';
      let giteeTest = '未测试';
      try {
        const r = await fetchTO(giteeBase() + '/contents/?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''), {}, 5000);
        giteeTest = 'Gitee HTTP ' + r.status;
      } catch (e) { giteeTest = 'Gitee连接失败: ' + (e.message || e); }
      /* 自诊断：运行时环境 + 读通路实况（排查'上报失败'用，全只读） */
      let diag = { ver: 'v7.17.1', node: process.version, abort: typeof AbortController };
      try {
        const cur = await giteeGetRawSha('reports/2026-10.jsonl');
        diag.read = cur.error ? (cur.err || '读失败') : ('ok len=' + (cur.text ? cur.text.length : 0) + ' sha=' + String(cur.sha || '').slice(0, 7));
      } catch (e) { diag.read = '异常: ' + (e.message || e); }
      return json({ status: 'ok', gitee_token: giteeOk, gitee_repo: repoOk, gitee_test: giteeTest, cache: Object.keys(summaryCache).length + '条缓存', diag: diag });
    }
    if (action === 'records') return await recordsQuery(String(body.month || ''), String(body.token || ''));
    if (action === 'summary') return await summary(String(body.month || ''), String(body.token || ''));
    return await aiCount(body);
  } catch (err) {
    return json({ error: '服务异常：' + (err && err.message ? err.message : '未知错误') }, 500);
  }
};
