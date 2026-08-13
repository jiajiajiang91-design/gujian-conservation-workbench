import { z } from "zod";

import {
  BuildingSchema,
  AuditEventSchema,
  AssetRecordSchema,
  FactEnvelopeSchema,
  EvidenceSchema,
  IsoDateTimeSchema,
  ProjectSnapshotSchema,
  ParseRecordSchema,
  ModelCandidateSchema,
  ModelRunSchema,
  ProjectSchema,
  Sha256Schema,
  UuidSchema,
} from "@gujian/domain";

const CommandHeaderSchema = z.object({
  commandId: UuidSchema,
  projectId: UuidSchema,
  actorId: UuidSchema,
  expectedRevisionId: UuidSchema.nullable(),
  issuedAt: IsoDateTimeSchema,
});

export const CreateProjectCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CreateProject"),
  expectedRevisionId: z.null(),
  payload: z.object({
    project: ProjectSchema,
    building: BuildingSchema,
  }).strict(),
}).strict();

export const CommitFactsCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CommitFacts"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    facts: z.array(FactEnvelopeSchema).min(1).max(1_000),
  }).strict(),
}).strict();

export const ImportProjectSnapshotCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("ImportProjectSnapshot"),
  expectedRevisionId: z.null(),
  payload: z.object({
    snapshot: ProjectSnapshotSchema,
    sourceRevisionId: UuidSchema,
    sourceAuditHeadHash: Sha256Schema,
    sourceAuditEvents: z.array(AuditEventSchema).max(100_000),
    assets: z.array(AssetRecordSchema).max(1_000),
    modelRuns: z.array(ModelRunSchema).max(100_000),
    assetSessionId: UuidSchema.nullable(),
    packageHash: Sha256Schema,
  }).strict(),
}).strict();

export const ImportEvidenceCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("ImportEvidence"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    evidence: EvidenceSchema,
    asset: AssetRecordSchema,
    parseRecord: ParseRecordSchema,
    stagingSessionId: UuidSchema,
  }).strict(),
}).strict();

export const CommitModelRunResultCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CommitModelRunResult"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    run: ModelRunSchema,
    candidate: ModelCandidateSchema.nullable(),
  }).strict(),
}).strict();

export const ProjectCommandSchema = z.discriminatedUnion("commandType", [
  CreateProjectCommandSchema,
  CommitFactsCommandSchema,
  ImportProjectSnapshotCommandSchema,
  ImportEvidenceCommandSchema,
  CommitModelRunResultCommandSchema,
]);

export type CreateProjectCommand = z.infer<typeof CreateProjectCommandSchema>;
export type CommitFactsCommand = z.infer<typeof CommitFactsCommandSchema>;
export type ImportProjectSnapshotCommand = z.infer<typeof ImportProjectSnapshotCommandSchema>;
export type ImportEvidenceCommand = z.infer<typeof ImportEvidenceCommandSchema>;
export type CommitModelRunResultCommand = z.infer<typeof CommitModelRunResultCommandSchema>;
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type ProjectCommandType = ProjectCommand["commandType"];
