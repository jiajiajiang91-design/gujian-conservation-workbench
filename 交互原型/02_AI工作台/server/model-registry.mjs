const DEFAULT_PROVIDERS = [
  {
    id: "moonshot",
    label: "Moonshot",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY"
  }
];

const DEFAULT_MODELS = [
  {
    id: "moonshot-text-standard",
    provider: "moonshot",
    upstreamModel: "moonshot-v1-128k",
    label: "标准文字模型",
    capabilities: ["text", "json", "tools", "stream"],
    policy: { maxTokens: 6000, temperature: true, responseFormat: true, streamOptions: true },
    pricing: {
      currency: "CNY",
      inputPerMillion: 10,
      outputPerMillion: 30,
      source: "https://platform.kimi.com/docs/pricing/chat-v1",
      checkedAt: "2026-08-09"
    }
  },
  {
    id: "moonshot-vision-precision",
    provider: "moonshot",
    upstreamModel: "kimi-k2.6",
    label: "精细视觉模型",
    capabilities: ["text", "vision", "json"],
    policy: {
      maxTokens: 8000,
      temperature: false,
      responseFormat: true,
      streamOptions: false,
      thinking: { type: "disabled" }
    },
    pricing: {
      currency: "CNY",
      inputPerMillion: 6.5,
      cachedInputPerMillion: 1.1,
      outputPerMillion: 27,
      source: "https://platform.kimi.com/docs/pricing/chat-k26",
      checkedAt: "2026-08-09"
    }
  }
];

export const TASKS = [
  task("service.health", "连接测试", "运行检查", ["text"], ["moonshot-text-standard"], 120, 0),
  task("intake.extract", "立项理解", "文本结构化", ["text", "json"], ["moonshot-text-standard"], 2000, 0.2, true),
  task("brief.extract_text", "读任务书", "文本结构化", ["text", "json"], ["moonshot-text-standard"], 2000, 0.2, true),
  task("materials.assess", "资料判断", "文本结构化", ["text", "json"], ["moonshot-text-standard"], 2000, 0.2, true),
  task("sketch.extract_text", "草图解析", "文本结构化", ["text", "json"], ["moonshot-text-standard"], 2000, 0.2, true),
  task("selection.interpret", "框选理解", "文本结构化", ["text", "json"], ["moonshot-text-standard"], 1200, 0.1, true),
  task("material.classify_image", "资料分类", "文档视觉理解", ["text", "vision", "json"], ["moonshot-vision-precision"], 1200, 0.1, true),
  task("sketch.extract_image", "草图识别", "文档视觉理解", ["text", "vision", "json"], ["moonshot-vision-precision"], 4000, 0.1, true),
  task("brief.extract_image", "任务书识别", "文档视觉理解", ["text", "vision", "json"], ["moonshot-vision-precision"], 4000, 0.1, true),
  task("component.recognize", "构件识别", "专业视觉识别", ["text", "vision", "json"], ["moonshot-vision-precision"], 4000, 0.1, true),
  task("check.explain", "检查解释", "说明生成", ["text", "json"], ["moonshot-text-standard"], 1800, 0.2, true),
  task("delivery.draft", "交付说明", "说明生成", ["text", "json"], ["moonshot-text-standard"], 1800, 0.2, true),
  task("intent.route", "意图分发", "指令路由", ["text", "tools"], ["moonshot-text-standard"], 400, 0.1, false, true),
  task("edits.propose", "修改建议", "综合分析", ["text", "json"], ["moonshot-text-standard"], 2500, 0.2, true),
  task("assistant.answer", "自由问答", "综合分析", ["text", "stream"], ["moonshot-text-standard"], 1200, 0.3, false, false, true)
];

function task(id, label, group, requirements, models, maxTokens, temperature, json = false, tools = false, stream = false) {
  return { id, label, group, requirements, models, maxTokens, temperature, json, tools, stream };
}

function parseJson(value, fallback, name) {
  if (!value || !String(value).trim()) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${name} 不是有效 JSON`); }
}

function mapById(items, label) {
  const out = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) throw new Error(`${label}缺少 id`);
    out.set(item.id.trim(), { ...item, id: item.id.trim() });
  }
  return out;
}

function mergeItems(defaults, additions) {
  const map = mapById(defaults, "默认声明");
  for (const item of additions || []) {
    const prev = map.get(item.id) || {};
    map.set(item.id, { ...prev, ...item, policy: { ...(prev.policy || {}), ...(item.policy || {}) } });
  }
  return [...map.values()];
}

export function getModelRegistry(env = process.env) {
  const providers = mergeItems(DEFAULT_PROVIDERS, parseJson(env.AI_PROVIDERS_JSON, [], "AI_PROVIDERS_JSON"));
  const models = mergeItems(DEFAULT_MODELS, parseJson(env.AI_MODELS_JSON, [], "AI_MODELS_JSON"));
  const routeOverrides = parseJson(env.AI_TASK_ROUTES_JSON, {}, "AI_TASK_ROUTES_JSON");
  const providerMap = mapById(providers, "供应商声明");
  const modelMap = mapById(models, "模型声明");
  const allowed = new Set((env.AI_ALLOWED_MODELS || models.map(x => x.id).join(","))
    .split(",").map(x => x.trim()).filter(Boolean));

  for (const model of modelMap.values()) {
    if (!providerMap.has(model.provider)) throw new Error(`模型 ${model.id} 引用了不存在的供应商 ${model.provider}`);
    model.capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
  }

  const taskMap = mapById(TASKS.map(item => {
    const override = routeOverrides[item.id];
    const models = Array.isArray(override) ? override : (typeof override === "string" ? [override] : item.models);
    return { ...item, models };
  }), "任务声明");

  return { env, providers: providerMap, models: modelMap, tasks: taskMap, allowed };
}

export function resolveTask(registry, taskId) {
  const task = registry.tasks.get(taskId);
  if (!task) throw new Error("未知任务类型：" + taskId);

  const candidates = [];
  for (const modelId of task.models) {
    const model = registry.models.get(modelId);
    if (!model || !registry.allowed.has(modelId)) continue;
    const provider = registry.providers.get(model.provider);
    if (!provider) continue;
    const missing = task.requirements.filter(cap => !model.capabilities.includes(cap));
    if (missing.length) throw new Error(`任务 ${task.id} 的模型 ${model.id} 缺少能力：${missing.join("、")}`);
    const apiKey = String(registry.env[provider.apiKeyEnv] || "").trim();
    candidates.push({ task, model, provider, apiKey, configured: Boolean(apiKey) });
  }
  if (!candidates.length) throw new Error("任务没有可用的模型声明：" + taskId);
  return candidates.sort((a, b) => Number(b.configured) - Number(a.configured));
}

export function publicRegistry(registry) {
  const providers = [...registry.providers.values()].map(p => ({
    id: p.id,
    label: p.label || p.id,
    configured: Boolean(String(registry.env[p.apiKeyEnv] || "").trim())
  }));
  const tasks = [...registry.tasks.values()].map(task => {
    let route;
    try { route = resolveTask(registry, task.id)[0]; } catch { route = null; }
    return {
      id: task.id,
      label: task.label,
      group: task.group,
      model: route?.model.id || null,
      modelLabel: route?.model.label || null,
      provider: route?.provider.id || null,
      configured: Boolean(route?.configured),
      pricingConfigured: Boolean(route?.model.pricing)
    };
  });
  return { providers, tasks };
}
