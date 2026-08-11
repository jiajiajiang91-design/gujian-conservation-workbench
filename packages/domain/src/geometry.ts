import { z } from "zod";

import { NonEmptyRefSchema, QuantitySchema, Sha256Schema, UuidSchema } from "./primitives.js";

const GeometrySourceSchema = z.object({
  entityId: UuidSchema,
  factRefs: z.array(NonEmptyRefSchema),
  evidenceRefs: z.array(NonEmptyRefSchema),
  constructionMethod: z.enum(["measured", "rule", "parametricRestoration", "demo"]),
}).strict();

const PointPrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("point"),
  id: UuidSchema,
  x: QuantitySchema,
  y: QuantitySchema,
  z: QuantitySchema,
}).strict();

const LinePrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("line"),
  id: UuidSchema,
  startPointRef: UuidSchema,
  endPointRef: UuidSchema,
}).strict();

const ArcPrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("arc"),
  id: UuidSchema,
  centerPointRef: UuidSchema,
  radius: QuantitySchema,
  startAngle: QuantitySchema,
  endAngle: QuantitySchema,
}).strict();

const ProfilePrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("profile"),
  id: UuidSchema,
  curveRefs: z.array(UuidSchema).min(1),
  holeProfileRefs: z.array(UuidSchema),
  closed: z.literal(true),
}).strict();

const ExtrusionPrimitiveSchema = GeometrySourceSchema.extend({
  kind: z.literal("extrusion"),
  id: UuidSchema,
  profileRef: UuidSchema,
  depth: QuantitySchema,
  direction: z.tuple([z.number(), z.number(), z.number()]),
}).strict();

export const GeometryPrimitiveSchema = z.discriminatedUnion("kind", [
  PointPrimitiveSchema,
  LinePrimitiveSchema,
  ArcPrimitiveSchema,
  ProfilePrimitiveSchema,
  ExtrusionPrimitiveSchema,
]);

export const GeometrySpecSchema = z.object({
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

export type GeometrySpec = z.infer<typeof GeometrySpecSchema>;
