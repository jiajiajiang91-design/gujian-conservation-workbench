import { describe, expect, it } from "vitest";

import { KimiGateway } from "../kimi-gateway.js";
import { modelFacingCatalog } from "./action-catalog.js";

function fakeFetch(payload: unknown): { impl: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return { impl, bodies };
}

const gateway = (impl: typeof fetch) =>
  new KimiGateway({ apiKey: "test-key", fetchImpl: impl, maxAttempts: 1 });

describe("executeWithTools", () => {
  it("解析工具调用并保留原文", async () => {
    const { impl } = fakeFetch({
      choices: [{ message: { tool_calls: [{ function: { name: "switch_view", arguments: '{"view":"构件清单"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const result = await gateway(impl).executeWithTools({
      systemPrompt: "sys",
      userContent: "看构件",
      tools: modelFacingCatalog(),
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("tool_call");
    if (result.kind === "tool_call") {
      expect(result.name).toBe("switch_view");
      expect(JSON.parse(result.argumentsJson)).toEqual({ view: "构件清单" });
      expect(result.raw).toContain("tool_calls");
      expect(result.usage.totalTokens).toBe(15);
    }
  });

  it("无工具调用时返回文本", async () => {
    const { impl } = fakeFetch({ choices: [{ message: { content: "泥道栱是横向的栱" } }] });
    const result = await gateway(impl).executeWithTools({
      systemPrompt: "sys", userContent: "泥道栱是什么", tools: modelFacingCatalog(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: "text", content: "泥道栱是横向的栱" });
  });

  it("请求体的每个工具只含名称、描述、参数三字段（执行字段不泄入模型请求）", async () => {
    const { impl, bodies } = fakeFetch({ choices: [{ message: { content: "好的" } }] });
    await gateway(impl).executeWithTools({
      systemPrompt: "sys", userContent: "你好", tools: modelFacingCatalog(),
      signal: new AbortController().signal,
    });
    const body = bodies[0] as { tools: Array<{ type: string; function: Record<string, unknown> }> };
    expect(body.tools).toHaveLength(14);
    for (const tool of body.tools) {
      expect(tool.type).toBe("function");
      expect(Object.keys(tool.function).sort()).toEqual(["description", "name", "parameters"]);
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("confirmLevel");
    expect(serialized).not.toContain("preconditionCode");
    expect(serialized).not.toContain("costly");
  });
});
