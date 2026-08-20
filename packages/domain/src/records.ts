import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyRefSchema, Sha256Schema, UuidSchema } from "./primitives.js";

export const ProjectRevisionSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  parentId: UuidSchema.nullable(),
  snapshotHash: Sha256Schema,
  closureHash: Sha256Schema,
  recordHash: Sha256Schema,
  changedRefs: z.array(NonEmptyRefSchema),
  committedAt: IsoDateTimeSchema,
}).strict();

export const AuditEventSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  commandId: UuidSchema,
  actorId: UuidSchema,
  previousEventHash: Sha256Schema.nullable(),
  writeSet: z.array(z.object({
    kind: z.enum(["record", "asset"]),
    storeName: z.string().min(1).max(80),
    // v1.4：词表条目以语义 conceptId 为主键，写集标识放宽为非空引用（旧记录不受影响）
    id: NonEmptyRefSchema,
    hash: Sha256Schema,
  }).strict()).max(10_000),
  writeSetHash: Sha256Schema,
  outcome: z.enum(["committed", "rejected", "failed", "cancelled", "late"]),
  errorCode: z.string().min(1).max(120).nullable(),
  eventHash: Sha256Schema,
  recordHash: Sha256Schema,
  occurredAt: IsoDateTimeSchema,
}).strict();

export const DecisionSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  issueId: UuidSchema,
  actorId: UuidSchema,
  commandId: UuidSchema,
  outcome: z.enum(["accepted", "rejected", "rewritten", "superseded"]),
  reason: z.string().min(1).max(5_000).nullable(),
  impactRefs: z.array(NonEmptyRefSchema),
  decidedAt: IsoDateTimeSchema,
  // v1.4 增补（可选，旧记录不受影响）：选择型决定记录所选方案；封闭结果集合不变
  selectedOptionId: z.string().min(1).max(120).optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome !== "accepted" && value.reason === null) {
    context.addIssue({ code: "custom", message: "reason is required for this outcome", path: ["reason"] });
  }
  if (value.selectedOptionId !== undefined && value.outcome !== "accepted") {
    context.addIssue({ code: "custom", message: "selected option requires accepted outcome", path: ["selectedOptionId"] });
  }
});

export const RuleResultSchema = z.object({
  ruleId: z.string().min(1).max(160),
  outcome: z.enum(["passed", "issue"]),
  inputRefs: z.array(NonEmptyRefSchema).max(5_000),
  issueRefs: z.array(UuidSchema).max(5_000),
  message: z.string().min(1).max(5_000),
  // v1.4 增补（可选，旧记录不受影响）：计算值、容差带、规范出处与方案组引用
  computedValueText: z.string().min(1).max(200).optional(),
  toleranceText: z.string().min(1).max(200).optional(),
  sourceText: z.string().min(1).max(500).optional(),
  optionSetRef: z.string().min(1).max(200).optional(),
}).strict();

export const RuleRunSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  inputRevisionId: UuidSchema,
  ruleSetVersion: z.string().min(1).max(80),
  status: z.literal("completed"),
  producer: z.object({ producerType: z.literal("rule"), ruleRunId: UuidSchema }).strict(),
  results: z.array(RuleResultSchema).min(1).max(1_000),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (value.producer.ruleRunId !== value.id) {
    context.addIssue({ code: "custom", message: "producer ruleRunId must match run id", path: ["producer", "ruleRunId"] });
  }
});

export const ModelUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
}).strict();

export const ModelRunEventSchema = z.object({
  id: UuidSchema,
  runId: UuidSchema,
  sequence: z.number().int().nonnegative(),
  eventType: z.enum(["queued", "running", "retrying", "stream", "succeeded", "failed", "cancelled", "late"]),
  attempt: z.number().int().positive(),
  detail: z.string().max(2_000).nullable(),
  occurredAt: IsoDateTimeSchema,
}).strict();

export const ModelRunSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  inputRevisionId: UuidSchema,
  inputHash: Sha256Schema,
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  taskType: z.string().min(1).max(120),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
  events: z.array(ModelRunEventSchema).min(2).max(10_000),
  usage: ModelUsageSchema.nullable(),
  outputHash: Sha256Schema.nullable(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
}).strict();

// 模型候选的结构化输出按任务类型分。判别字段是 kind，消费方据此分支，
// 不靠字段有无来猜。任务注册表见 apps/server/src/model-tasks.ts。
export const EvidenceSummaryOutputSchema = z.object({
  kind: z.literal("evidenceSummary"),
  summary: z.string().min(1).max(20_000),
  findings: z.array(z.string().min(1).max(5_000)).max(200),
  missingInformation: z.array(z.string().min(1).max(5_000)).max(200),
}).strict();

// 图纸尺寸转写（技术架构 7.2 首期任务类型之一，用户旅程第二步）。
// 每条尺寸必须能追到图上原文与所在资料；读不准的单独标出来由人工判断，
// 不由模型替人决定。
export const TranscribedDimensionSchema = z.object({
  valueText: z.string().min(1).max(120),
  valueMm: z.string().max(40).nullable(),
  partZh: z.string().max(120).nullable(),
  evidenceRef: NonEmptyRefSchema,
  locationZh: z.string().max(200).nullable(),
  certainty: z.enum(["certain", "uncertain"]),
  noteZh: z.string().max(500).nullable(),
}).strict();

export const MeasurementTranscriptionOutputSchema = z.object({
  kind: z.literal("measurementTranscription"),
  summary: z.string().min(1).max(20_000),
  dimensions: z.array(TranscribedDimensionSchema).max(200),
  missingInformation: z.array(z.string().min(1).max(5_000)).max(200),
}).strict();

export const ModelCandidateOutputSchema = z.discriminatedUnion("kind", [
  EvidenceSummaryOutputSchema,
  MeasurementTranscriptionOutputSchema,
]);

export const ModelCandidateSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  runId: UuidSchema,
  inputRevisionId: UuidSchema,
  taskType: z.string().min(1).max(120),
  contentText: z.string().min(1).max(200_000),
  structured: ModelCandidateOutputSchema.nullable(),
  producer: z.object({ producerType: z.literal("model"), runId: UuidSchema }).strict(),
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
  reviewStatus: z.enum(["unreviewed", "confirmed", "rejected", "superseded"]),
  createdAt: IsoDateTimeSchema,
}).strict();

export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type ModelRun = z.infer<typeof ModelRunSchema>;
export type ModelRunEvent = z.infer<typeof ModelRunEventSchema>;
export type ModelCandidate = z.infer<typeof ModelCandidateSchema>;
export type ModelCandidateOutput = z.infer<typeof ModelCandidateOutputSchema>;
export type TranscribedDimension = z.infer<typeof TranscribedDimensionSchema>;
export type RuleRun = z.infer<typeof RuleRunSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
