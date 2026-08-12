import {
  clientIdFromHeaders,
  forwardToModel,
  getProxyConfig,
  jsonPayloadWithMeta,
  publicStatus,
  relayEventStream,
  routingHeaders,
  takeRateLimit,
  validateBody
} from "../server/proxy-core.mjs";
import { applyCors } from "../server/cors.mjs";

export const config = { api: { bodyParser: { sizeLimit: "6mb" } } };

export default async function handler(req, res) {
  const proxy = getProxyConfig();
  if (!applyCors(req, res, proxy, "POST, OPTIONS")) {
    return res.status(403).json({ error: "请求来源不在允许范围内" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "只接受 POST 请求" });
  if (!publicStatus(proxy).configured) return res.status(503).json({ error: "AI 服务尚未配置" });

  const limit = takeRateLimit(clientIdFromHeaders(req.headers, "serverless"), proxy);
  if (!limit.allowed) {
    res.setHeader("retry-after", String(limit.retryAfter));
    res.setHeader("x-rate-limit-reason", limit.scope);
    return res.status(429).json({ error: "本次演示的访问次数已达上限", scope: limit.scope });
  }

  try {
    const request = validateBody(typeof req.body === "string" ? JSON.parse(req.body) : req.body, proxy);
    const result = await forwardToModel(request, proxy);
    const headers = routingHeaders(result.route);
    Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
    res.setHeader("cache-control", "no-store");
    const type = result.response.headers.get("content-type") || "application/json; charset=utf-8";
    if (request.stream && result.response.ok && /text\/event-stream/i.test(type)) {
      res.status(result.response.status);
      res.setHeader("content-type", type);
      if (!result.response.body) return res.end();
      await relayEventStream(result, chunk => res.write(chunk));
      return res.end();
    }
    const payload = await jsonPayloadWithMeta(result);
    res.status(result.response.status);
    res.setHeader("content-type", payload.type);
    return res.end(payload.text);
  } catch (error) {
    if (res.headersSent) return res.end();
    const badRequest = /^(未知任务|任务|模型|该任务|消息|图片|工具|请求体)/.test(error.message);
    return res.status(badRequest ? 400 : 502).json({ error: badRequest ? error.message : "AI 服务请求失败" });
  }
}
