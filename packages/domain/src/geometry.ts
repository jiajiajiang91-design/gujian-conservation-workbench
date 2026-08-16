import { z } from "zod";

import {
  ExactNumberSchema,
  IsoDateTimeSchema,
  NonEmptyRefSchema,
  QuantitySchema,
  Sha256Schema,
  UuidSchema,
} from "./primitives.js";
import { ProducerRefSchema } from "./provenance.js";

const GeometrySourceSchema = z.object({
  entityId: UuidSchema,
  factRefs: z.array(NonEmptyRefSchema),
  evidenceRefs: z.array(NonEmptyRefSchema),
  constructionMethod: z.enum(["measured", "rule", "parametricRestoration", "demo"]),
}).strict();

const PointPrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("point"), id: UuidSchema, x: QuantitySchema, y: QuantitySchema, z: QuantitySchema,
}).strict();

const LinePrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("line"), id: UuidSchema, startPointRef: UuidSchema, endPointRef: UuidSchema,
}).strict();

const ArcPrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("arc"), id: UuidSchema, centerPointRef: UuidSchema,
  radius: QuantitySchema, startAngle: QuantitySchema, endAngle: QuantitySchema,
}).strict();

const ProfilePrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("profile"), id: UuidSchema, curveRefs: z.array(UuidSchema).min(1),
  holeProfileRefs: z.array(UuidSchema), closed: z.literal(true),
}).strict();

const ExtrusionPrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("extrusion"), id: UuidSchema, profileRef: UuidSchema,
  depth: QuantitySchema, direction: z.tuple([z.number(), z.number(), z.number()]),
}).strict();

export const GeometryPrimitiveSchema = z.discriminatedUnion("kind", [
  PointPrimitiveSchema, LinePrimitiveSchema, ArcPrimitiveSchema, ProfilePrimitiveSchema, ExtrusionPrimitiveSchema,
]);

export const LegacyGeometrySpecSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectRevisionId: UuidSchema,
  inputHash: Sha256Schema,
  projectCoordinateSystem: z.string().min(1).max(200),
  localCoordinateSystems: z.array(z.object({
    id: UuidSchema,
    name: z.string().min(1).max(120),
    transform: z.tuple([
      z.number(), z.number(), z.number(), z.number(),
      z.number(), z.number(), z.number(), z.number(),
      z.number(), z.number(), z.number(), z.number(),
      z.number(), z.number(), z.number(), z.number(),
    ]),
  }).strict()),
  lengthUnit: z.string().min(1).max(32),
  angleUnit: z.string().min(1).max(32),
  modellingTolerance: QuantitySchema,
  drawingTolerance: QuantitySchema,
  primitives: z.array(GeometryPrimitiveSchema),
  unknownRegions: z.array(z.object({
    id: UuidSchema,
    subjectRef: NonEmptyRefSchema,
    reasonCode: z.string().min(1).max(120),
    evidenceRefs: z.array(NonEmptyRefSchema),
  }).strict()),
  unresolvedConstraintRefs: z.array(NonEmptyRefSchema),
}).strict();

const ParameterBaseSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(120),
  basis: z.enum(["measured", "rule", "human", "demo"]),
  factRefs: z.array(NonEmptyRefSchema).max(500),
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
});

export const TypedParameterSchema = z.discriminatedUnion("valueType", [
  ParameterBaseSchema.extend({ valueType: z.literal("length"), exactValue: ExactNumberSchema, unit: z.literal("mm") }).strict(),
  ParameterBaseSchema.extend({ valueType: z.literal("angle"), exactValue: ExactNumberSchema, unit: z.literal("deg") }).strict(),
  ParameterBaseSchema.extend({ valueType: z.literal("count"), value: z.number().int().nonnegative(), unit: z.literal("1") }).strict(),
  ParameterBaseSchema.extend({ valueType: z.literal("ratio"), exactValue: ExactNumberSchema, unit: z.literal("1") }).strict(),
  ParameterBaseSchema.extend({ valueType: z.literal("text"), value: z.string().min(1).max(2_000), unit: z.literal("1") }).strict(),
]);

export const UnknownValueSchema = z.object({
  id: UuidSchema,
  subjectRef: NonEmptyRefSchema,
  reasonCode: z.string().min(1).max(120),
  description: z.string().min(1).max(2_000),
  requiredEvidence: z.array(z.string().min(1).max(300)).min(1).max(100),
  affectedRefs: z.array(NonEmptyRefSchema).min(1).max(1_000),
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
  blocksProxyOutcome: z.boolean(),
  blocksFormalEligibility: z.boolean(),
}).strict();

const BoxSolidSchema = z.object({
  kind: z.literal("box"),
  sizeX: ExactNumberSchema,
  sizeY: ExactNumberSchema,
  sizeZ: ExactNumberSchema,
  centerMm: z.tuple([z.number(), z.number(), z.number()]),
}).strict();

const CylinderSolidSchema = z.object({
  kind: z.literal("cylinder"),
  radius: ExactNumberSchema,
  height: ExactNumberSchema,
  axis: z.enum(["x", "y", "z"]),
  centerMm: z.tuple([z.number(), z.number(), z.number()]),
}).strict();

const ExtrudedProfileSolidSchema = z.object({
  kind: z.literal("extrudedProfile"),
  profileMm: z.array(z.tuple([z.number(), z.number()])).min(3).max(2_000),
  depth: ExactNumberSchema,
  axis: z.enum(["x", "y", "z"]),
  originMm: z.tuple([z.number(), z.number(), z.number()]),
}).strict();

export const ProjectGeometryObjectSchema = z.object({
  id: UuidSchema,
  stableKey: z.string().min(1).max(200),
  parentId: UuidSchema.nullable(),
  componentType: z.string().min(1).max(120),
  // v1.4 双写迁移（§5.6）：可选词表引用；componentType 字符串保留，worker 侧照旧消费
  conceptRef: z.string().min(1).max(120).optional(),
  displayNameZh: z.string().min(1).max(200),
  materialCode: z.string().min(1).max(120),
  solid: z.discriminatedUnion("kind", [BoxSolidSchema, CylinderSolidSchema, ExtrudedProfileSolidSchema]),
  parameters: z.array(TypedParameterSchema).max(500),
  producer: ProducerRefSchema,
  factRefs: z.array(NonEmptyRefSchema).max(500),
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
  unknownRefs: z.array(UuidSchema).max(500),
}).strict();

export const GeometryInterfaceSchema = z.object({
  id: UuidSchema,
  fromObjectId: UuidSchema,
  toObjectId: UuidSchema,
  interfaceType: z.enum(["contact", "bearing", "containment", "lap"]),
  fromSurface: z.string().min(1).max(120),
  toSurface: z.string().min(1).max(120),
  direction: z.tuple([z.number(), z.number(), z.number()]),
  maximumGapMm: z.number().nonnegative().max(100),
  maximumUnexpectedOverlapMm3: z.number().nonnegative(),
  minimumDeclaredOverlapMm3: z.number().nonnegative().nullable(),
  factRefs: z.array(NonEmptyRefSchema).max(500),
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
}).strict();

export const ProjectDrivenGeometrySpecSchema = z.object({
  schemaVersion: z.literal("2.0"),
  id: UuidSchema,
  projectId: UuidSchema,
  projectRevisionId: UuidSchema,
  buildingId: UuidSchema,
  inputHash: Sha256Schema,
  coordinateSystem: z.object({
    name: z.string().min(1).max(200),
    axisOrder: z.literal("XYZ"),
    upAxis: z.literal("Z"),
    lengthUnit: z.literal("mm"),
    origin: z.tuple([z.number(), z.number(), z.number()]),
  }).strict(),
  tolerances: z.object({
    modellingMm: z.number().positive().max(100),
    interfaceMm: z.number().positive().max(100),
    tessellationMm: z.number().positive().max(100),
  }).strict(),
  objects: z.array(ProjectGeometryObjectSchema).min(1).max(100_000),
  interfaces: z.array(GeometryInterfaceSchema).max(200_000),
  unknowns: z.array(UnknownValueSchema).max(10_000),
  createdAt: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  const objectIds = new Set(value.objects.map((item) => item.id));
  const unknownIds = new Set(value.unknowns.map((item) => item.id));
  if (objectIds.size !== value.objects.length) context.addIssue({ code: "custom", message: "object ids must be unique", path: ["objects"] });
  for (const [index, object] of value.objects.entries()) {
    if (object.parentId !== null && !objectIds.has(object.parentId)) context.addIssue({ code: "custom", message: "parent object is missing", path: ["objects", index, "parentId"] });
    if (object.unknownRefs.some((id) => !unknownIds.has(id))) context.addIssue({ code: "custom", message: "unknown reference is missing", path: ["objects", index, "unknownRefs"] });
  }
  for (const [index, item] of value.interfaces.entries()) {
    if (!objectIds.has(item.fromObjectId) || !objectIds.has(item.toObjectId) || item.fromObjectId === item.toObjectId) {
      context.addIssue({ code: "custom", message: "interface object closure is invalid", path: ["interfaces", index] });
    }
  }
});

export const GeometrySpecSchema = z.discriminatedUnion("schemaVersion", [LegacyGeometrySpecSchema, ProjectDrivenGeometrySpecSchema]);

const GeometryAssetRefSchema = z.object({
  assetId: UuidSchema,
  kind: z.enum(["ifc", "glb", "brepBundle", "manifest", "sourceMap", "report", "preview"]),
  sha256: Sha256Schema,
  mimeType: z.string().min(1).max(200),
  byteLength: z.number().int().nonnegative(),
}).strict();

export const GeometryRevisionSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectRevisionId: UuidSchema,
  geometrySpecId: UuidSchema,
  inputHash: Sha256Schema,
  entityClosureHash: Sha256Schema,
  interfaceClosureHash: Sha256Schema,
  geometrySignature: Sha256Schema,
  assets: z.array(GeometryAssetRefSchema).min(5).max(20),
  status: z.literal("generated-not-qualified"),
  l1Eligible: z.literal(false),
  formalEligibility: z.literal(false),
  blockers: z.array(z.string().min(1).max(160)).min(1).max(100),
  createdAt: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  const kinds = new Set(value.assets.map((asset) => asset.kind));
  // Historical revisions created before the exact-BRep migration remain
  // readable so they can be invalidated and audited. New commits enforce the
  // complete closure in ProjectCommandService and the worker verifier.
  for (const required of ["ifc", "glb", "manifest", "sourceMap", "report", "preview"] as const) {
    if (!kinds.has(required)) context.addIssue({ code: "custom", message: `missing geometry asset ${required}`, path: ["assets"] });
  }
});

export const CadJobEventSchema = z.object({
  id: UuidSchema,
  jobId: UuidSchema,
  sequence: z.number().int().nonnegative(),
  eventType: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "late"]),
  detail: z.string().max(2_000).nullable(),
  occurredAt: IsoDateTimeSchema,
  previousHash: Sha256Schema.nullable(),
  eventHash: Sha256Schema,
}).strict();

export const CadJobSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  inputRevisionId: UuidSchema,
  geometrySpecId: UuidSchema,
  inputHash: Sha256Schema,
  idempotencyKey: UuidSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  events: z.array(CadJobEventSchema).max(10_000),
  outputManifestHash: Sha256Schema.nullable(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
}).strict();

export type TypedParameter = z.infer<typeof TypedParameterSchema>;
export type UnknownValue = z.infer<typeof UnknownValueSchema>;
export type ProjectGeometryObject = z.infer<typeof ProjectGeometryObjectSchema>;
export type ProjectDrivenGeometrySpec = z.infer<typeof ProjectDrivenGeometrySpecSchema>;
export type GeometrySpec = z.infer<typeof GeometrySpecSchema>;
export type GeometryRevision = z.infer<typeof GeometryRevisionSchema>;
export type CadJob = z.infer<typeof CadJobSchema>;
export type CadJobEvent = z.infer<typeof CadJobEventSchema>;
