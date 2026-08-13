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

export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
