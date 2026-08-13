import { z } from "zod";

import { FactEnvelopeSchema, ProducerRefSchema } from "./provenance.js";
import { ModelCandidateSchema } from "./records.js";
import {
  DataStatusSchema,
  IsoDateTimeSchema,
  NonEmptyRefSchema,
  QuantitySchema,
  UuidSchema,
} from "./primitives.js";

export const ProjectSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(200),
  status: z.enum(["active", "archived"]),
  locationText: z.string().max(500).nullable(),
  createdAt: IsoDateTimeSchema,
}).strict();

export const BuildingSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  name: z.string().min(1).max(200),
  periodText: z.string().max(200).nullable(),
  addressText: z.string().max(500).nullable(),
  status: z.enum(["existing", "lost", "uncertain"]),
}).strict();

export const ResponsibilitySchema = z.object({
  role: z.enum(["projectLead", "surveyor", "professionalReviewer", "archiveRecipient"]),
  actorId: UuidSchema,
}).strict();

export const TaskDefinitionSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(200),
  scope: z.array(z.string().min(1).max(200)).min(1).max(200),
  regulationRefs: z.array(NonEmptyRefSchema).max(100),
  deliverables: z.array(z.string().min(1).max(120)).min(1).max(100),
  responsibilities: z.array(ResponsibilitySchema).min(1).max(100),
  automationPolicyRef: NonEmptyRefSchema.nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
}).strict();

export const EvidenceSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  assetId: UuidSchema,
  evidenceType: z.enum([
    "photo",
    "document",
    "drawing",
    "measurementRecord",
    "audio",
    "video",
    "pointCloud",
    "other",
  ]),
  title: z.string().min(1).max(300),
  rightsDeclaration: z.string().max(1_000).nullable(),
  intendedUse: z.string().max(1_000).nullable(),
  recordedAt: IsoDateTimeSchema.nullable(),
  relatedEntityRefs: z.array(NonEmptyRefSchema).max(5_000),
  dataStatus: DataStatusSchema,
}).strict();

export const AssetRecordSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  fileName: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(200),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentStatus: z.enum(["available", "missing"]),
  createdAt: IsoDateTimeSchema,
}).strict();

export const ParseRecordSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  assetId: UuidSchema,
  evidenceId: UuidSchema,
  parser: z.string().min(1).max(120),
  parserVersion: z.string().min(1).max(80),
  status: z.enum(["parsed", "metadataOnly", "pending", "failed"]),
  extractedText: z.string().max(200_000).nullable(),
  warnings: z.array(z.string().min(1).max(500)).max(100),
  createdAt: IsoDateTimeSchema,
}).strict();

export const HeritageEntitySchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  buildingId: UuidSchema,
  parentId: UuidSchema.nullable(),
  entityType: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  locationText: z.string().max(500).nullable(),
}).strict();

export const RelationSchema = z.object({
  id: UuidSchema,
  fromRef: NonEmptyRefSchema,
  toRef: NonEmptyRefSchema,
  relationType: z.string().min(1).max(120),
  producer: ProducerRefSchema,
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
  dataStatus: DataStatusSchema,
}).strict();

export const ObservationSchema = z.object({
  id: UuidSchema,
  subjectRef: NonEmptyRefSchema,
  observationType: z.enum(["visibleCondition", "material", "damage", "state"]),
  text: z.string().min(1).max(5_000),
  producer: ProducerRefSchema,
  evidenceRefs: z.array(NonEmptyRefSchema).min(1).max(500),
  dataStatus: DataStatusSchema,
}).strict();

export const MeasurementRecordSchema = z.object({
  id: UuidSchema,
  subjectRef: NonEmptyRefSchema,
  quantity: QuantitySchema,
  measuredBy: UuidSchema.nullable(),
  measuredAt: IsoDateTimeSchema.nullable(),
  method: z.string().min(1).max(500).nullable(),
  originalEvidenceRef: NonEmptyRefSchema,
  instrumentText: z.string().max(500).nullable(),
  pointRef: NonEmptyRefSchema.nullable(),
  metadataStatus: z.enum(["complete", "incomplete"]),
  producer: ProducerRefSchema,
  dataStatus: DataStatusSchema,
}).strict().superRefine((value, context) => {
  const complete = value.measuredBy !== null && value.measuredAt !== null && value.method !== null;
  if ((value.metadataStatus === "complete") !== complete) {
    context.addIssue({
      code: "custom",
      message: "metadataStatus must match measuredBy, measuredAt and method",
      path: ["metadataStatus"],
    });
  }
});

export const IssueSchema = z.object({
  id: UuidSchema,
  issueType: z.enum(["missingEvidence", "professionalUncertainty", "ruleConflict", "highRisk"]),
  subjectRefs: z.array(NonEmptyRefSchema).min(1).max(500),
  description: z.string().min(1).max(5_000),
  status: z.enum(["open", "resolved", "rejected", "superseded"]),
  impactRefs: z.array(NonEmptyRefSchema).max(5_000),
}).strict();

export const DependencyEdgeSchema = z.object({
  id: UuidSchema,
  fromRef: NonEmptyRefSchema,
  toRef: NonEmptyRefSchema,
  dependencyType: z.enum([
    "evidenceToFact",
    "factToConstraint",
    "constraintToGeometry",
    "geometryToView",
    "viewToArtifact",
    "artifactToCheck",
    "checkToDelivery",
  ]),
}).strict();

export const ProjectSnapshotSchema = z.object({
  schemaVersion: z.literal("3.0"),
  project: ProjectSchema,
  buildings: z.array(BuildingSchema).min(1),
  taskDefinitions: z.array(TaskDefinitionSchema),
  evidences: z.array(EvidenceSchema),
  parseRecords: z.array(ParseRecordSchema),
  entities: z.array(HeritageEntitySchema),
  relations: z.array(RelationSchema),
  observations: z.array(ObservationSchema),
  measurements: z.array(MeasurementRecordSchema),
  facts: z.array(FactEnvelopeSchema),
  candidates: z.array(ModelCandidateSchema),
  issues: z.array(IssueSchema),
  dependencyEdges: z.array(DependencyEdgeSchema),
  adoptedRecordRefs: z.array(NonEmptyRefSchema),
}).strict().superRefine((value, context) => {
  if (value.buildings.some((building) => building.projectId !== value.project.id)) {
    context.addIssue({ code: "custom", message: "building projectId must match project", path: ["buildings"] });
  }
});

export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
export type MeasurementRecord = z.infer<typeof MeasurementRecordSchema>;
export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type ParseRecord = z.infer<typeof ParseRecordSchema>;
