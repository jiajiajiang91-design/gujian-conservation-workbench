import { forwardToModel, getProxyConfig, jsonPayloadWithMeta, validateBody } from "../server/proxy-core.mjs";

const config = getProxyConfig();
const request = validateBody({
  task_id: "service.health",
  messages: [{ role: "user", content: "Reply with exactly: OK" }]
}, config);
const result = await forwardToModel(request, config);
const payload = await jsonPayloadWithMeta(result);

if (!result.response.ok) {
  console.error(JSON.stringify({
    ok: false,
    status: result.response.status,
    provider: result.route.provider.id,
    model: result.route.model.id,
    detail: payload.text.slice(0, 500)
  }));
  process.exitCode = 1;
} else {
  const data = JSON.parse(payload.text);
  console.log(JSON.stringify({
    ok: true,
    text: data.choices?.[0]?.message?.content || "",
    task: data.gujian_meta.taskId,
    provider: data.gujian_meta.provider,
    model: data.gujian_meta.model,
    usage: data.gujian_meta.usage,
    cost: data.gujian_meta.cost
  }));
}
