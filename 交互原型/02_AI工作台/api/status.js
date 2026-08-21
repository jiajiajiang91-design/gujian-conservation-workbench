import { applyCors } from "../server/cors.mjs";
import { getProxyConfig, publicStatus } from "../server/proxy-core.mjs";

export default function handler(req, res) {
  const proxy = getProxyConfig();
  if (!applyCors(req, res, proxy, "GET, OPTIONS")) {
    return res.status(403).json({ error: "请求来源不在允许范围内" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "只接受 GET 请求" });
  res.setHeader("cache-control", "no-store");
  return res.status(200).json(publicStatus(proxy));
}
