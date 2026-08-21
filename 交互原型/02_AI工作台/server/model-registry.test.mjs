import test from "node:test";
import assert from "node:assert/strict";
import { getModelRegistry, resolveTask } from "./model-registry.mjs";
import { getProxyConfig, responseMeta, validateBody } from "./proxy-core.mjs";
import { buildOpenAIChatBody } from "./providers/openai-chat.mjs";

test("默认任务路由保持现有文字与视觉模型", () => {
  const registry = getModelRegistry({ MOONSHOT_API_KEY: "test" });
  assert.equal(resolveTask(registry, "intake.extract")[0].model.upstreamModel, "moonshot-v1-128k");
  assert.equal(resolveTask(registry, "component.recognize")[0].model.upstreamModel, "kimi-k2.6");
});

test("新增兼容供应商只需声明和环境变量", () => {
  const env = {
    ALT_KEY: "test",
    AI_PROVIDERS_JSON: JSON.stringify([
      { id: "alt", label: "Alt", protocol: "openai-chat", baseUrl: "https://example.com/v1", apiKeyEnv: "ALT_KEY" }
    ]),
    AI_MODELS_JSON: JSON.stringify([
      { id: "alt-text", provider: "alt", upstreamModel: "alt-1", capabilities: ["text", "json", "tools", "stream"] }
    ]),
    AI_TASK_ROUTES_JSON: JSON.stringify({ "intake.extract": ["alt-text", "moonshot-text-standard"] })
  };
  const route = resolveTask(getModelRegistry(env), "intake.extract")[0];
  assert.equal(route.provider.id, "alt");
  assert.equal(route.model.upstreamModel, "alt-1");
});

test("浏览器不能越过任务路由指定模型", () => {
  const config = getProxyConfig({ MOONSHOT_API_KEY: "test" });
  assert.throws(() => validateBody({
    task_id: "intake.extract",
    model: "kimi-k2.6",
    messages: [{ role: "user", content: "test" }]
  }, config), /服务端按任务选择/);
});

test("模型参数由声明策略生成", () => {
  const config = getProxyConfig({ MOONSHOT_API_KEY: "test" });
  const route = resolveTask(config.registry, "component.recognize")[0];
  const request = validateBody({
    task_id: "component.recognize",
    messages: [{ role: "user", content: "test" }]
  }, config);
  const body = buildOpenAIChatBody(request, route, config);
  assert.equal(body.model, "kimi-k2.6");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.temperature, undefined);
});

test("费用区分普通输入、缓存输入与输出", () => {
  const config = getProxyConfig({
    ALT_KEY: "test",
    AI_PROVIDERS_JSON: JSON.stringify([
      { id: "alt", protocol: "openai-chat", baseUrl: "https://example.com/v1", apiKeyEnv: "ALT_KEY" }
    ]),
    AI_MODELS_JSON: JSON.stringify([
      {
        id: "priced", provider: "alt", upstreamModel: "priced-1",
        capabilities: ["text", "json", "tools", "stream"],
        pricing: { currency: "CNY", inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }
      }
    ]),
    AI_TASK_ROUTES_JSON: JSON.stringify({ "intake.extract": "priced" })
  });
  const route = resolveTask(config.registry, "intake.extract")[0];
  const meta = responseMeta(route, {
    prompt_tokens: 1000,
    completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 200 }
  });
  assert.equal(meta.cost.amount, 0.0057);
});

