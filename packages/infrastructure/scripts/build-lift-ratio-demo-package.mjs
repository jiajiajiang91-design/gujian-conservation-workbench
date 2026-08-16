// 一次性工具：用真实命令服务构造带 roofFrame 事实的演示项目包，
// 供浏览器验证规范选择停靠（多方案 + 出处 + selectedOptionId）。
import "fake-indexeddb/auto";

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ProjectCommandService } from "@gujian/application";

import { IndexedDbProjectRepository, LocalAuthorization, openWorkbenchDatabase } from "../dist/indexeddb-project-repository.js";
import { ProjectPackageService } from "../dist/project-package-service.js";
import { WorkflowService } from "../dist/workflow-service.js";

const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(`gujian-demo-${crypto.randomUUID()}`));
const commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
const workflow = new WorkflowService(repository);
const projectId = crypto.randomUUID();
const actorId = crypto.randomUUID();
const now = "2026-08-16T00:00:00Z";

await commands.execute({
  commandType: "CreateProject",
  commandId: crypto.randomUUID(), projectId, actorId, expectedRevisionId: null, issuedAt: now,
  payload: {
    project: { id: projectId, name: "举架系数选择演示项目", status: "active", locationText: "演示数据，不对应真实地点", createdAt: now },
    building: { id: crypto.randomUUID(), projectId, name: "演示正殿", periodText: null, addressText: null, status: "existing" },
  },
});
let head = await repository.getProjectHead(projectId);
const commandId = crypto.randomUUID();
await commands.execute({
  commandType: "CommitFacts", commandId, projectId, actorId,
  expectedRevisionId: head.revisionId, issuedAt: now, payload: { facts: [
    { id: crypto.randomUUID(), subjectRef: head.snapshot.buildings[0].id, field: "roofFrame.totalDepthMm", value: 3600, producer: { producerType: "human", actorId, actionRef: { commandId } }, evidenceRefs: ["evidence:frame-note"], reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available" },
    { id: crypto.randomUUID(), subjectRef: head.snapshot.buildings[0].id, field: "roofFrame.stepCount", value: 3, producer: { producerType: "human", actorId, actionRef: { commandId } }, evidenceRefs: ["evidence:frame-note"], reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available" },
  ] },
});
head = await repository.getProjectHead(projectId);
head = await workflow.evaluate(head, actorId);
const issue = head.snapshot.issues.find((item) => item.sourceRef === "rule:lift-ratio-selection");
if (!issue || issue.status !== "open" || (issue.options ?? []).length !== 2) {
  throw new Error(`举架方案问题未按预期生成: ${JSON.stringify(issue ?? null)}`);
}

const packages = new ProjectPackageService(repository);
const bytes = await packages.exportJson(projectId);
const output = resolve(import.meta.dirname, "../../../验证材料/14_规则层与词表验证/fixtures");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "lift-ratio-demo.project.json"), bytes);
console.log(JSON.stringify({ projectId, issueId: issue.id, options: issue.options.map((o) => o.optionId), bytes: bytes.length }));
