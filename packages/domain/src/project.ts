import { z } from "zod";

import { DrawingViewKindSchema } from "./drawings.js";
import { FactEnvelopeSchema, ProducerRefSchema } from "./provenance.js";
import { GeometryRevisionSchema, ProjectDrivenGeometrySpecSchema } from "./geometry.js";
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

const TaskDrawingViewRequirementSchema = z.object({
  key: z.string().min(1).max(80),
  displayLabelZh: z.string().min(1).max(80),
  drawingRef: z.string().min(1).max(20),
  kind: DrawingViewKindSchema,
  scaleDenominator: z.number().int().positive(),
  sheetKey: z.string().min(1).max(80),
  viewportRectMm: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
  direction: z.tuple([z.number(), z.number(), z.number()]),
  right: z.tuple([z.number(), z.number(), z.number()]),
  up: z.tuple([z.number(), z.number(), z.number()]),
  sectionPlane: z.object({
    normal: z.tuple([z.number(), z.number(), z.number()]),
    offsetMm: z.number(),
  }).strict().optional(),
  cropBoundsMm: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  targetStableKeys: z.array(z.string().min(1).max(200)).max(500),
  sourceEvidenceRefs: z.array(NonEmptyRefSchema).max(500),
}).strict();

const TaskDrawingSheetRequirementSchema = z.object({
  key: z.string().min(1).max(80),
  drawingNumber: z.string().min(1).max(32),
  displayLabelZh: z.string().min(1).max(80),
  pageMm: z.tuple([z.number().positive(), z.number().positive()]),
}).strict();

export const TaskArtifactRequirementsSchema = z.object({
  titleZh: z.string().min(1).max(120),
  revisionLabel: z.string().min(1).max(16),
  geometryTargetRoles: z.array(z.string().min(1).max(120)).min(1).max(100),
  views: z.array(TaskDrawingViewRequirementSchema).min(1).max(100),
  sheets: z.array(TaskDrawingSheetRequirementSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  const sheetKeys = new Set(value.sheets.map((sheet) => sheet.key));
  if (sheetKeys.size !== value.sheets.length) context.addIssue({ code: "custom", message: "task sheet keys must be unique" });
  if (new Set(value.views.map((view) => view.key)).size !== value.views.length) context.addIssue({ code: "custom", message: "task view keys must be unique" });
  for (const [index, view] of value.views.entries()) {
    if (!sheetKeys.has(view.sheetKey)) context.addIssue({ code: "custom", message: "task view references an unknown sheet", path: ["views", index, "sheetKey"] });
    if (["transverseSection", "longitudinalSection", "detail"].includes(view.kind) && !view.sectionPlane) {
      context.addIssue({ code: "custom", message: "section and detail tasks require an explicit section plane", path: ["views", index, "sectionPlane"] });
    }
    if (view.kind === "detail" && (!view.targetStableKeys.length || !view.sourceEvidenceRefs.length)) {
      context.addIssue({ code: "custom", message: "detail tasks require target components and local evidence", path: ["views", index] });
    }
    if (view.kind === "detail" && (!view.cropBoundsMm || view.cropBoundsMm[2] <= view.cropBoundsMm[0] || view.cropBoundsMm[3] <= view.cropBoundsMm[1])) {
      context.addIssue({ code: "custom", message: "detail tasks require positive local crop bounds", path: ["views", index, "cropBoundsMm"] });
    }
  }
});

export const TaskDefinitionSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(200),
  scope: z.array(z.string().min(1).max(200)).min(1).max(200),
  regulationRefs: z.array(NonEmptyRefSchema).max(100),
  deliverables: z.array(z.string().min(1).max(120)).min(1).max(100),
  responsibilities: z.array(ResponsibilitySchema).min(1).max(100),
  automationPolicyRef: NonEmptyRefSchema.nullable(),
  artifactRequirements: TaskArtifactRequirementsSchema.optional(),
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

// 规范选择类问题的并列方案（架构 v1.4 §10）：每个方案含数值、规则集引用与系数出处
export const IssueOptionSchema = z.object({
  optionId: z.string().min(1).max(120),
  labelZh: z.string().min(1).max(200),
  valueText: z.string().min(1).max(500),
  ruleSetRef: z.string().min(1).max(120),
  sourceText: z.string().min(1).max(500),
}).strict();

export const IssueSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  issueType: z.enum(["missingEvidence", "professionalUncertainty", "ruleConflict", "highRisk"]),
  subjectRefs: z.array(NonEmptyRefSchema).min(1).max(500),
  description: z.string().min(1).max(5_000),
  sourceRef: NonEmptyRefSchema,
  status: z.enum(["open", "resolved", "rejected", "superseded"]),
  impactRefs: z.array(NonEmptyRefSchema).max(5_000),
  blocksProxyOutcome: z.boolean().default(false),
  blocksFormalEligibility: z.boolean().default(true),
  producer: ProducerRefSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  // v1.4 增补（可选，旧记录不受影响）：规范选择类问题的并列方案
  options: z.array(IssueOptionSchema).min(2).max(20).optional(),
}).strict().superRefine((value, context) => {
  if (value.options && new Set(value.options.map((option) => option.optionId)).size !== value.options.length) {
    context.addIssue({ code: "custom", message: "option ids must be unique", path: ["options"] });
  }
});

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
  geometrySpecs: z.array(ProjectDrivenGeometrySpecSchema).default([]),
  geometryRevisions: z.array(GeometryRevisionSchema).default([]),
  adoptedRecordRefs: z.array(NonEmptyRefSchema),
}).strict().superRefine((value, context) => {
  if (value.buildings.some((building) => building.projectId !== value.project.id)) {
    context.addIssue({ code: "custom", message: "building projectId must match project", path: ["buildings"] });
  }
});

export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
export type TaskArtifactRequirements = z.infer<typeof TaskArtifactRequirementsSchema>;
export type MeasurementRecord = z.infer<typeof MeasurementRecordSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type ParseRecord = z.infer<typeof ParseRecordSchema>;
