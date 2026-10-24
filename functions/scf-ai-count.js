'use strict';
/**
 * 腾讯云 SCF：JF费用智能验收 中心服务
 * ----------------------------------------------------------
 * 功能：
 *   1) AI 点数代理（原有）：POST { image, prompt } → { content }
 *   2) 验收简报上报：POST { action:"report", record:{...} } → { ok:true }
 *   3) 报价基准上报：POST { action:"prices", rows:[...] } → { ok:true }
 *   4) 月度汇总查询：POST { action:"summary", month:"2026-10", token:"..." } → { rows:[...], kpi:{...} }
 *
 * 数据存储：GitHub 私有仓库（免配置数据库）
 *   reports/2026-10/1730000000-xxxx.json   每单一个文件，避免并发冲突
 *   prices/xxxx.json                        报价单价基准
 *
 * 环境变量（函数配置 → 环境变量）：
 *   AI_API_KEY     = *** AI）
 *   GH_TOKEN       = GitHub 私人令牌（Fine-grained，仅 data 仓库 Contents 读写）
 *   GH_REPO        = Dapaoheti/acceptance-data（私有数据仓）
 *   DASHBOARD_TOKEN = 看板访问口令（自定义一串字母数字）
 */

const GH_API = 'https://api.github.com';

function json(obj, status) {
  return {
    statusCode: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type'
    },
    body: JSON.stringify(obj)
  };
}

function ghHeaders() {
  return {
    'Authorization': '***' + (process.env.GH_TOKEN || ''),
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };
}

async function ghPut(path, data) {
  const url = GH_API + '/repos/' + (process.env.GH_REPO || '') + '/contents/' + path;
  const res = await fetch(url, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({
      message: 'report ' + path,
      content: Buffer.from(JSON.stringify(data)).toString('base64')
    })
  });
  return res.ok;
}

async function ghList(path) {
  const url = GH_API + '/repos/' + (process.env.GH_REPO || '') + '/contents/' + path;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) return [];
  const arr = await res.json();
  return Array.isArray(arr) ? arr : [];
}

async function ghGetRaw(downloadUrl) {
  const res = await fetch(downloadUrl, { headers: { 'User-Agent': 'jf-ledger' } });
  if (!res.ok) return null;
  return res.json();
}

/* ---------- AI 点数（原有能力） ---------- */
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

/* ---------- 简报上报 ---------- */
async function reportOne(rec) {
  if (!process.env.GH_TOKEN || !process.env.GH_REPO) return json({ error: 'GH_TOKEN/GH_REPO 未配置' }, 500);
  const month = String(rec.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ok = await ghPut('reports/' + month + '/' + id + '.json', {
    date: rec.date || '', acceptNo: rec.acceptNo || '', contractNo: rec.contractNo || '',
    project: rec.project || '', name: rec.name || '', unit: rec.unit || '',
    qty: rec.qty || '', price: rec.price || '', amount: rec.amount || '',
    review: String(rec.review || '').slice(0, 15), match: rec.match || '', ts: Date.now()
  });
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

async function reportPrices(rows) {
  if (!process.env.GH_TOKEN || !process.env.GH_REPO) return json({ error: 'GH_TOKEN/GH_REPO 未配置' }, 500);
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ok = await ghPut('prices/' + id + '.json', rows || []);
  return ok ? json({ ok: true }) : json({ error: '上报失败' }, 502);
}

/* ---------- 月度汇总（领导看板） ---------- */
async function summary(month, token) {
  const expect = process.env.DASHBOARD_TOKEN || '';
  if (expect && token !== expect) return json({ error: '口令错误' }, 401);
  if (!process.env.GH_TOKEN || !process.env.GH_REPO) return json({ error: '数据服务未配置' }, 500);

  const files = await ghList('reports/' + month);
  const records = [];
  for (const f of files) {
    if (!f.name || !f.name.endsWith('.json')) continue;
    const rec = await ghGetRaw(f.download_url);
    if (rec && rec.name) records.push(rec);
  }
  /* 报价基准：全部价格文件取同名最新 */
  const priceFiles = await ghList('prices');
  const baseMap = {};
  for (const f of priceFiles) {
    if (!f.name || !f.name.endsWith('.json')) continue;
    const rows = await ghGetRaw(f.download_url);
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
    kpi: {
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalCount: totalCount,
      materialCount: rows.length,
      warnCount: warnCount
    }
  });
}

exports.main_handler = async (event, context) => {
  const method = (event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    'POST').toUpperCase();
  if (method === 'OPTIONS') return json({ ok: true });
  if (method !== 'POST') return json({ name: 'JF智能验收中心服务', usage: 'POST { action: report|prices|summary|ai }' });

  let raw = event.body || '{}';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  let body = {};
  try { body = JSON.parse(raw); } catch (e) { return json({ error: '请求体不是合法JSON' }, 400); }

  try {
    const action = body.action || 'ai';
    if (action === 'report') return await reportOne(body.record || {});
    if (action === 'prices') return await reportPrices(body.rows || []);
    if (action === 'summary') return await summary(String(body.month || ''), String(body.token || ''));
    return await aiCount(body);
  } catch (err) {
    return json({ error: '服务异常：' + (err && err.message ? err.message : '未知错误') }, 500);
  }
};
