function endpoint(provider) {
  const base = String(provider.baseUrl || "").replace(/\/$/, "");
  if (!/^https:\/\//i.test(base) && !/^http:\/\/127\.0\.0\.1(?::\d+)?/i.test(base)) {
    throw new Error("供应商地址必须使用 HTTPS");
  }
  return /\/chat\/completions$/i.test(base) ? base : base + "/chat/completions";
}

export function buildOpenAIChatBody(request, route, limits) {
  const { task, model } = route;
  const policy = model.policy || {};
  const requested = Number.parseInt(request.max_tokens, 10);
  const maxTokens = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : task.maxTokens,
    task.maxTokens,
    policy.maxTokens || limits.maxTokens,
    limits.maxTokens
  );
  const body = {
    model: model.upstreamModel,
    messages: request.messages,
    max_tokens: maxTokens,
    stream: Boolean(task.stream && request.stream)
  };
  if (policy.temperature !== false && Number.isFinite(task.temperature)) body.temperature = task.temperature;
  if (body.stream && policy.streamOptions !== false) body.stream_options = { include_usage: true };
  if (task.json && policy.responseFormat !== false) body.response_format = { type: "json_object" };
  if (policy.thinking) body.thinking = policy.thinking;
  if (task.tools && Array.isArray(request.tools)) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  return body;
}

async function send(body, route, signal) {
  return fetch(endpoint(route.provider), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + route.apiKey
    },
    body: JSON.stringify(body),
    signal
  });
}

export async function callOpenAIChat(request, route, limits, signal) {
  let body = buildOpenAIChatBody(request, route, limits);
  let response = await send(body, route, signal);
  if (response.ok) return response;

  const detail = await response.clone().text();
  const remove = [];
  if (/temperature/i.test(detail) && body.temperature != null) remove.push("temperature");
  if (/stream_options/i.test(detail) && body.stream_options) remove.push("stream_options");
  if (/response_format|json_object/i.test(detail) && body.response_format) remove.push("response_format");
  if (!remove.length) return response;

  body = { ...body };
  remove.forEach(key => delete body[key]);
  return send(body, route, signal);
}

