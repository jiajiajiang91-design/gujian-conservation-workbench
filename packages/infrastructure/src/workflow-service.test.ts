import "fake-indexeddb/auto";

import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import { describe, expect, it } from "vitest";

import { IndexedDbProjectRepository, LocalAuthorization, openWorkbenchDatabase } from "./indexeddb-project-repository.js";
import { ProjectPackageService } from "./project-package-service.js";
import { WorkflowService } from "./workflow-service.js";

async function setup() {
  const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(`gujian-workflow-${crypto.randomUUID()}`));
  const commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
  const workflow = new WorkflowService(repository);
  const projectId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  const now = "2026-08-13T12:00:00Z";
  await commands.execute({
    commandType: "CreateProject",
    commandId: crypto.randomUUID(), projectId, actorId, expectedRevisionId: null, issuedAt: now,
    payload: {
      project: { id: projectId, name: "工作流测试", status: "active", locationText: null, createdAt: now },
      building: { id: crypto.randomUUID(), projectId, name: "正殿", periodText: null, addressText: null, status: "existing" },
    },
  });
  const head = await repository.getProjectHead(projectId);
  if (!head) throw new Error("missing project");
  return { repository, commands, workflow, projectId, actorId, head };
}

async function addCandidate(commands: ProjectCommandService, head: ProjectHead, actorId: string) {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const events = ["queued", "succeeded"].map((eventType, sequence) => ({
    id: crypto.randomUUID(), runId, sequence, eventType: eventType as "queued" | "succeeded",
    attempt: 1, detail: null, occurredAt: now,
  }));
  const candidateId = crypto.randomUUID();
  await commands.execute({
    commandType: "CommitModelRunResult",
    commandId: crypto.randomUUID(), projectId: head.projectId, actorId,
    expectedRevisionId: head.revisionId, issuedAt: now,
    payload: {
      run: {
        id: runId, projectId: head.projectId, inputRevisionId: head.revisionId,
        inputHash: "a".repeat(64), provider: "moonshot", model: "kimi-k2.6", taskType: "evidence-summary",
        status: "succeeded", evidenceRefs: [], events,
        usage: { promptTokens: 8, completionTokens: 5, totalTokens: 13, cachedTokens: 0 },
        outputHash: "b".repeat(64), startedAt: now, completedAt: now,
      },
      candidate: {
        id: candidateId, projectId: head.projectId, runId, inputRevisionId: head.revisionId,
        taskType: "evidence-summary", contentText: "资料缺少现场尺寸",
        structured: { summary: "资料摘要", findings: ["已有照片"], missingInformation: ["现场尺寸"] },
        producer: { producerType: "model", runId }, evidenceRefs: [], reviewStatus: "unreviewed", createdAt: now,
      },
    },
  });
  return candidateId;
}

describe("WorkflowService", () => {
  it("自动规则直接执行且相同输入不重复写版本", async () => {
    const current = await setup();
    const evaluated = await current.workflow.evaluate(current.head, current.actorId);
    expect(evaluated.snapshot.issues.filter((issue) => issue.status === "open").map((issue) => issue.sourceRef).sort()).toEqual([
      "rule:parsed-evidence-required", "rule:task-setup-required",
    ]);
    const unchanged = await current.workflow.evaluate(evaluated, current.actorId);
    expect(unchanged.revisionId).toBe(evaluated.revisionId);
    expect(await current.repository.getProjectRuleRuns(current.projectId)).toHaveLength(1);
  });

  it("一次任务设置与候选决定均留痕，接受候选不会生成实测事实", async () => {
    const current = await setup();
    let head = await current.workflow.evaluate(current.head, current.actorId);
    head = await current.workflow.confirmTaskSetup(head, current.actorId, {
      taskName: "资料整理与项目包验证",
      scope: ["整理资料", "生成候选"],
      regulationRefs: ["policy:test"],
      deliverables: ["结构化项目包"],
    });
    const candidateId = await addCandidate(current.commands, head, current.actorId);
    head = await current.repository.getProjectHead(current.projectId) as ProjectHead;
    head = await current.workflow.evaluate(head, current.actorId);
    const issue = head.snapshot.issues.find((item) => item.status === "open" && item.sourceRef === "rule:model-candidate-review");
    if (!issue) throw new Error("missing candidate review issue");
    head = await current.workflow.decideCandidate(head, current.actorId, {
      candidateId, issueId: issue.id, outcome: "accepted", reason: null,
    });
    expect(head.snapshot.candidates.find((candidate) => candidate.id === candidateId)?.reviewStatus).toBe("confirmed");
    expect(head.snapshot.facts).toHaveLength(0);
    expect(await current.repository.getProjectDecisions(current.projectId)).toHaveLength(1);
  });

  it("ZIP 回导保留规则运行与人工决定", async () => {
    const current = await setup();
    let head = await current.workflow.evaluate(current.head, current.actorId);
    head = await current.workflow.confirmTaskSetup(head, current.actorId, {
      taskName: "资料整理", scope: ["整理资料"], regulationRefs: [], deliverables: ["项目包"],
    });
    const candidateId = await addCandidate(current.commands, head, current.actorId);
    head = await current.repository.getProjectHead(current.projectId) as ProjectHead;
    head = await current.workflow.evaluate(head, current.actorId);
    const issue = head.snapshot.issues.find((item) => item.status === "open" && item.sourceRef === "rule:model-candidate-review");
    if (!issue) throw new Error("missing issue");
    await current.workflow.decideCandidate(head, current.actorId, { candidateId, issueId: issue.id, outcome: "rejected", reason: "资料依据不足" });
    const packages = new ProjectPackageService(current.repository);
    const zip = await packages.exportZip(current.projectId);
    const expectedRules = (await current.repository.getProjectRuleRuns(current.projectId)).length;
    await current.repository.clearAllData();
    await packages.import(zip, "project.gujian.zip", current.actorId);
    expect(await current.repository.getProjectRuleRuns(current.projectId)).toHaveLength(expectedRules);
    expect(await current.repository.getProjectDecisions(current.projectId)).toHaveLength(1);
  });

  it("按当前项目事实计算尺寸链差值并阻断缺少测量元数据的记录", async () => {
    const current = await setup();
    const commandId = crypto.randomUUID();
    await current.commands.execute({
      commandType: "CommitFacts", commandId, projectId: current.projectId, actorId: current.actorId,
      expectedRevisionId: current.head.revisionId, issuedAt: "2026-08-14T00:00:00Z", payload: { facts: [
        { id: crypto.randomUUID(), subjectRef: current.head.snapshot.buildings[0]!.id, field: "documentedDimension.totalWidthMm", value: 15800, producer: { producerType: "human", actorId: current.actorId, actionRef: { commandId } }, evidenceRefs: ["evidence:dimension-note"], reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available" },
        { id: crypto.randomUUID(), subjectRef: current.head.snapshot.buildings[0]!.id, field: "documentedDimension.segmentWidthsMm", value: [4200, 3600, 3600], producer: { producerType: "human", actorId: current.actorId, actionRef: { commandId } }, evidenceRefs: ["evidence:dimension-note"], reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available" },
        { id: crypto.randomUUID(), subjectRef: current.head.snapshot.buildings[0]!.id, field: "documentedDimension.measurementMetadataComplete", value: false, producer: { producerType: "human", actorId: current.actorId, actionRef: { commandId } }, evidenceRefs: ["evidence:dimension-note"], reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available" },
      ] },
    });
    const head = await current.repository.getProjectHead(current.projectId) as ProjectHead;
    const evaluated = await current.workflow.evaluate(head, current.actorId);
    const descriptions = evaluated.snapshot.issues.filter((item) => item.status === "open").map((item) => item.description);
    expect(descriptions).toContain("资料上的尺寸对不上：总尺寸 15800 mm，各段相加 11400 mm，相差 4400 mm。");
    expect(descriptions).toContain("这条尺寸缺测量人、时间、方法或原始记录，不能当作现场实测数据使用。");
    const conflict = evaluated.snapshot.issues.find((item) => item.sourceRef === "rule:documented-dimension-chain-conflict");
    const metadata = evaluated.snapshot.issues.find((item) => item.sourceRef === "rule:measurement-metadata-required");
    expect(conflict?.blocksProxyOutcome).toBe(true);
    expect(metadata?.blocksProxyOutcome).toBe(false);
    expect(metadata?.blocksFormalEligibility).toBe(true);
  });

  it("规范选择停靠生成并列方案，选定后关闭且不重建", async () => {
    const current = await setup();
    const commandId = crypto.randomUUID();
    await current.commands.execute({
      commandType: "CommitFacts", commandId, projectId: current.projectId, actorId: current.actorId,
      expectedRevisionId: current.head.revisionId, issuedAt: "2026-08-16T00:00:00Z", payload: { facts: [
        { id: crypto.randomUUID(), subjectRef: current.head.snapshot.buildings[0]!.id, field: "roofFrame.totalDepthMm", value: 6000, producer: { producerType: "human", actorId: current.actorId, actionRef: { commandId } }, evidenceRefs: ["evidence:frame-note"], reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available" },
        { id: crypto.randomUUID(), subjectRef: current.head.snapshot.buildings[0]!.id, field: "roofFrame.stepCount", value: 3, producer: { producerType: "human", actorId: current.actorId, actionRef: { commandId } }, evidenceRefs: ["evidence:frame-note"], reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available" },
      ] },
    });
    const head = await current.repository.getProjectHead(current.projectId) as ProjectHead;
    const evaluated = await current.workflow.evaluate(head, current.actorId);
    const issue = evaluated.snapshot.issues.find((item) => item.sourceRef === "rule:lift-ratio-selection");
    expect(issue?.status).toBe("open");
    expect(issue?.options).toHaveLength(2);
    expect(issue?.options?.map((option) => option.ruleSetRef).sort()).toEqual(["liang-drawings", "qing-gongcheng-zuofa"]);
    expect(issue?.options?.[0]?.sourceText.length).toBeGreaterThan(0);
    expect(issue?.options?.[0]?.valueText).toContain("mm");

    const decided = await current.workflow.decideIssueOption(evaluated, current.actorId, {
      issueId: issue!.id, outcome: "accepted", selectedOptionId: "qing-gongcheng-zuofa", reason: "小式做法更接近本样本",
    });
    const closed = decided.snapshot.issues.find((item) => item.id === issue!.id);
    expect(closed?.status).toBe("resolved");
    expect(decided.snapshot.issues.filter((item) => item.sourceRef === "rule:lift-ratio-selection")).toHaveLength(1);
    const decisions = await current.repository.getProjectDecisions(current.projectId);
    const optionDecision = decisions.find((item) => item.issueId === issue!.id);
    expect(optionDecision).toMatchObject({ outcome: "accepted", selectedOptionId: "qing-gongcheng-zuofa" });
  });
});
