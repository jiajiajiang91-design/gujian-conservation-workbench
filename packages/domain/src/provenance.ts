import { z } from "zod";

import {
  DataStatusSchema,
  NonEmptyRefSchema,
  ReviewStatusSchema,
  UuidSchema,
} from "./primitives.js";

const ModelProducerSchema = z.object({
  producerType: z.literal("model"),
  runId: UuidSchema,
}).strict();

const RuleProducerSchema = z.object({
  producerType: z.literal("rule"),
  ruleRunId: UuidSchema,
}).strict();

const HumanProducerSchema = z.object({
  producerType: z.literal("human"),
  actorId: UuidSchema,
  actionRef: z.object({
    commandId: UuidSchema,
    decisionId: UuidSchema.optional(),
  }).strict(),
}).strict();

const DemoProducerSchema = z.object({
  producerType: z.literal("demo"),
  fixtureId: z.string().min(1).max(120),
}).strict();

export const ProducerRefSchema = z.discriminatedUnion("producerType", [
  ModelProducerSchema,
  RuleProducerSchema,
  HumanProducerSchema,
  DemoProducerSchema,
]);

export const AcceptanceRefSchema = z.object({
  type: z.enum(["policy", "decision", "command"]),
  id: UuidSchema,
}).strict();

export const FactEnvelopeSchema = z.object({
  id: UuidSchema,
  subjectRef: NonEmptyRefSchema,
  field: z.string().min(1).max(120),
  value: z.unknown(),
  producer: ProducerRefSchema,
  evidenceRefs: z.array(NonEmptyRefSchema).max(500),
  reviewStatus: ReviewStatusSchema,
  acceptanceRef: AcceptanceRefSchema.optional(),
  dataStatus: DataStatusSchema,
}).strict();

export type ProducerRef = z.infer<typeof ProducerRefSchema>;
export type FactEnvelope = z.infer<typeof FactEnvelopeSchema>;
