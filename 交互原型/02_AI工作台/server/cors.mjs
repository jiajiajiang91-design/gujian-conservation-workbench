import { originAllowed } from "./proxy-core.mjs";

export function applyCors(req, res, proxy, methods) {
  const origin = String(req.headers.origin || "").trim();
  res.setHeader("vary", "Origin");

  if (origin && !originAllowed(origin, req.headers.host, proxy)) return false;
  if (origin) res.setHeader("access-control-allow-origin", origin);

  res.setHeader("access-control-allow-methods", methods);
  res.setHeader("access-control-allow-headers", "Content-Type");
  res.setHeader("access-control-expose-headers",
    "Retry-After, X-Rate-Limit-Reason, X-AI-Task, X-AI-Task-Group, X-AI-Provider, X-AI-Model");
  res.setHeader("access-control-max-age", "86400");
  return true;
}
