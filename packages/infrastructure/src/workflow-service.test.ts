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
});
