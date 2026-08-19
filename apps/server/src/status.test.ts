import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkbenchServer, type ModelGateway } from "./index.js";
import type { GatewayResult } from "./kimi-gateway.js";
import { ModelRunLedger } from "./model-ledger.js";

const openServers: Array<{ close: () => Promise<void>; ledger: ModelRunLedger }> = [];

afterEach(async () => {
  for (const current of openServers.splice(0)) {
    await current.close();
    current.ledger.close();
  }
});

async function start(gateway: ModelGateway) {
  const ledger = new ModelRunLedger(":memory:");
  const server = createWorkbenchServer({ gateway, ledger });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  openServers.push({ close, ledger });
  return { baseUrl: `http://127.0.0.1:${address.port}`, ledger };
}

async function session(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/session`);
  const body = await response.json() as { csrfToken: string; capabilityToken: string };
  return { ...body, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

function runBody() {
  return {
    runId: crypto.randomUUID(),
    clientRequestId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    projectRevisionId: crypto.randomUUID(),
    taskType: "evidence-summary",
    evidences: [{ evidenceId: crypto.randomUUID(), assetSha256: "a".repeat(64), text: "团队演示资料：正立面照片一张，未提供现场尺寸。" }],
  } as const;
}

describe("workbench server", () => {
  it("只在 loopback 地址提供无密钥状态", async () => {
    const gateway: ModelGateway = {
      configured: false,
      model: "kimi-k2.6",
      execute: async () => { throw new Error("not called"); },
    };
    const { baseUrl } = await start(gateway);
    const response = await fetch(`${baseUrl}/api/status`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: "gujian-workbench-server",
      model: "kimi-k2.6",
      modelConfigured: false,
      projectStorage: "browser-indexeddb-v3",
    });
  });

  it("校验会话、一次性能力令牌并持久化成功流", async () => {
    const gateway: ModelGateway = {
      configured: true,
      model: "kimi-k2.6",
      async execute(input): Promise<GatewayResult> {
        input.onStatus("running", 1, null);
        input.onChunk("{\"summary\":\"资料摘要\",", 1);
        input.onChunk("\"findings\":[],\"missingInformation\":[\"缺少尺寸\"]}", 1);
        return {
          content: "{\"summary\":\"资料摘要\",\"findings\":[],\"missingInformation\":[\"缺少尺寸\"]}",
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18, cachedTokens: 0 },
          attempt: 1,
        };
      },
    };
    const { baseUrl, ledger } = await start(gateway);
    const credentials = await session(baseUrl);
    const body = runBody();
    const response = await fetch(`${baseUrl}/api/model-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: credentials.cookie,
        "x-csrf-token": credentials.csrfToken,
        "x-capability-token": credentials.capabilityToken,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"type":"succeeded"');
    expect(ledger.read(body.runId)?.events.map((event) => event.eventType)).toEqual([
      "queued", "running", "stream", "stream", "succeeded",
    ]);

    const replay = await fetch(`${baseUrl}/api/model-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: credentials.cookie,
        "x-csrf-token": credentials.csrfToken,
        "x-capability-token": credentials.capabilityToken,
      },
      body: JSON.stringify({ ...runBody(), runId: crypto.randomUUID() }),
    });
    expect(replay.status).toBe(403);
  });

  it("助手目录只返回名称、描述与参数，且需要会话", async () => {
    const gateway: ModelGateway = {
      configured: false,
      model: "kimi-k2.6",
      execute: async () => { throw new Error("not called"); },
    };
    const { baseUrl } = await start(gateway);

    // 无会话不得枚举动作清单
    expect((await fetch(`${baseUrl}/api/assistant/catalog`)).status).toBe(403);

    const credentials = await session(baseUrl);
    const response = await fetch(`${baseUrl}/api/assistant/catalog`, {
      headers: { cookie: credentials.cookie, "x-csrf-token": credentials.csrfToken },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { actions: Array<Record<string, unknown>> };
    expect(body.actions).toHaveLength(14);
    expect(body.actions.map((action) => action.name)).toContain("switch_view");
    for (const action of body.actions) {
      expect(Object.keys(action).sort()).toEqual(["description", "name", "parameters"]);
    }
  });

  it("取消后隔离迟到输出", async () => {
    let release!: (value: GatewayResult) => void;
    let callbacks!: Parameters<ModelGateway["execute"]>[0];
    const gateway: ModelGateway = {
      configured: true,
      model: "kimi-k2.6",
      execute(input) {
        callbacks = input;
        input.onStatus("running", 1, null);
        return new Promise((resolve) => { release = resolve; });
      },
    };
    const { baseUrl, ledger } = await start(gateway);
    const credentials = await session(baseUrl);
    const body = runBody();
    const streamRequest = fetch(`${baseUrl}/api/model-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: credentials.cookie,
        "x-csrf-token": credentials.csrfToken,
        "x-capability-token": credentials.capabilityToken,
      },
      body: JSON.stringify(body),
    });
    const streamResponse = await streamRequest;
    const cancelled = await fetch(`${baseUrl}/api/model-runs/${body.runId}`, {
      method: "DELETE",
      headers: { cookie: credentials.cookie, "x-csrf-token": credentials.csrfToken },
    });
    expect(cancelled.status).toBe(200);
    callbacks.onChunk("迟到内容", 1);
    release({
      content: "迟到完整内容",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 },
      attempt: 1,
    });
    await streamResponse.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ledger.read(body.runId)?.events.map((event) => event.eventType)).toEqual([
      "queued", "running", "cancelled", "late",
    ]);
    expect(ledger.read(body.runId)?.run.status).toBe("cancelled");
  });
});

// 预览默认打开 localhost，服务端此前只认 127.0.0.1，助手在那个地址下静默不可用。
describe("允许来源", () => {
  it("两个回环地址都接受，其他来源仍拒绝", async () => {
    const gateway: ModelGateway = {
      configured: false, model: "kimi-k2.6",
      execute: async () => { throw new Error("not called"); },
    };
    const { baseUrl } = await start(gateway);
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173"]) {
      const response = await fetch(`${baseUrl}/api/session`, { headers: { origin } });
      expect(response.status, origin).toBe(200);
      expect(response.headers.get("access-control-allow-origin"), origin).toBe(origin);
    }
    const rejected = await fetch(`${baseUrl}/api/session`, { headers: { origin: "http://evil.example" } });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
  });
});
