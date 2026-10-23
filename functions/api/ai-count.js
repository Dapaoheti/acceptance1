/**
 * EdgeOne Pages Function: /api/ai-count
 * AI 点数服务端代理 —— 大模型 API Key 托管在平台环境变量，前端零密钥。
 *
 * 需在 EdgeOne 控制台 → 项目设置 → 环境变量 中配置：
 *   AI_API_KEY   = sk-xxxx（必填，大模型 API Key）
 *   AI_BASE_URL  = https://api.deepseek.com/v1/chat/completions（选填，默认DeepSeek）
 *   AI_MODEL     = deepseek-v4-flash-vision-exp（选填，默认DeepSeek视觉模型）
 *
 * 请求体: { "image": "data:image/jpeg;base64,...", "prompt": "识别提示词" }
 * 响应体: { "content": "模型返回文本" } 或 { "error": "错误信息" }
 */

export async function onRequestPost({ request, env }) {
  try {
    const key = env.AI_API_KEY;
    if (!key) {
      return json({ error: "AI_API_KEY 未配置：请在 EdgeOne 控制台 → 项目设置 → 环境变量 中添加" }, 500);
    }

    const body = await request.json();
    const image = body && body.image;
    const prompt = body && body.prompt;
    if (!image || !prompt) {
      return json({ error: "请求参数缺失（需要 image 和 prompt）" }, 400);
    }
    if (String(image).length > 8 * 1024 * 1024) {
      return json({ error: "图片过大（超过8MB）" }, 413);
    }

    const baseUrl = env.AI_BASE_URL || "https://api.deepseek.com/v1/chat/completions";
    const model = env.AI_MODEL || "deepseek-v4-flash-vision-exp";

    const upstream = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "***" + key
      },
      body: JSON.stringify({
        model: model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: String(prompt).slice(0, 2000) },
            { type: "image_url", image_url: { url: image } }
          ]
        }],
        max_tokens: 300
      })
    });

    if (!upstream.ok) {
      let detail = "";
      try { detail = (await upstream.text()).slice(0, 200); } catch (e) {}
      let msg = "上游模型服务错误 " + upstream.status;
      if (upstream.status === 401) msg = "AI_API_KEY 无效或已过期";
      else if (upstream.status === 402) msg = "API 余额不足";
      else if (upstream.status === 429) msg = "AI 服务繁忙，请稍后再试";
      return json({ error: msg, detail: detail }, 502);
    }

    const data = await upstream.json();
    let content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (Array.isArray(content)) {
      content = content.map(function (c) { return (c && c.text) || ""; }).join("");
    }
    if (!content) {
      return json({ error: "模型返回为空" }, 502);
    }
    return json({ content: content });
  } catch (err) {
    return json({ error: "代理异常：" + (err && err.message ? err.message : "未知错误") }, 500);
  }
}

export async function onRequest() {
  /* 非 POST 请求：返回使用说明 */
  return json({
    name: "AI 点数代理",
    usage: "POST { image: dataURL, prompt: string } → { content: string }"
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
