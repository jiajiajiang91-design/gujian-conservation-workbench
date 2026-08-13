import { describe, expect, it, vi } from "vitest";

import { KimiGateway } from "./kimi-gateway.js";

function sseResponse(): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"完成\\","}}]}',
    'data: {"choices":[{"delta":{"content":"\\"findings\\":[],\\"missingInformation\\":[]}"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"cached_tokens":2}}',
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("KimiGateway", () => {
  it("消费官方 SSE 并在可重试错误后受控重试", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(sseResponse());
    const statuses: string[] = [];
    const chunks: string[] = [];
    const gateway = new KimiGateway({ apiKey: "test-key", maxAttempts: 2, fetchImpl });
    const result = await gateway.execute({
      userContent: "测试资料",
      signal: new AbortController().signal,
      onStatus: (type) => statuses.push(type),
      onChunk: (content) => chunks.push(content),
    });
    expect(statuses).toEqual(["running", "retrying"]);
    expect(chunks.join("")).toContain('"summary":"完成"');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18, cachedTokens: 2 });
    expect(result.attempt).toBe(2);
  });

  it("超时后重试并给出稳定错误码", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const statuses: string[] = [];
    const gateway = new KimiGateway({ apiKey: "test-key", timeoutMs: 5, maxAttempts: 2, fetchImpl });
    await expect(gateway.execute({
      userContent: "测试资料",
      signal: new AbortController().signal,
      onStatus: (type) => statuses.push(type),
      onChunk: () => undefined,
    })).rejects.toThrow("KIMI_TIMEOUT");
    expect(statuses).toEqual(["running", "retrying"]);
  });
});
