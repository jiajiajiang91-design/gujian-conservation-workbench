import { describe, expect, it } from "vitest";

import { ActionLedger } from "./action-ledger.js";
import { AssistantRuntime } from "./assistant-routes.js";
import { ConfirmationTokenStore } from "./capability-tokens.js";

const SNAPSHOT_FULL = {
  projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
  currentStage: "objects",
  openDockItems: 0,
  componentCount: 42,
  hasGeometryRevision: true,
  hasDrawings: true,
  hasDeliverable: true,
  modelRouteAvailable: true,
};

function fakeGateway(reply: { name: string; args: unknown } | { text: string }) {
  return {
    configured: true,
    executeWithTools: async () =>
      "text" in reply
        ? { kind: "text" as const, content: reply.text, raw: "raw-text" }
        : { kind: "tool_call" as const, name: reply.name, argumentsJson: JSON.stringify(reply.args), raw: "raw-tool" },
  };
}

function runtime(reply: Parameters<typeof fakeGateway>[0]) {
  return new AssistantRuntime({
    gateway: fakeGateway(reply),
    ledger: new ActionLedger(":memory:"),
    tokens: new ConfirmationTokenStore(),
  });
}

const turnBody = (text: string, snapshot: object = SNAPSHOT_FULL) => ({
  turnId: crypto.randomUUID(),
  text,
  snapshot,
});

async function collect(run: (emit: (e: Record<string, unknown>) => void) => Promise<void>) {
  const events: Array<Record<string, unknown>> = [];
  await run((event) => events.push(event));
  return events;
}

describe("助手回合", () => {
  it("直接执行类动作下发 clientOp", async () => {
    const rt = runtime({ name: "switch_view", args: { view: "构件清单" } });
    const events = await collect((emit) =>
      rt.handleTurn(turnBody("看构件"), "s1", emit, new AbortController().signal),
    );
    const action = events.find((e) => e.type === "action");
    expect(action).toMatchObject({ actionName: "switch_view", clientOp: "ui:switch-view" });
    expect(rt.ledger.verifyChains()).toBe(true);
  });

  it("前置不满足时拒绝并说明，不下发动作", async () => {
    const rt = runtime({ name: "generate_drawings", args: {} });
    const events = await collect((emit) =>
      rt.handleTurn(turnBody("出图", { ...SNAPSHOT_FULL, hasGeometryRevision: false }), "s1", emit, new AbortController().signal),
    );
    const failed = events.find((e) => e.type === "failed");
    expect(String(failed?.text)).toContain("先生成三维模型");
    expect(events.some((e) => e.type === "action")).toBe(false);
  });

  it("高成本动作走询问，允许一次后才下发，留痕成对", async () => {
    const rt = runtime({ name: "generate_geometry", args: {} });
    const turnEvents = await collect((emit) =>
      rt.handleTurn(turnBody("生成三维"), "s1", emit, new AbortController().signal),
    );
    const ask = turnEvents.find((e) => e.type === "ask");
    expect(ask).toBeTruthy();
    expect(turnEvents.some((e) => e.type === "action")).toBe(false);

    const confirmEvents = await collect((emit) =>
      rt.handleConfirm({ confirmToken: ask?.confirmToken, decision: "allow_once" }, "s1", emit),
    );
    expect(confirmEvents.find((e) => e.type === "action")).toMatchObject({ clientOp: "job:cad" });
    expect(rt.ledger.orphanAsks()).toHaveLength(0);
  });

  it("拒绝后动作不执行且令牌不可复用", async () => {
    const rt = runtime({ name: "generate_drawings", args: {} });
    const turnEvents = await collect((emit) =>
      rt.handleTurn(turnBody("出图"), "s1", emit, new AbortController().signal),
    );
    const token = turnEvents.find((e) => e.type === "ask")?.confirmToken;
    const denyEvents = await collect((emit) =>
      rt.handleConfirm({ confirmToken: token, decision: "deny" }, "s1", emit),
    );
    expect(String(denyEvents[0]?.text)).toContain("已拒绝");
    const replay = await collect((emit) =>
      rt.handleConfirm({ confirmToken: token, decision: "allow_once" }, "s1", emit),
    );
    expect(replay[0]).toMatchObject({ type: "failed" });
  });

  it("普通导出直接执行，交付级导出需确认", async () => {
    const direct = runtime({ name: "export_deliverable", args: { format: "pdf" } });
    const directEvents = await collect((emit) =>
      direct.handleTurn(turnBody("导出 pdf"), "s1", emit, new AbortController().signal),
    );
    expect(directEvents.some((e) => e.type === "action")).toBe(true);

    const gated = runtime({ name: "export_deliverable", args: { format: "zip" } });
    const gatedEvents = await collect((emit) =>
      gated.handleTurn(turnBody("组交付包"), "s1", emit, new AbortController().signal),
    );
    expect(gatedEvents.some((e) => e.type === "ask")).toBe(true);
  });

  it("模型文本回复透传为回答", async () => {
    const rt = runtime({ text: "泥道栱是坐于栌斗的横栱" });
    const events = await collect((emit) =>
      rt.handleTurn(turnBody("泥道栱是什么"), "s1", emit, new AbortController().signal),
    );
    expect(events.find((e) => e.type === "answer")).toMatchObject({ text: "泥道栱是坐于栌斗的横栱" });
  });

  it("模型不可用时关键词路径仍可执行明确指令", async () => {
    const rt = new AssistantRuntime({
      gateway: { configured: false, executeWithTools: async () => { throw new Error("unreachable"); } },
      ledger: new ActionLedger(":memory:"),
      tokens: new ConfirmationTokenStore(),
    });
    const events = await collect((emit) =>
      rt.handleTurn(turnBody("切到实测基准", { ...SNAPSHOT_FULL, modelRouteAvailable: false }), "s1", emit, new AbortController().signal),
    );
    expect(events.find((e) => e.type === "action")).toMatchObject({
      actionName: "switch_view",
      args: { view: "实测基准" },
    });
  });

  it("重启后的孤儿询问按通道不可用补决定", async () => {
    const ledger = new ActionLedger(":memory:");
    const rt = new AssistantRuntime({ gateway: fakeGateway({ name: "generate_geometry", args: {} }), ledger, tokens: new ConfirmationTokenStore() });
    await collect((emit) => rt.handleTurn(turnBody("生成三维"), "s1", emit, new AbortController().signal));
    expect(ledger.orphanAsks()).toHaveLength(1);
    expect(rt.reconcileOrphanAsks()).toBe(1);
    expect(ledger.orphanAsks()).toHaveLength(0);
  });
});
