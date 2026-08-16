import { describe, expect, it } from "vitest";
import type { ProjectHead } from "@gujian/application";

import {
  AssistantExecutors,
  buildCommitFactsCommand,
  buildModificationProposal,
} from "./action-executors.js";
import { readSseStream } from "./sse.js";
import { checkModification } from "./value-check.js";
import { ALL_VIEW_MAPPINGS, resolveView } from "./view-map.js";
import { buildWorkspaceSnapshot } from "./workspace-snapshot.js";

// 测试仅依赖 projectId 与 revisionId 两个字段，其余 ProjectHead 字段用类型断言略过
const HEAD = {
  projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
  revisionId: "9f8e7d6c-5b4a-4392-8170-fedcba987654",
} as unknown as ProjectHead;

describe("视图映射", () => {
  it("八个设计视图全部有映射，未实现的带说明", () => {
    expect(ALL_VIEW_MAPPINGS).toHaveLength(8);
    for (const mapping of ALL_VIEW_MAPPINGS) {
      expect(mapping.stageId.length).toBeGreaterThan(0);
      if (!mapping.implemented) expect(mapping.noteZh).toBeTruthy();
    }
    expect(resolveView("现状记录")?.implemented).toBe(false);
    expect(resolveView("不存在")).toBeNull();
  });
});

describe("数值合理性核查（五条规则）", () => {
  const measurements = [
    { part: "檐柱高", valueMm: 3950, measured: true },
    { part: "通面阔", valueMm: 15800, measured: true },
  ];

  it("幅度超限", () => {
    const warnings = checkModification(
      { subjectName: "檐柱", field: "高", oldValueText: "5200", newValueText: "1200" },
      measurements,
    );
    expect(warnings.some((w) => w.includes("幅度较大"))).toBe(true);
  });

  it("檐口高不大于檐柱高", () => {
    const warnings = checkModification(
      { subjectName: "屋面", field: "檐口高", oldValueText: "5200", newValueText: "3900" },
      measurements,
    );
    expect(warnings.some((w) => w.includes("几何上不成立"))).toBe(true);
  });

  it("台基高不应达到檐柱高", () => {
    const warnings = checkModification(
      { subjectName: "台基", field: "高", oldValueText: "2500", newValueText: "3950" },
      measurements,
    );
    expect(warnings.some((w) => w.includes("台基高不应达到"))).toBe(true);
  });

  it("去估算标记需实测支持", () => {
    const warnings = checkModification(
      { subjectName: "金柱", field: "高", oldValueText: "4300（估）", newValueText: "4310" },
      measurements,
    );
    expect(warnings.some((w) => w.includes("估算标记"))).toBe(true);
  });

  it("同数不同部位提示张冠李戴", () => {
    const warnings = checkModification(
      { subjectName: "台基", field: "宽", oldValueText: "12000", newValueText: "15800" },
      measurements,
    );
    expect(warnings.some((w) => w.includes("通面阔"))).toBe(true);
  });

  it("正常修改无警示", () => {
    const warnings = checkModification(
      { subjectName: "檐柱", field: "径", oldValueText: "300", newValueText: "320" },
      measurements,
    );
    expect(warnings).toHaveLength(0);
  });
});

describe("快照构造", () => {
  it("计数转有无标记", () => {
    const snapshot = buildWorkspaceSnapshot({
      projectId: HEAD.projectId, currentStage: "objects", openIssueCount: 2, entityCount: 42,
      geometryRevisionCount: 1, artifactCount: 0, deliveryCount: 0, serverModelConfigured: true,
      unparsedEvidenceCount: 3,
    });
    expect(snapshot).toMatchObject({
      openDockItems: 2, componentCount: 42,
      hasGeometryRevision: true, hasDrawings: false, hasDeliverable: false,
      unparsedEvidenceCount: 3,
    });
  });
});

describe("动作执行体", () => {
  const deps = (executed: unknown[]) => ({
    commands: { execute: async (c: unknown) => { executed.push(c); return {}; } },
    workflow: { evaluate: async () => { executed.push("evaluate"); return {}; } },
    actorId: () => "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  });

  it("切换视图返回界面意图，未实现视图带说明", () => {
    const executors = new AssistantExecutors(deps([]));
    const outcome = executors.switchView("现状记录");
    expect(outcome.kind).toBe("ui");
    if (outcome.kind === "ui") {
      expect(outcome.intent).toMatchObject({ op: "switchStage", stageId: "objects" });
      expect(outcome.messageZh).toContain("尚未实现");
    }
  });

  it("推进流程在停靠未清时拒绝并说明", () => {
    const executors = new AssistantExecutors(deps([]));
    const blocked = executors.advanceWorkflow(2);
    expect(blocked).toMatchObject({ kind: "rejected" });
    if (blocked.kind === "rejected") expect(blocked.reasonZh).toContain("2");
    expect(executors.advanceWorkflow(0).kind).toBe("ui");
  });

  it("定位证据命中与未命中", () => {
    const executors = new AssistantExecutors(deps([]));
    expect(executors.locateEvidence("P48", ["entity:P48", "entity:P07"]).kind).toBe("ui");
    expect(executors.locateEvidence("不存在", ["entity:P48"]).kind).toBe("rejected");
  });

  it("确认后的修改经 CommitFacts 落库且命令通过应用层契约校验", async () => {
    const executed: unknown[] = [];
    const executors = new AssistantExecutors(deps(executed));
    const proposal = buildModificationProposal({
      subjectRef: "entity:P48", subjectName: "雀替", field: "长",
      oldValueText: "600（估）", newValueText: "620", value: { lengthMm: 620 },
      rationaleZh: "按对称构件推算", modelRunId: "1b671a64-40d5-491e-99b0-da01ff1f3341",
      measurements: [],
    });
    const outcome = await executors.commitConfirmedModification(HEAD, proposal);
    expect(outcome.kind).toBe("committed");
    expect(executed).toHaveLength(1);

    const { CommitFactsCommandSchema } = await import("@gujian/application");
    const parsed = CommitFactsCommandSchema.safeParse(executed[0]);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      const fact = parsed.data.payload.facts[0];
      expect(fact?.producer.producerType).toBe("model");
      expect(fact?.reviewStatus).toBe("confirmed");
      expect(fact?.acceptanceRef?.type).toBe("command");
    }
  });

  it("无模型来源时生产者为 human 且引用本命令", () => {
    const command = buildCommitFactsCommand({
      head: HEAD,
      actorId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      proposal: buildModificationProposal({
        subjectRef: "entity:P07", subjectName: "台基", field: "高",
        oldValueText: "850", newValueText: "860", value: { heightMm: 860 },
        rationaleZh: "现场复核", modelRunId: null, measurements: [],
      }),
    }) as { commandId: string; payload: { facts: Array<{ producer: { producerType: string; actionRef?: { commandId: string } } }> } };
    const producer = command.payload.facts[0]?.producer;
    expect(producer?.producerType).toBe("human");
    expect(producer?.actionRef?.commandId).toBe(command.commandId);
  });

  it("运行数据检查走 workflow.evaluate", async () => {
    const executed: unknown[] = [];
    const executors = new AssistantExecutors(deps(executed));
    const outcome = await executors.runDataCheck(HEAD);
    expect(outcome.kind).toBe("committed");
    expect(executed).toContain("evaluate");
  });
});

describe("SSE 读取", () => {
  it("解析多行 data 帧", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"progress","n":1}\n\ndata: {"type":"answer","n":2}\n\n'));
        controller.close();
      },
    });
    const events: unknown[] = [];
    await readSseStream(new Response(body), (event) => events.push(event));
    expect(events).toEqual([{ type: "progress", n: 1 }, { type: "answer", n: 2 }]);
  });
});
