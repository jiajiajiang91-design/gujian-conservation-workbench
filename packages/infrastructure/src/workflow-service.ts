import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import {
  DecisionSchema,
  IssueSchema,
  RuleRunSchema,
  TaskDefinitionSchema,
} from "@gujian/domain";
import type { z } from "zod";

import { IndexedDbProjectRepository, LocalAuthorization } from "./indexeddb-project-repository.js";

type Issue = z.infer<typeof IssueSchema>;

interface IssueDescriptor {
  ruleId: string;
  issueType: Issue["issueType"];
  subjectRefs: string[];
  description: string;
  impactRefs: string[];
  blocksProxyOutcome?: boolean;
  blocksFormalEligibility?: boolean;
}

function descriptorKey(issue: IssueDescriptor | Issue): string {
  const ruleId = "ruleId" in issue ? issue.ruleId : issue.sourceRef.replace(/^rule:/, "");
  return JSON.stringify({
    ruleId,
    issueType: issue.issueType,
    subjectRefs: [...issue.subjectRefs].sort(),
    description: issue.description,
    impactRefs: [...issue.impactRefs].sort(),
    blocksProxyOutcome: issue.blocksProxyOutcome ?? false,
    blocksFormalEligibility: issue.blocksFormalEligibility ?? true,
  });
}

function desiredIssues(head: ProjectHead): IssueDescriptor[] {
  const result: IssueDescriptor[] = [];
  const confirmedTask = head.snapshot.taskDefinitions.find((task) => task.confirmedAt !== null);
  if (!confirmedTask) {
    result.push({
      ruleId: "task-setup-required",
      issueType: "missingEvidence",
      subjectRefs: [head.projectId],
      description: "任务范围、适用规范和责任角色尚未一次确认。",
      impactRefs: [head.projectId],
    });
  }
  const usableEvidence = head.snapshot.parseRecords.filter((record) => record.status === "parsed" && record.extractedText?.trim());
  if (!usableEvidence.length) {
    result.push({
      ruleId: "parsed-evidence-required",
      issueType: "missingEvidence",
      subjectRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
      description: "尚无可供自动整理的已解析文本资料。",
      impactRefs: [head.projectId],
    });
  }
  const failedParses = head.snapshot.parseRecords.filter((record) => record.status === "failed");
  if (failedParses.length) {
    result.push({
      ruleId: "parse-failure-review",
      issueType: "missingEvidence",
      subjectRefs: failedParses.map((record) => record.evidenceId),
      description: `${failedParses.length} 份资料解析失败；原文件已保留，需要更换格式或人工补录。`,
      impactRefs: failedParses.map((record) => record.id),
    });
  }
  const latestFact = (field: string) => head.snapshot.facts.filter((fact) =>
    fact.field === field && fact.reviewStatus === "confirmed" && fact.dataStatus === "available").at(-1);
  const totalWidth = latestFact("documentedDimension.totalWidthMm")?.value;
  const segmentWidths = latestFact("documentedDimension.segmentWidthsMm")?.value;
  const metadataComplete = latestFact("documentedDimension.measurementMetadataComplete")?.value;
  if (typeof totalWidth === "number" && Array.isArray(segmentWidths) &&
      segmentWidths.every((value) => typeof value === "number" && Number.isFinite(value))) {
    const segmentTotal = segmentWidths.reduce((sum, value) => sum + value, 0);
    const difference = totalWidth - segmentTotal;
    if (Math.abs(difference) > 1) {
      result.push({
        ruleId: "documented-dimension-chain-conflict",
        issueType: "ruleConflict",
        subjectRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
        description: `资料转写尺寸链不闭合：总尺寸 ${totalWidth} mm，分段合计 ${segmentTotal} mm，差值 ${difference} mm。`,
        impactRefs: [head.projectId],
      });
    }
    if (metadataComplete !== true) {
      result.push({
        ruleId: "measurement-metadata-required",
        issueType: "missingEvidence",
        subjectRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
        description: "尺寸记录缺少测量人、时间、方法或原始记录，不能作为正式实测事实。",
        impactRefs: [head.projectId],
      });
    }
  }
  for (const candidate of head.snapshot.candidates) {
    if (candidate.reviewStatus === "unreviewed") {
      result.push({
        ruleId: "model-candidate-review",
        issueType: "professionalUncertainty",
        subjectRefs: [candidate.id],
        description: "模型候选尚未由人员接受或驳回；接受后仍保持模型来源，不转为现场实测。",
        impactRefs: [candidate.id],
      });
    }
    if (candidate.reviewStatus !== "rejected" && candidate.structured?.missingInformation.length) {
      result.push({
        ruleId: "model-reported-missing-information",
        issueType: "missingEvidence",
        subjectRefs: [candidate.id],
        description: `模型候选指出缺失信息：${candidate.structured.missingInformation.join("；")}`,
        impactRefs: [candidate.id],
      });
    }
  }
  return result;
}

export class WorkflowService {
  readonly #repository: IndexedDbProjectRepository;
  readonly #commands: ProjectCommandService;

  constructor(repository: IndexedDbProjectRepository) {
    this.#repository = repository;
    this.#commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
  }

  async evaluate(head: ProjectHead, actorId: string): Promise<ProjectHead> {
    const desired = desiredIssues(head);
    const existing = head.snapshot.issues.filter((issue) => issue.status === "open" && issue.producer.producerType === "rule");
    const desiredKeys = desired.map(descriptorKey).sort();
    const existingKeys = existing.map(descriptorKey).sort();
    if (JSON.stringify(desiredKeys) === JSON.stringify(existingKeys)) return head;

    const now = new Date().toISOString();
    const ruleRunId = crypto.randomUUID();
    const issues = desired.map((descriptor) => IssueSchema.parse({
      id: crypto.randomUUID(),
      projectId: head.projectId,
      issueType: descriptor.issueType,
      subjectRefs: descriptor.subjectRefs,
      description: descriptor.description,
      sourceRef: `rule:${descriptor.ruleId}`,
      status: "open",
      impactRefs: descriptor.impactRefs,
      blocksProxyOutcome: descriptor.blocksProxyOutcome ?? (descriptor.issueType === "ruleConflict" || descriptor.issueType === "highRisk"),
      blocksFormalEligibility: descriptor.blocksFormalEligibility ?? true,
      producer: { producerType: "rule", ruleRunId },
      createdAt: now,
      resolvedAt: null,
    }));
    const issueRefsFor = (ruleId: string) => issues.filter((issue) => issue.sourceRef === `rule:${ruleId}`).map((issue) => issue.id);
    const ruleDefinitions = [
      { id: "task-setup-required", message: "任务设置一次确认检查" },
      { id: "parsed-evidence-required", message: "可解析资料检查" },
      { id: "parse-failure-review", message: "资料解析失败检查" },
      { id: "model-candidate-review", message: "模型候选人工取舍检查" },
      { id: "model-reported-missing-information", message: "模型报告缺失信息检查" },
      { id: "documented-dimension-chain-conflict", message: "文档尺寸链一致性检查" },
      { id: "measurement-metadata-required", message: "测量元数据完整性检查" },
    ];
    const ruleRun = RuleRunSchema.parse({
      id: ruleRunId,
      projectId: head.projectId,
      inputRevisionId: head.revisionId,
      ruleSetVersion: "milestone-one-v1",
      status: "completed",
      producer: { producerType: "rule", ruleRunId },
      results: ruleDefinitions.map((rule) => ({
        ruleId: rule.id,
        outcome: issueRefsFor(rule.id).length ? "issue" : "passed",
        inputRefs: [head.revisionId],
        issueRefs: issueRefsFor(rule.id),
        message: rule.message,
      })),
      startedAt: now,
      completedAt: now,
    });
    await this.#commands.execute({
      commandType: "CommitRuleEvaluation",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId,
      expectedRevisionId: head.revisionId,
      issuedAt: now,
      payload: { ruleRun, issues },
    });
    const updated = await this.#repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_RULE_EVALUATION");
    return updated;
  }

  async confirmTaskSetup(head: ProjectHead, actorId: string, input: {
    taskName: string;
    scope: string[];
    regulationRefs: string[];
    deliverables: string[];
    artifactRequirements?: import("@gujian/domain").TaskArtifactRequirements;
  }): Promise<ProjectHead> {
    const now = new Date().toISOString();
    const taskDefinition = TaskDefinitionSchema.parse({
      id: crypto.randomUUID(),
      name: input.taskName,
      scope: input.scope,
      regulationRefs: input.regulationRefs,
      deliverables: input.deliverables,
      responsibilities: [
        { role: "projectLead", actorId },
        { role: "professionalReviewer", actorId },
      ],
      automationPolicyRef: "policy:milestone-one-v1",
      ...(input.artifactRequirements ? { artifactRequirements: input.artifactRequirements } : {}),
      confirmedAt: now,
    });
    await this.#commands.execute({
      commandType: "ConfirmTaskSetup",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId,
      expectedRevisionId: head.revisionId,
      issuedAt: now,
      payload: { taskDefinition },
    });
    const updated = await this.#repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_TASK_SETUP");
    return this.evaluate(updated, actorId);
  }

  async replaceTaskDefinition(head: ProjectHead, actorId: string, input: {
    taskName: string;
    scope: string[];
    regulationRefs: string[];
    deliverables: string[];
    artifactRequirements: import("@gujian/domain").TaskArtifactRequirements;
  }): Promise<ProjectHead> {
    const current = head.snapshot.taskDefinitions.find((task) => task.confirmedAt !== null);
    if (!current) return this.confirmTaskSetup(head, actorId, input);
    const now = new Date().toISOString();
    const taskDefinition = TaskDefinitionSchema.parse({
      ...current,
      id: crypto.randomUUID(),
      name: input.taskName,
      scope: input.scope,
      regulationRefs: input.regulationRefs,
      deliverables: input.deliverables,
      artifactRequirements: input.artifactRequirements,
      confirmedAt: now,
    });
    await this.#commands.execute({
      commandType: "ReplaceTaskDefinition",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId,
      expectedRevisionId: head.revisionId,
      issuedAt: now,
      payload: { taskDefinition, supersedesTaskDefinitionId: current.id },
    });
    const updated = await this.#repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_TASK_REPLACEMENT");
    return this.evaluate(updated, actorId);
  }

  async decideCandidate(head: ProjectHead, actorId: string, input: {
    candidateId: string;
    issueId: string;
    outcome: "accepted" | "rejected";
    reason: string | null;
  }): Promise<ProjectHead> {
    const now = new Date().toISOString();
    const commandId = crypto.randomUUID();
    const decision = DecisionSchema.parse({
      id: crypto.randomUUID(),
      projectId: head.projectId,
      issueId: input.issueId,
      actorId,
      commandId,
      outcome: input.outcome,
      reason: input.outcome === "accepted" ? input.reason : input.reason?.trim() || null,
      impactRefs: [input.candidateId],
      decidedAt: now,
    });
    await this.#commands.execute({
      commandType: "DecideCandidate",
      commandId,
      projectId: head.projectId,
      actorId,
      expectedRevisionId: head.revisionId,
      issuedAt: now,
      payload: { candidateId: input.candidateId, decision },
    });
    const updated = await this.#repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_DECISION");
    return this.evaluate(updated, actorId);
  }
}
