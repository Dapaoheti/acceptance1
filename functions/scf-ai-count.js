'use strict';
/**
 * 腾讯云 SCF：JF费用智能验收 中心服务 v2（全国内链路版）
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
<title>JF费用智能验收 · 集团月度看板</title>
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
  <h1>JF费用智能验收 · 集团月度看板</h1>
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
      <div class="kpi"><div class="v" id="kpiAmount">-</div><div class="l">验收总金额(元)</div></div>
      <div class="kpi"><div class="v" id="kpiCount">-</div><div class="l">验收单数</div></div>
      <div class="kpi"><div class="v" id="kpiMaterial">-</div><div class="l">物料种类</div></div>
      <div class="kpi"><div class="v warn" id="kpiWarn">-</div><div class="l">价格异常项</div></div>
    </div>
    <div class="panel">
      <h2>物料验收金额 TOP 10</h2>
      <div id="chartBox"><div class="empty">加载中…</div></div>
    </div>
    <div class="panel">
      <h2>报价基准比对（差异 ≥ ±5% 标注）</h2>
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

function loadData() {
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

function render(data) {
  var k = data.kpi || {};
  document.getElementById("kpiAmount").textContent = (k.totalAmount || 0).toLocaleString("zh");
  document.getElementById("kpiCount").textContent = k.totalCount || 0;
  document.getElementById("kpiMaterial").textContent = k.materialCount || 0;
  document.getElementById("kpiWarn").textContent = k.warnCount || 0;
  document.getElementById("updateTime").textContent = new Date().toLocaleString("zh");

  var rows = data.rows || [];
  /* 金额条形图 TOP10 */
  var top = rows.slice(0, 10);
  var max = 1;
  top.forEach(function (g) { if (g.amountSum > max) max = g.amountSum; });
  var chart = top.map(function (g) {
    return '<div class="bar-row"><div class="lbl">' + esc(g.name) + '</div>' +
      '<div class="track"><div class="fill" style="width:' + Math.max(2, g.amountSum / max * 100) + '%"></div></div>' +
      '<div class="val">' + g.amountSum.toLocaleString("zh") + '</div></div>';
  }).join("");
  document.getElementById("chartBox").innerHTML = chart || '<div class="empty">暂无数据</div>';

  /* 比对表 */
  var table = '<table><tr><th>物料</th><th>报价基准</th><th>验收均价</th><th>差异</th><th>次数</th><th>验收总额</th><th>复核提示</th></tr>';
  rows.forEach(function (g) {
    var diff = "—", cls = "";
    if (g.diffPct !== null && isFinite(g.diffPct)) {
      diff = (g.diffPct > 0 ? "+" : "") + g.diffPct.toFixed(1) + "%";
      cls = Math.abs(g.diffPct) >= 5 ? (g.diffPct > 0 ? "up" : "down") : "";
    }
    table += '<tr><td class="name">' + esc(g.name) + '</td>' +
      '<td>' + (g.basePrice ? g.basePrice.toFixed(2) : "—") + '</td>' +
      '<td>' + (g.avgAcceptPrice ? g.avgAcceptPrice.toFixed(2) : "—") + '</td>' +
      '<td class="' + cls + '">' + diff + '</td>' +
      '<td>' + g.count + '</td>' +
      '<td>' + g.amountSum.toLocaleString("zh") + '</td>' +
      '<td style="text-align:left;font-size:.72rem;color:#c98a3e;">' + esc((g.reviews || []).slice(0, 3).join("；")) + '</td></tr>';
  });
  table += "</table>";
  document.getElementById("tableBox").innerHTML = rows.length ? table : '<div class="empty">本月暂无验收数据</div>';
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 已有口令则直接进入 */
window.addEventListener("load", function () {
  if (getToken()) { showMain(); initMonths(); loadData(); }
});
</script>
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
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
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
  const res = await fetch(giteeBase() + '/contents/' + path + '?access_token=' + encodeURIComponent(process.env.GITEE_TOKEN || ''));
  if (!res.ok) return null;
  const d = await res.json();
  try { return JSON.parse(Buffer.from(d.content || '', 'base64').toString('utf8')); } catch (e) { return null; }
}

/* ---------- AI 点数 ---------- */
async function aiCount(body) {
  const key = process.env.AI_API_KEY;
  if (!key) return json({ error: 'AI_API_KEY 未配置' }, 500);
  const image = body && body.image;
  const prompt = body && body.prompt;
  if (!image || !prompt) return json({ error: '请求参数缺失（需要 image 和 prompt）' }, 400);
  if (String(image).length > 8 * 1024 * 1024) return json({ error: '图片过大（超过8MB）' }, 413);
  const baseUrl = process.env.AI_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
  const model = process.env.AI_MODEL || 'deepseek-v4-flash-vision-exp';
  const upstream = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': '***' + key },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt).slice(0, 2000) }, { type: 'image_url', image_url: { url: image } }] }],
      max_tokens: 2048
    })
  });
  if (!upstream.ok) {
    let msg = '上游模型服务错误 ' + upstream.status;
    if (upstream.status === 401) msg = 'AI_API_KEY 无效或已过期';
    else if (upstream.status === 402) msg = 'API 余额不足';
    else if (upstream.status === 429) msg = 'AI 服务繁忙，请稍后再试';
    return json({ error: msg }, 502);
  }
  const data = await upstream.json();
  let content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (Array.isArray(content)) content = content.map(c => (c && c.text) || '').join('');
  if (!content) return json({ error: '模型返回为空' }, 502);
  return json({ content: content });
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
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

async function checkHash(hashes) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);
  const files = await giteeList('hashes');
  const matches = [];
  for (const f of files) {
    if (!f.name || !f.name.endsWith('.json')) continue;
    const rows = await giteeGet('hashes/' + f.name);
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      for (const h of (hashes || [])) {
        if (r.hash && h && hammingHex(String(r.hash), String(h)) <= 8) {
          matches.push({ hash: r.hash, date: r.date || '', acceptNo: r.acceptNo || '', project: r.project || '', name: r.name || '', idx: r.idx });
        }
      }
    }
    if (matches.length > 20) break;
  }
  return json({ matches: matches });
}

/* ---------- 简报/基准上报 ---------- */
async function reportOne(rec) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置（GITEE_TOKEN/GITEE_REPO）' }, 500);
  const month = String(rec.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ok = await giteePut('reports/' + month + '/' + id + '.json', {
    date: rec.date || '', acceptNo: rec.acceptNo || '', contractNo: rec.contractNo || '',
    project: rec.project || '', name: rec.name || '', unit: rec.unit || '',
    qty: rec.qty || '', price: rec.price || '', amount: rec.amount || '',
    review: String(rec.review || '').slice(0, 15), match: rec.match || '', ts: Date.now()
  });
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

async function reportPrices(rows) {
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ok = await giteePut('prices/' + id + '.json', rows || []);
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

/* ---------- 月度汇总 ---------- */
async function summary(month, token) {
  const expect = process.env.DASHBOARD_TOKEN || '';
  if (expect && token !== expect) return json({ error: '口令错误' }, 401);
  if (!process.env.GITEE_TOKEN || !process.env.GITEE_REPO) return json({ error: '数据服务未配置' }, 500);

  const files = await giteeList('reports/' + month);
  const records = [];
  for (const f of files) {
    if (!f.name || !f.name.endsWith('.json')) continue;
    const rec = await giteeGet('reports/' + month + '/' + f.name);
    if (rec && rec.name) records.push(rec);
  }
  const priceFiles = await giteeList('prices');
  const baseMap = {};
  for (const f of priceFiles) {
    if (!f.name || !f.name.endsWith('.json')) continue;
    const rows = await giteeGet('prices/' + f.name);
    if (Array.isArray(rows)) rows.forEach(r => { if (r && r.name && r.price > 0) baseMap[r.name] = r.price; });
  }
  const groups = {};
  records.forEach(r => {
    const k = r.name;
    if (!groups[k]) groups[k] = { name: k, unit: r.unit, count: 0, amountSum: 0, priceSum: 0, hasPrice: 0, reviews: [] };
    const g = groups[k];
    g.count++;
    g.amountSum += parseFloat(r.amount) || 0;
    const p = parseFloat(r.price);
    if (isFinite(p) && p > 0) { g.priceSum += p; g.hasPrice++; }
    if (r.review) g.reviews.push(r.review);
  });
  const rows = Object.keys(groups).map(k => {
    const g = groups[k];
    g.avgAcceptPrice = g.hasPrice ? g.priceSum / g.hasPrice : 0;
    const base = baseMap[k] || null;
    g.basePrice = base;
    g.diffPct = (base && g.avgAcceptPrice) ? ((g.avgAcceptPrice - base) / base * 100) : null;
    return g;
  });
  rows.sort((x, y) => Math.abs(y.diffPct || 0) - Math.abs(x.diffPct || 0));
  let totalAmount = 0, totalCount = 0, warnCount = 0;
  rows.forEach(g => {
    totalAmount += g.amountSum; totalCount += g.count;
    if (g.diffPct !== null && Math.abs(g.diffPct) >= 5) warnCount++;
  });
  return json({
    month: month, rows: rows,
    kpi: { totalAmount: Math.round(totalAmount * 100) / 100, totalCount: totalCount, materialCount: rows.length, warnCount: warnCount }
  });
}

exports.main_handler = async (event, context) => {
  const method = (event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    'GET').toUpperCase();
  if (method === 'OPTIONS') return json({ ok: true });

  if (method !== 'POST') {
    /* GET → 返回集团月度看板页面 */
    return html(DASHBOARD_HTML);
  }
  let raw = event.body || '{}';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  let body = {};
  try { body = JSON.parse(raw); } catch (e) { return json({ error: '请求体不是合法JSON' }, 400); }
  try {
    const action = body.action || 'ai';
    if (action === 'report') return await reportOne(body.record || {});
    if (action === 'hashes') return await uploadHashes(body.rows || []);
    if (action === 'checkHash') return await checkHash(body.hashes || []);
    if (action === 'prices') return await reportPrices(body.rows || []);
    if (action === 'summary') return await summary(String(body.month || ''), String(body.token || ''));
    return await aiCount(body);
  } catch (err) {
    return json({ error: '服务异常：' + (err && err.message ? err.message : '未知错误') }, 500);
  }
};
