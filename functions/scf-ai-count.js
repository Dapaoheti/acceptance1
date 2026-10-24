'use strict';
/**
 * 腾讯云 SCF 云函数：AI 点数代理（DeepSeek 视觉模型转发）
 * ----------------------------------------------------------
 * 部署步骤：
 * 1. 腾讯云控制台 → 云函数 SCF → 新建函数 → 从头开始
 *    - 运行环境：Node.js 18（推荐，支持内置 fetch）
 *    - 提交方法：在线编辑，粘贴本文件全部内容
 * 2. 函数配置 → 环境变量：AI_API_KEY = *** 3. 函数URL → 创建函数URL → 鉴权方式选「免鉴权」（代码已带CORS）
 * 4. 把函数URL（https://xxx.scf.tencentcs.com/...）填到小程序
 *    「AI设置 → 平台代理 → 代理地址」
 *
 * 免费额度：每月40万次调用 + 40万GB-s，演示与团队使用完全免费。
 */

exports.main_handler = async (event, context) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
  const json = (obj, status) => ({
    statusCode: status || 200,
    headers: headers,
    body: JSON.stringify(obj)
  });

  // 预检请求
  const method = (event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    'POST').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (method !== 'POST') return json({ name: 'AI 点数代理(SCF)', usage: 'POST { image, prompt }' });

  try {
    const key = process.env.AI_API_KEY;
    if (!key) return json({ error: 'AI_API_KEY 未配置：请在函数环境变量中添加' }, 500);

    let raw = event.body || '{}';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
    const body = JSON.parse(raw);
    const image = body && body.image;
    const prompt = body && body.prompt;
    if (!image || !prompt) return json({ error: '请求参数缺失（需要 image 和 prompt）' }, 400);
    if (String(image).length > 8 * 1024 * 1024) return json({ error: '图片过大（超过8MB）' }, 413);

    const baseUrl = process.env.AI_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
    const model = process.env.AI_MODEL || 'deepseek-v4-flash-vision-exp';

    const upstream = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: String(prompt).slice(0, 2000) },
            { type: 'image_url', image_url: { url: image } }
          ]
        }],
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
    let content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (Array.isArray(content)) {
      content = content.map(c => (c && c.text) || '').join('');
    }
    if (!content) {
      /* 思考型模型可能把内容写进 reasoning_content */
      const rc = data && data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.reasoning_content;
      if (rc) content = String(rc);
    }
    if (!content) return json({ error: '模型返回为空' }, 502);
    return json({ content: content });
  } catch (err) {
    return json({ error: '代理异常：' + (err && err.message ? err.message : '未知错误') }, 500);
  }
};
