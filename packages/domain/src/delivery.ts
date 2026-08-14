import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyRefSchema, Sha256Schema, UuidSchema } from "./primitives.js";

export const ArtifactKindSchema = z.enum([
  "ifc", "glb", "brepBundle", "geometryManifest", "geometrySourceMap", "geometryReport", "geometryPreview",
  "drawingIr", "viewGeometry", "dxf", "svg", "pdf", "png", "drawingSourceMap",
  "checkReport", "licenseManifest", "deliveryManifest",
]);

export const ArtifactRecordSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectRevisionId: UuidSchema,
  geometryRevisionId: UuidSchema,
  requirementMatrixId: UuidSchema.nullable(),
  kind: ArtifactKindSchema,
  fileName: z.string().min(1).max(300),
  assetId: UuidSchema,
  sha256: Sha256Schema,
  mimeType: z.string().min(1).max(200),
  byteLength: z.number().int().nonnegative(),
  status: z.literal("generated-not-qualified"),
  l1Eligible: z.literal(false),
  formalEligibility: z.literal(false),
  sourceRefs: z.array(NonEmptyRefSchema).min(1).max(10_000),
  blockers: z.array(z.string().min(1).max(160)).min(1).max(100),
  createdAt: IsoDateTimeSchema,
}).strict();

export const CheckResultSchema = z.object({
  code: z.string().min(1).max(160),
  outcome: z.enum(["passed", "blocked"]),
  message: z.string().min(1).max(2_000),
  sourceRefs: z.array(NonEmptyRefSchema).max(5_000),
}).strict();

export const CheckRunSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectRevisionId: UuidSchema,
  geometryRevisionId: UuidSchema,
  artifactRefs: z.array(UuidSchema).min(1).max(10_000),
  status: z.literal("completed"),
  results: z.array(CheckResultSchema).min(1).max(10_000),
  reportAssetId: UuidSchema,
  reportHash: Sha256Schema,
  qualification: z.literal("generated-not-qualified"),
  l1Eligible: z.literal(false),
  formalEligibility: z.literal(false),
  completedAt: IsoDateTimeSchema,
}).strict();

export const DeliveryEvaluationSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectRevisionId: UuidSchema,
  geometryRevisionId: UuidSchema.nullable(),
  artifactRefs: z.array(UuidSchema).max(10_000),
  checkRunRefs: z.array(UuidSchema).max(10_000),
  outcome: z.enum(["proxy-ready", "blocked"]),
  blockerCodes: z.array(z.string().min(1).max(160)).max(500),
  blockerDetails: z.array(z.object({
    code: z.string().min(1).max(160),
    sourceType: z.enum(["fact", "issue", "unknown", "check", "artifact", "qualification"]),
    sourceRef: NonEmptyRefSchema,
    message: z.string().min(1).max(2_000),
    blocksProxyOutcome: z.boolean(),
  }).strict()).max(5_000).optional(),
  formalEligibility: z.literal(false),
  evaluatedAt: IsoDateTimeSchema,
}).strict();

export const DeliveryDraftSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectRevisionId: UuidSchema,
  geometryRevisionId: UuidSchema.nullable(),
  evaluationId: UuidSchema,
  artifactRefs: z.array(UuidSchema).max(10_000),
  manifestAssetId: UuidSchema,
  manifestHash: Sha256Schema,
  status: z.literal("proxy-unissued"),
  l1Eligible: z.literal(false),
  formalEligibility: z.literal(false),
  signatureStatus: z.literal("unsigned"),
  restrictions: z.array(z.string().min(1).max(300)).min(1).max(100),
  createdAt: IsoDateTimeSchema,
}).strict();

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type CheckRun = z.infer<typeof CheckRunSchema>;
export type DeliveryEvaluation = z.infer<typeof DeliveryEvaluationSchema>;
export type DeliveryDraft = z.infer<typeof DeliveryDraftSchema>;
