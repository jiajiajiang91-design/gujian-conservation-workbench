import { callOpenAIChat } from "./providers/openai-chat.mjs";
import { getModelRegistry, publicRegistry, resolveTask } from "./model-registry.mjs";

const minuteBuckets = new Map();
const dayBuckets = new Map();
const globalBuckets = new Map();

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getProxyConfig(env = process.env) {
  const registry = getModelRegistry(env);
  return {
    registry,
    allowedOrigins: (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
    perMinute: positiveInt(env.AI_PER_MINUTE_LIMIT, 6),
    perDay: positiveInt(env.AI_PER_DAY_LIMIT, 80),
    globalDay: positiveInt(env.AI_GLOBAL_DAY_LIMIT, 300),
    maxBytes: positiveInt(env.AI_MAX_REQUEST_BYTES, 6 * 1024 * 1024),
    maxTokens: positiveInt(env.AI_MAX_TOKENS, 8000)
  };
}

export function publicStatus(config) {
  const registry = publicRegistry(config.registry);
  return {
    configured: registry.tasks.some(task => task.configured),
    architecture: "task-router",
    providers: registry.providers,
    tasks: registry.tasks,
    limits: {
      perMinute: config.perMinute,
      perDay: config.perDay,
      maxRequestMB: Math.round(config.maxBytes / 1024 / 1024),
      maxTokens: config.maxTokens
    }
  };
}

export function originAllowed(origin, host, config) {
  if (!origin) return true;
  if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
  try { return new URL(origin).host === host; }
  catch { return false; }
}

function hitBucket(map, key, windowMs, max) {
  const now = Date.now();
  const prev = map.get(key);
  const entry = !prev || now >= prev.resetAt ? { count: 0, resetAt: now + windowMs } : prev;
  entry.count += 1;
  map.set(key, entry);
  return {
    allowed: entry.count <= max,
    remaining: Math.max(0, max - entry.count),
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  };
}

export function takeRateLimit(clientId, config) {
  const minute = hitBucket(minuteBuckets, clientId, 60_000, config.perMinute);
  if (!minute.allowed) return { ...minute, scope: "minute" };
  const day = hitBucket(dayBuckets, clientId, 86_400_000, config.perDay);
  if (!day.allowed) return { ...day, scope: "day" };
  const global = hitBucket(globalBuckets, "all", 86_400_000, config.globalDay);
  if (!global.allowed) return { ...global, scope: "global-day" };
  return { allowed: true, remaining: Math.min(minute.remaining, day.remaining) };
}

function validateContent(content) {
  if (typeof content === "string") return;
  if (!Array.isArray(content) || content.length > 12) throw new Error("消息内容格式不正确");
  for (const item of content) {
    if (!item || typeof item !== "object") throw new Error("消息内容格式不正确");
    if (item.type === "text" && typeof item.text === "string") continue;
    const url = item.image_url?.url;
    if (item.type === "image_url" && typeof url === "string" &&
        /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(url)) continue;
    throw new Error("图片必须以受支持的 data URL 上传");
  }
}

export function validateBody(input, config) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求体必须是 JSON 对象");
  if (input.model || input.thinking) throw new Error("模型和模型参数由服务端按任务选择");
  const taskId = String(input.task_id || "").trim();
  const candidates = resolveTask(config.registry, taskId);
  if (!candidates.some(route => route.configured)) throw new Error("该任务的在线模型尚未配置");
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 24) {
    throw new Error("消息数量不正确");
  }

  const messages = input.messages.map(message => {
    if (!message || !["system", "user", "assistant", "tool"].includes(message.role)) {
      throw new Error("消息角色不正确");
    }
    validateContent(message.content);
    const safe = { role: message.role, content: message.content };
    if (typeof message.name === "string") safe.name = message.name.slice(0, 64);
    if (typeof message.tool_call_id === "string") safe.tool_call_id = message.tool_call_id.slice(0, 128);
    return safe;
  });
  if (candidates[0].task.tools && (!Array.isArray(input.tools) || input.tools.length > 20)) {
    throw new Error("工具数量不正确");
  }
  return {
    task_id: taskId,
    messages,
    tools: candidates[0].task.tools ? input.tools : undefined,
    stream: Boolean(input.stream),
    max_tokens: input.max_tokens,
    candidates
  };
}

export async function forwardToModel(request, config, signal) {
  const configured = request.candidates.filter(route => route.configured);
  let lastResponse = null;
  for (let i = 0; i < configured.length; i++) {
    const route = configured[i];
    if (route.provider.protocol !== "openai-chat") throw new Error("尚未实现供应商协议：" + route.provider.protocol);
    const response = await callOpenAIChat(request, route, config, signal);
    lastResponse = response;
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || i === configured.length - 1) {
      return { response, route, attempts: i + 1 };
    }
  }
  return { response: lastResponse, route: configured[configured.length - 1], attempts: configured.length };
}

function usageNumber(usage, ...paths) {
  for (const path of paths) {
    let value = usage;
    for (const key of path.split(".")) value = value?.[key];
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

export function responseMeta(route, usage = {}, attempts = 1) {
  const input = usageNumber(usage, "prompt_tokens", "input_tokens");
  const output = usageNumber(usage, "completion_tokens", "output_tokens");
  const cached = usageNumber(usage, "prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens");
  const reasoning = usageNumber(usage, "completion_tokens_details.reasoning_tokens", "output_tokens_details.reasoning_tokens");
  const total = usageNumber(usage, "total_tokens") || input + output;
  const pricing = route.model.pricing;
  let cost = null;
  if (pricing && Number.isFinite(pricing.inputPerMillion) && Number.isFinite(pricing.outputPerMillion)) {
    const normalInput = Math.max(0, input - cached);
    const cachedRate = Number.isFinite(pricing.cachedInputPerMillion)
      ? pricing.cachedInputPerMillion : pricing.inputPerMillion;
    const amount = (normalInput * pricing.inputPerMillion + cached * cachedRate + output * pricing.outputPerMillion) / 1_000_000;
    cost = {
      amount: Math.round(amount * 1_000_000) / 1_000_000,
      currency: pricing.currency || "CNY",
      source: pricing.source || "",
      effectiveAt: pricing.checkedAt || pricing.effectiveAt || ""
    };
  }
  return {
    taskId: route.task.id,
    taskLabel: route.task.label,
    taskGroup: route.task.group,
    provider: route.provider.id,
    model: route.model.id,
    upstreamModel: route.model.upstreamModel,
    attempts,
    usage: { input, output, cached, reasoning, total },
    cost
  };
}

export function routingHeaders(route) {
  return {
    "x-ai-task": route.task.id,
    "x-ai-task-group": encodeURIComponent(route.task.group),
    "x-ai-provider": route.provider.id,
    "x-ai-model": route.model.id
  };
}

export async function jsonPayloadWithMeta(result) {
  const text = await result.response.text();
  if (!result.response.ok) return { text, type: result.response.headers.get("content-type") || "application/json" };
  let payload;
  try { payload = JSON.parse(text); }
  catch { return { text, type: result.response.headers.get("content-type") || "text/plain" }; }
  payload.gujian_meta = responseMeta(result.route, payload.usage || {}, result.attempts);
  return { text: JSON.stringify(payload), type: "application/json; charset=utf-8" };
}

export async function relayEventStream(result, write) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = {};
  for await (const chunk of result.response.body) {
    write(Buffer.from(chunk));
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const value = line.trim();
      if (!value.startsWith("data:")) continue;
      const raw = value.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const event = JSON.parse(raw);
        if (event.usage) usage = event.usage;
      } catch { /* 上游分片只用于观察用量，不改写原始内容 */ }
    }
  }
  const meta = responseMeta(result.route, usage, result.attempts);
  write(Buffer.from("\ndata: " + JSON.stringify({ gujian_meta: meta }) + "\n\n"));
}

export function clientIdFromHeaders(headers, fallback = "unknown") {
  const forwarded = headers["x-forwarded-for"] || headers.get?.("x-forwarded-for");
  return String(forwarded || fallback).split(",")[0].trim().slice(0, 128);
}
