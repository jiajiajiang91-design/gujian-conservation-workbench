import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientIdFromHeaders,
  forwardToModel,
  getProxyConfig,
  jsonPayloadWithMeta,
  originAllowed,
  publicStatus,
  relayEventStream,
  routingHeaders,
  takeRateLimit,
  validateBody
} from "./server/proxy-core.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const STATIC_ROOT = join(ROOT, "dist");
loadEnv(join(ROOT, ".env"));
const PORT = Number.parseInt(process.env.PORT || "8795", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; object-src 'none'; " +
    "base-uri 'self'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "same-origin"
};

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...SECURITY_HEADERS,
    ...headers
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("请求内容超过大小限制"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是有效 JSON"), { status: 400 });
  }
}

async function handleAI(req, res) {
  const config = getProxyConfig();
  if (!publicStatus(config).configured) return json(res, 503, { error: "AI 服务尚未配置" });
  if (!originAllowed(req.headers.origin, req.headers.host, config)) {
    return json(res, 403, { error: "请求来源不在允许范围内" });
  }
  const limit = takeRateLimit(clientIdFromHeaders(req.headers, req.socket.remoteAddress), config);
  if (!limit.allowed) {
    return json(res, 429, { error: "本次演示的访问次数已达上限", scope: limit.scope }, {
      "retry-after": String(limit.retryAfter),
      "x-rate-limit-reason": limit.scope
    });
  }

  try {
    const input = await readJson(req, config.maxBytes);
    const request = validateBody(input, config);
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    const result = await forwardToModel(request, config, controller.signal);
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...routingHeaders(result.route)
    };
    const type = result.response.headers.get("content-type") || "application/json; charset=utf-8";
    if (request.stream && result.response.ok && /text\/event-stream/i.test(type)) {
      res.writeHead(result.response.status, { ...headers, "content-type": type });
      if (!result.response.body) return res.end();
      await relayEventStream(result, chunk => res.write(chunk));
      return res.end();
    }
    const payload = await jsonPayloadWithMeta(result);
    res.writeHead(result.response.status, { ...headers, "content-type": payload.type });
    return res.end(payload.text);
  } catch (error) {
    if (res.headersSent) return res.end();
    console.error("AI proxy failed:", error?.name || "Error", error?.message || "unknown");
    const status = error.status || (/^(未知任务|任务|模型|该任务|消息|图片|工具|请求体)/.test(error.message) ? 400 : 502);
    json(res, status, { error: status === 502 ? "AI 服务请求失败" : error.message });
  }
}

function serveStatic(req, res, pathname) {
  if (!existsSync(STATIC_ROOT)) {
    return json(res, 503, { error: "尚未构建前端，请先运行 npm run build" });
  }
  const allowed = pathname === "/" || pathname === "/index.html" || pathname.startsWith("/assets/");
  if (!allowed) return json(res, 404, { error: "未找到" });

  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = normalize(join(STATIC_ROOT, relative));
  if (!filePath.toLowerCase().startsWith(STATIC_ROOT.toLowerCase()) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return json(res, 404, { error: "未找到" });
  }
  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    ...SECURITY_HEADERS
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/api/status" && req.method === "GET") {
      return json(res, 200, publicStatus(getProxyConfig()));
    }
    if (url.pathname === "/api/ai") {
      if (req.method !== "POST") return json(res, 405, { error: "只接受 POST 请求" }, { allow: "POST" });
      return handleAI(req, res);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "不支持该请求方法" });
    return serveStatic(req, res, url.pathname);
  } catch {
    if (!res.headersSent) return json(res, 400, { error: "请求地址格式不正确" });
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const configured = publicStatus(getProxyConfig()).configured ? "已配置" : "未配置";
  console.log(`古建 AI 工作台：http://127.0.0.1:${PORT}/（AI 服务${configured}）`);
});
