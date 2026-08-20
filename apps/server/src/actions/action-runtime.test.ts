import { describe, expect, it } from "vitest";

import { ActionLedger } from "./action-ledger.js";
import { ConfirmationTokenStore } from "./capability-tokens.js";
import { evaluatePrecondition, KNOWN_PRECONDITION_CODES } from "./preconditions.js";
import { WorkspaceSnapshotSchema } from "./snapshot-types.js";

describe("前置条件求值", () => {
  it("空快照下所有条件按不满足处理（fail-closed）", () => {
    for (const code of KNOWN_PRECONDITION_CODES) {
      const result = evaluatePrecondition(code, {});
      expect(result.satisfied, code).toBe(false);
    }
  });

  it("满足条件的快照逐项通过", () => {
    const snapshot = WorkspaceSnapshotSchema.parse({
      projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
      currentStage: "objects",
      openDockItems: 0,
      componentCount: 42,
      hasGeometryRevision: true,
      hasDrawings: true,
      hasDeliverable: true,
      modelRouteAvailable: true,
      unparsedEvidenceCount: 3,
      hasImageSelection: true,
    });
    for (const code of KNOWN_PRECONDITION_CODES) {
      expect(evaluatePrecondition(code, snapshot).satisfied, code).toBe(true);
    }
  });

  it("空前置码直接通过，未知码拒绝", () => {
    expect(evaluatePrecondition(null, {}).satisfied).toBe(true);
    expect(evaluatePrecondition("NOT_A_CODE", {}).satisfied).toBe(false);
  });

  it("停靠未清时拒绝并说明数量", () => {
    const result = evaluatePrecondition("STAGE_CLEAR", { openDockItems: 3 });
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) expect(result.reasonZh).toContain("3");
  });
});

describe("确认令牌", () => {
  it("兑付一次后销毁，重复兑付拒绝", () => {
    const store = new ConfirmationTokenStore();
    const token = store.issue({ confirmId: "c1", actionName: "generate_geometry", argsHash: "h" });
    const first = store.redeem(token);
    expect(first.ok).toBe(true);
    expect(store.redeem(token)).toMatchObject({ ok: false, code: "TOKEN_UNKNOWN" });
  });

  it("过期令牌拒绝", () => {
    let now = 0;
    const store = new ConfirmationTokenStore({ ttlMs: 1000, now: () => now });
    const token = store.issue({ confirmId: "c2", actionName: "generate_drawings", argsHash: "h" });
    now = 2000;
    expect(store.redeem(token)).toMatchObject({ ok: false, code: "TOKEN_EXPIRED" });
  });

  it("撤回后令牌失效", () => {
    const store = new ConfirmationTokenStore();
    const token = store.issue({ confirmId: "c3", actionName: "export_deliverable", argsHash: "h" });
    store.withdraw("c3");
    expect(store.redeem(token)).toMatchObject({ ok: false, code: "TOKEN_UNKNOWN" });
  });
});

describe("动作账本", () => {
  it("调用链哈希连续，模型原文落库", () => {
    const ledger = new ActionLedger(":memory:");
    ledger.recordInvocation({ sessionRef: "s1", actionName: "switch_view", argsHash: "a", source: "model", resultCode: "OK", modelRawOutput: "{raw1}" });
    ledger.recordInvocation({ sessionRef: "s1", actionName: "advance_workflow", argsHash: "b", source: "keyword", resultCode: "OK", modelRawOutput: null });
    expect(ledger.verifyChains()).toBe(true);
    ledger.close();
  });

  it("询问与决定成对，孤儿询问可检测", () => {
    const ledger = new ActionLedger(":memory:");
    ledger.recordAsk("c1", "generate_geometry", "h1");
    ledger.recordAsk("c2", "generate_drawings", "h2");
    ledger.recordDecision("c1", "allow_once", "generate_geometry", "h1");
    const orphans = ledger.orphanAsks();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.confirmId).toBe("c2");
    ledger.recordDecision("c2", "channel_unavailable", "generate_drawings", "h2");
    expect(ledger.orphanAsks()).toHaveLength(0);
    expect(ledger.verifyChains()).toBe(true);
    ledger.close();
  });

  it("同一确认号重复决定被唯一约束拒绝", () => {
    const ledger = new ActionLedger(":memory:");
    ledger.recordAsk("c1", "generate_geometry", "h1");
    ledger.recordDecision("c1", "deny", "generate_geometry", "h1");
    expect(() => ledger.recordDecision("c1", "allow_once", "generate_geometry", "h1")).toThrow();
    ledger.close();
  });
});
