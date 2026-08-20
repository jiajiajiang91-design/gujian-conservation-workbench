import { describe, expect, it } from "vitest";
import type { ProjectHead } from "@gujian/application";
import { ALL_SWITCHABLE_VIEW_NAMES } from "@gujian/domain";

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
  // 采纳建议时要看这条建议指的是不是某个构件记录，指向构件就同步改那条记录
  snapshot: { entities: [] },
} as unknown as ProjectHead;

const DESIGN_VIEWS = [...ALL_SWITCHABLE_VIEW_NAMES];

describe("视图映射", () => {
  it("设计视图全部有映射，未实现的带说明", () => {
    expect(ALL_VIEW_MAPPINGS.map((mapping) => mapping.view)).toEqual(DESIGN_VIEWS);
    for (const mapping of ALL_VIEW_MAPPINGS) {
      if (mapping.kind === "stage") expect(mapping.stageId.length).toBeGreaterThan(0);
      if (!mapping.implemented) expect(mapping.noteZh).toBeTruthy();
    }
    expect(resolveView("不存在")).toBeNull();
  });

  it("映射指向工作台实际存在的视图", () => {
    // stage 标识与 App.tsx 的 stages 常量保持一致，避免助手切到不存在的视图
    const stageIds = new Set([
      "tasks", "evidence", "measurements", "objects", "conditions", "issues",
      "geometry", "sheetStyle", "drawings", "checks", "package", "candidates",
    ]);
    for (const mapping of ALL_VIEW_MAPPINGS) {
      if (mapping.kind !== "stage") continue;
      expect(stageIds.has(mapping.stageId), `${mapping.view} 指向未知视图 ${mapping.stageId}`).toBe(true);
    }
  });

  // 项目列表是退出当前项目，不是切 stage。塞一个假 stage 标识会让消费方猜。
  it("项目列表是退出项目而不是切换视图", () => {
    const mapping = resolveView("项目列表");
    expect(mapping?.kind).toBe("exitProject");
    expect(mapping).not.toHaveProperty("stageId");
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
      unparsedEvidenceCount: 3, hasImageSelection: false,
    });
    expect(snapshot).toMatchObject({
      openDockItems: 2, componentCount: 42,
      hasGeometryRevision: true, hasDrawings: false, hasDeliverable: false,
      unparsedEvidenceCount: 3, hasImageSelection: false,
    });
  });
});

describe("动作执行体", () => {
  const deps = (executed: unknown[]) => ({
    commands: { execute: async (c: unknown) => { executed.push(c); return {}; } },
    workflow: { evaluate: async () => { executed.push("evaluate"); return {}; } },
    actorId: () => "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  });

  it("切换视图返回界面意图", () => {
    const executors = new AssistantExecutors(deps([]));
    const outcome = executors.switchView("现状记录");
    expect(outcome.kind).toBe("ui");
    if (outcome.kind === "ui") {
      expect(outcome.intent).toMatchObject({ op: "switchStage", stageId: "conditions" });
    }
  });

  it("目录外的视图名不切换并说明", () => {
    const executors = new AssistantExecutors(deps([]));
    const outcome = executors.switchView("不存在的视图");
    expect(outcome.kind).not.toBe("ui");
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

  // 采纳指向构件的建议要写两条命令：事实与构件记录。第二条的版本号必须取
  // 第一条回执里的新版本，拿旧版本会撞乐观并发，表现是采纳了但记录没变，
  // 界面上看不出失败，只有翻库才发现。
  it("采纳指向构件的建议时同步改记录，版本号接上一条回执", async () => {
    const executed: { commandType: string; expectedRevisionId: string; payload: Record<string, unknown> }[] = [];
    const entityId = "5c2f1a3b-9d84-4f6e-a1b7-2c3d4e5f6a7b";
    const executors = new AssistantExecutors({
      commands: {
        execute: async (c: unknown) => {
          executed.push(c as typeof executed[number]);
          return { revisionId: `rev-${executed.length}` };
        },
      },
      workflow: { evaluate: async () => ({}) },
      actorId: () => "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    } as unknown as ConstructorParameters<typeof AssistantExecutors>[0]);

    const head = {
      projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
      revisionId: "rev-0",
      snapshot: {
        entities: [{
          id: entityId, projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
          buildingId: "8f14e45f-ceea-4d4e-9f4a-9b1c8d2e3f40", parentId: null,
          entityType: "待确认", name: "雀替", locationText: null,
        }],
      },
    } as unknown as ProjectHead;

    const proposal = buildModificationProposal({
      subjectRef: entityId, subjectName: "雀替", field: "entityType",
      oldValueText: "待确认", newValueText: "撑栱", value: "撑栱",
      rationaleZh: "用户框选并说明", modelRunId: null, measurements: [],
    });

    const outcome = await executors.commitConfirmedModification(head, proposal);
    expect(outcome.kind).toBe("committed");
    expect(executed.map((c) => c.commandType)).toEqual(["CommitFacts", "ReviseEntities"]);
    expect(executed[1]!.expectedRevisionId).toBe("rev-1");
    expect((executed[1]!.payload.entities as { entityType: string }[])[0]!.entityType).toBe("撑栱");
  });

  // 位置与位置说明分开存，只改一个就会出现记录说 30%、65%，同一行的说明写着
  // 20%、55%，读的人不知道该信哪个。实测里出现过一次。
  it("位置调整同时改位置与位置说明", async () => {
    const executed: { commandType: string; payload: Record<string, unknown> }[] = [];
    const entityId = "5c2f1a3b-9d84-4f6e-a1b7-2c3d4e5f6a7b";
    const evidenceId = "6d3e2b4c-ae95-4a7f-b2c8-3d4e5f6a7b8c";
    const executors = new AssistantExecutors({
      commands: { execute: async (c: unknown) => { executed.push(c as typeof executed[number]); return { revisionId: "rev-1" }; } },
      workflow: { evaluate: async () => ({}) },
      actorId: () => "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    } as unknown as ConstructorParameters<typeof AssistantExecutors>[0]);

    const head = {
      projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
      revisionId: "rev-0",
      snapshot: {
        evidences: [{ id: evidenceId, title: "现场照片：馆内现状" }],
        entities: [{
          id: entityId, projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
          buildingId: "8f14e45f-ceea-4d4e-9f4a-9b1c8d2e3f40", parentId: null,
          entityType: "待确认", name: "雀替",
          locationText: "现场照片：馆内现状 上 20.0%、55.0% 起，宽 16.0%、高 25.0%",
          imageRegion: { evidenceRef: evidenceId, x: 0.2, y: 0.55, width: 0.16, height: 0.25 },
        }],
      },
    } as unknown as ProjectHead;

    const moved = { evidenceRef: evidenceId, x: 0.3, y: 0.65, width: 0.16, height: 0.23 };
    await executors.commitConfirmedModification(head, buildModificationProposal({
      subjectRef: entityId, subjectName: "雀替", field: "imageRegion",
      oldValueText: "旧位置", newValueText: "新位置", value: moved,
      rationaleZh: "用户框选并说明", modelRunId: null, measurements: [],
    }));

    const revised = (executed.find((c) => c.commandType === "ReviseEntities")!.payload.entities as {
      imageRegion: { x: number }; locationText: string;
    }[])[0]!;
    expect(revised.imageRegion.x).toBe(0.3);
    expect(revised.locationText).toBe("现场照片：馆内现状 上 30.0%、65.0% 起，宽 16.0%、高 23.0%");
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

describe("退出当前项目", () => {
  it("助手说回到项目列表时产出退出意图，不产出切换 stage", () => {
    const executors = new AssistantExecutors({
      commands: {} as never, workflow: {} as never, actorId: () => HEAD.projectId,
    });
    const outcome = executors.switchView("项目列表");
    expect(outcome.kind).toBe("ui");
    if (outcome.kind === "ui") {
      expect(outcome.intent).toEqual({ op: "exitProject" });
      expect(outcome.messageZh).toContain("项目列表");
    }
  });
});
