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
  RuleRunSchema,
  DecisionSchema,
  IssueSchema,
  ProjectSchema,
  TaskDefinitionSchema,
  Sha256Schema,
  UuidSchema,
  CadJobSchema,
  GeometryRevisionSchema,
  ProjectDrivenGeometrySpecSchema,
  ArtifactRecordSchema,
  ArtifactRequirementMatrixSchema,
  CheckRunSchema,
  DeliveryEvaluationSchema,
  DeliveryDraftSchema,
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

export const ReplaceTaskDefinitionCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("ReplaceTaskDefinition"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    taskDefinition: TaskDefinitionSchema,
    supersedesTaskDefinitionId: UuidSchema,
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
    ruleRuns: z.array(RuleRunSchema).max(100_000),
    decisions: z.array(DecisionSchema).max(100_000),
    cadJobs: z.array(CadJobSchema).max(100_000).default([]),
    artifactRequirementMatrices: z.array(ArtifactRequirementMatrixSchema).max(100_000).default([]),
    artifacts: z.array(ArtifactRecordSchema).max(100_000).default([]),
    checkRuns: z.array(CheckRunSchema).max(100_000).default([]),
    deliveryEvaluations: z.array(DeliveryEvaluationSchema).max(100_000).default([]),
    deliveries: z.array(DeliveryDraftSchema).max(100_000).default([]),
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

export const ConfirmTaskSetupCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("ConfirmTaskSetup"),
  expectedRevisionId: UuidSchema,
  payload: z.object({ taskDefinition: TaskDefinitionSchema }).strict(),
}).strict();

export const CommitRuleEvaluationCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CommitRuleEvaluation"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    ruleRun: RuleRunSchema,
    issues: z.array(IssueSchema).max(5_000),
  }).strict(),
}).strict();

export const DecideCandidateCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("DecideCandidate"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    candidateId: UuidSchema,
    decision: DecisionSchema,
  }).strict().superRefine((value, context) => {
    if (!(["accepted", "rejected"] as const).includes(value.decision.outcome as "accepted" | "rejected")) {
      context.addIssue({ code: "custom", message: "candidate decision must accept or reject", path: ["decision", "outcome"] });
    }
  }),
}).strict();

export const StartCadJobCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("StartCadJob"),
  expectedRevisionId: UuidSchema,
  payload: z.object({ job: CadJobSchema }).strict(),
}).strict();

export const SyncCadJobEventsCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("SyncCadJobEvents"),
  expectedRevisionId: UuidSchema,
  payload: z.object({ job: CadJobSchema }).strict(),
}).strict();

export const CommitGeometryRevisionCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CommitGeometryRevision"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    cadJobId: UuidSchema,
    geometrySpec: ProjectDrivenGeometrySpecSchema,
    geometryRevision: GeometryRevisionSchema,
    assets: z.array(AssetRecordSchema).min(6).max(20),
    stagingSessionId: UuidSchema,
  }).strict(),
}).strict();

export const CommitArtifactSetCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CommitArtifactSet"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    artifactRequirementMatrices: z.array(ArtifactRequirementMatrixSchema).max(10_000).default([]),
    artifacts: z.array(ArtifactRecordSchema).min(1).max(10_000),
    assets: z.array(AssetRecordSchema).max(10_000),
    stagingSessionId: UuidSchema.nullable(),
  }).strict(),
}).strict();

export const CommitCheckRunCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CommitCheckRun"),
  expectedRevisionId: UuidSchema,
  payload: z.object({ checkRun: CheckRunSchema }).strict(),
}).strict();

export const EvaluateDeliveryCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("EvaluateDelivery"),
  expectedRevisionId: UuidSchema,
  payload: z.object({ evaluation: DeliveryEvaluationSchema }).strict(),
}).strict();

export const CreateDeliveryDraftCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CreateDeliveryDraft"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    draft: DeliveryDraftSchema,
    manifestAsset: AssetRecordSchema,
    manifestArtifact: ArtifactRecordSchema,
    stagingSessionId: UuidSchema,
  }).strict(),
}).strict();

export const ProjectCommandSchema = z.discriminatedUnion("commandType", [
  CreateProjectCommandSchema,
  CommitFactsCommandSchema,
  ReplaceTaskDefinitionCommandSchema,
  ImportProjectSnapshotCommandSchema,
  ImportEvidenceCommandSchema,
  CommitModelRunResultCommandSchema,
  ConfirmTaskSetupCommandSchema,
  CommitRuleEvaluationCommandSchema,
  DecideCandidateCommandSchema,
  StartCadJobCommandSchema,
  SyncCadJobEventsCommandSchema,
  CommitGeometryRevisionCommandSchema,
  CommitArtifactSetCommandSchema,
  CommitCheckRunCommandSchema,
  EvaluateDeliveryCommandSchema,
  CreateDeliveryDraftCommandSchema,
]);

export type CreateProjectCommand = z.infer<typeof CreateProjectCommandSchema>;
export type CommitFactsCommand = z.infer<typeof CommitFactsCommandSchema>;
export type ImportProjectSnapshotCommand = z.infer<typeof ImportProjectSnapshotCommandSchema>;
export type ImportEvidenceCommand = z.infer<typeof ImportEvidenceCommandSchema>;
export type CommitModelRunResultCommand = z.infer<typeof CommitModelRunResultCommandSchema>;
export type ConfirmTaskSetupCommand = z.infer<typeof ConfirmTaskSetupCommandSchema>;
export type CommitRuleEvaluationCommand = z.infer<typeof CommitRuleEvaluationCommandSchema>;
export type DecideCandidateCommand = z.infer<typeof DecideCandidateCommandSchema>;
export type StartCadJobCommand = z.infer<typeof StartCadJobCommandSchema>;
export type SyncCadJobEventsCommand = z.infer<typeof SyncCadJobEventsCommandSchema>;
export type CommitGeometryRevisionCommand = z.infer<typeof CommitGeometryRevisionCommandSchema>;
export type CommitArtifactSetCommand = z.infer<typeof CommitArtifactSetCommandSchema>;
export type CommitCheckRunCommand = z.infer<typeof CommitCheckRunCommandSchema>;
export type EvaluateDeliveryCommand = z.infer<typeof EvaluateDeliveryCommandSchema>;
export type CreateDeliveryDraftCommand = z.infer<typeof CreateDeliveryDraftCommandSchema>;
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type ProjectCommandType = ProjectCommand["commandType"];
