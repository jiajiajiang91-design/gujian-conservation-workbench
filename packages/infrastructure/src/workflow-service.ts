import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import {
  DecisionSchema,
  IssueSchema,
  RuleRunSchema,
  TaskDefinitionSchema,
} from "@gujian/domain";
import type { z } from "zod";

import { IndexedDbProjectRepository, LocalAuthorization } from "./indexeddb-project-repository.js";
import { evaluateOptionSets, loadRuleData } from "./rule-engine.js";
import { HERITAGE_BASELINE_RULE_DATA } from "./rules/heritage-baseline-v1.js";

// 规则数据在模块加载时校验一次；ruleSetVersion 绑定数据内容哈希（架构 v1.4 §5.5）
const RULE_DATA = loadRuleData(HERITAGE_BASELINE_RULE_DATA);
const DIMENSION_CHAIN_TOLERANCE_MM = Number(RULE_DATA.data.programParams.dimensionChainToleranceMm);

type Issue = z.infer<typeof IssueSchema>;

interface IssueDescriptor {
  ruleId: string;
  issueType: Issue["issueType"];
  subjectRefs: string[];
  description: string;
  impactRefs: string[];
  blocksProxyOutcome?: boolean;
  blocksFormalEligibility?: boolean;
  options?: NonNullable<Issue["options"]>;
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
    options: (issue.options ?? []).map((option) => option.optionId).sort(),
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
      description: "还没有确认任务范围、适用规范和责任人。",
      impactRefs: [head.projectId],
    });
  }
  const usableEvidence = head.snapshot.parseRecords.filter((record) => record.status === "parsed" && record.extractedText?.trim());
  if (!usableEvidence.length) {
    result.push({
      ruleId: "parsed-evidence-required",
      issueType: "missingEvidence",
      subjectRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
      description: "还没有可供助手识别的文字资料。",
      impactRefs: [head.projectId],
    });
  }
  const failedParses = head.snapshot.parseRecords.filter((record) => record.status === "failed");
  if (failedParses.length) {
    result.push({
      ruleId: "parse-failure-review",
      issueType: "missingEvidence",
      subjectRefs: failedParses.map((record) => record.evidenceId),
      description: `${failedParses.length} 份资料无法自动读取。原文件已保留，可更换格式重传或人工录入。`,
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
    if (Math.abs(difference) > DIMENSION_CHAIN_TOLERANCE_MM) {
      result.push({
        ruleId: "documented-dimension-chain-conflict",
        issueType: "ruleConflict",
        subjectRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
        description: `资料上的尺寸对不上：总尺寸 ${totalWidth} mm，各段相加 ${segmentTotal} mm，相差 ${difference} mm。`,
        impactRefs: [head.projectId],
      });
    }
    if (metadataComplete !== true) {
      result.push({
        ruleId: "measurement-metadata-required",
        issueType: "missingEvidence",
        subjectRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
        description: "这条尺寸缺测量人、时间、方法或原始记录，不能当作现场实测数据使用。",
        impactRefs: [head.projectId],
      });
    }
  }
  // 规范选择停靠（R2）：进深与步架数就绪且尚未做过举架系数选择时，
  // 按并存规则集分别计算并列方案，每案附系数出处（架构 v1.4 §5.5、§10）。
  const liftDecided = head.snapshot.issues.some((issue) =>
    issue.sourceRef === "rule:lift-ratio-selection" && issue.status !== "open");
  const totalDepth = latestFact("roofFrame.totalDepthMm")?.value;
  const stepCount = latestFact("roofFrame.stepCount")?.value;
  if (!liftDecided && typeof totalDepth === "number" && typeof stepCount === "number" && stepCount > 0) {
    const optionSets = evaluateOptionSets(RULE_DATA.data, { totalDepthMm: totalDepth, stepCount });
    const options = optionSets
      .map((set) => {
        const lifts = set.results.filter((item) => item.status === "computed" && item.ruleId.startsWith("lift"));
        if (!lifts.length) return null;
        return {
          optionId: set.ruleSetId,
          labelZh: set.ruleSetId === "liang-drawings" ? "梁思成图纸系数组" : "清工程做法系数组",
          valueText: lifts.map((item) => `${item.dimension} ${item.valueMm} mm`).join("；"),
          ruleSetRef: set.ruleSetId,
          sourceText: set.sourceText,
        };
      })
      .filter((option): option is NonNullable<typeof option> => option !== null);
    if (options.length >= 2) {
      result.push({
        ruleId: "lift-ratio-selection",
        issueType: "professionalUncertainty",
        subjectRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
        description: `举架做法有多种有依据的选择（通进深 ${totalDepth} mm，步架数 ${stepCount}），需要你判断本建筑适用哪一种。`,
        impactRefs: [head.projectId],
        blocksProxyOutcome: false,
        options,
      });
    }
  }
  for (const candidate of head.snapshot.candidates) {
    if (candidate.reviewStatus === "unreviewed") {
      result.push({
        ruleId: "model-candidate-review",
        issueType: "professionalUncertainty",
        subjectRefs: [candidate.id],
        description: "助手的识别结果还没有确认。确认后仍标为 AI 识别，不会变成现场实测数据。",
        impactRefs: [candidate.id],
      });
    }
    if (candidate.reviewStatus !== "rejected" && candidate.structured?.missingInformation.length) {
      result.push({
        ruleId: "model-reported-missing-information",
        issueType: "missingEvidence",
        subjectRefs: [candidate.id],
        description: `助手发现资料里缺这些内容：${candidate.structured.missingInformation.join("；")}`,
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
      ...(descriptor.options ? { options: descriptor.options } : {}),
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
      { id: "lift-ratio-selection", message: "举架系数规范选择检查（多规则集并列方案）" },
    ];
    const ruleRun = RuleRunSchema.parse({
      id: ruleRunId,
      projectId: head.projectId,
      inputRevisionId: head.revisionId,
      ruleSetVersion: RULE_DATA.ruleSetVersion,
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

  // 规范选择类停靠的方案决定：接受必须带所选方案，拒绝必须给理由（封闭集合不变）
  async decideIssueOption(head: ProjectHead, actorId: string, input: {
    issueId: string;
    outcome: "accepted" | "rejected";
    selectedOptionId: string | null;
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
      reason: input.reason?.trim() || (input.outcome === "accepted" ? null : "未说明理由"),
      impactRefs: [head.projectId],
      decidedAt: now,
      ...(input.outcome === "accepted" && input.selectedOptionId ? { selectedOptionId: input.selectedOptionId } : {}),
    });
    await this.#commands.execute({
      commandType: "DecideIssueOption",
      commandId,
      projectId: head.projectId,
      actorId,
      expectedRevisionId: head.revisionId,
      issuedAt: now,
      payload: { decision },
    });
    const updated = await this.#repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_OPTION_DECISION");
    return this.evaluate(updated, actorId);
  }
}
