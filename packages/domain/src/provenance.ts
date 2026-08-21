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
  // 为什么改成这个值。人工确认的事实此前只留下改成了什么，不留为什么，
  // 修改历史里于是只能显示一次写入而说不出理由。旧记录没有这一项，故可选。
  reasonZh: z.string().min(1).max(2_000).optional(),
  dataStatus: DataStatusSchema,
}).strict();

export type ProducerRef = z.infer<typeof ProducerRefSchema>;
export type FactEnvelope = z.infer<typeof FactEnvelopeSchema>;
