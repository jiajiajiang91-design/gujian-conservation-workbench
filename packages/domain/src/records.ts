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
    id: UuidSchema,
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
}).strict().superRefine((value, context) => {
  if (value.outcome !== "accepted" && value.reason === null) {
    context.addIssue({ code: "custom", message: "reason is required for this outcome", path: ["reason"] });
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

export const ModelCandidateSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  runId: UuidSchema,
  inputRevisionId: UuidSchema,
  taskType: z.string().min(1).max(120),
  contentText: z.string().min(1).max(200_000),
  structured: z.object({
    summary: z.string().min(1).max(20_000),
    findings: z.array(z.string().min(1).max(5_000)).max(200),
    missingInformation: z.array(z.string().min(1).max(5_000)).max(200),
  }).strict().nullable(),
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
