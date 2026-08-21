import { z } from 'zod'
import { IsoDateTimeSchema, UuidSchema } from './primitives'

export const ModelProducerSchema = z
  .object({ producerType: z.literal('model'), runId: UuidSchema })
  .strict()

export const RuleProducerSchema = z
  .object({ producerType: z.literal('rule'), ruleRunId: UuidSchema })
  .strict()

export const HumanProducerSchema = z
  .object({
    producerType: z.literal('human'),
    actorId: UuidSchema,
    decisionId: UuidSchema,
  })
  .strict()

export const DemoProducerSchema = z
  .object({ producerType: z.literal('demo'), fixtureId: UuidSchema })
  .strict()

export const BusinessProducerSchema = z.discriminatedUnion('producerType', [
  ModelProducerSchema,
  RuleProducerSchema,
  HumanProducerSchema,
  DemoProducerSchema,
])

export const DerivedMetadataProducerSchema = z
  .object({
    producerType: z.literal('system'),
    operationId: UuidSchema,
    scope: z.literal('derived-metadata'),
  })
  .strict()

export const ReviewStatusSchema = z.enum([
  'unreviewed',
  'confirmed',
  'rejected',
  'superseded',
])

export const DataStatusSchema = z.enum(['available', 'uncertain', 'missing', 'stale'])

export const FormalBlockerCodeSchema = z.enum([
  'DEMO_SOURCE',
  'EVIDENCE_MISSING',
  'REVIEW_REQUIRED',
  'DATA_UNAVAILABLE',
  'ROLE_MISMATCH',
  'MODEL_RUN_MISSING',
  'MEASUREMENT_RECORD_MISSING',
  'RULE_INPUT_INELIGIBLE',
])

export const FormalEligibilitySchema = z
  .object({
    eligible: z.boolean(),
    blockerCodes: z.array(FormalBlockerCodeSchema).max(20),
    policyVersion: z.string().trim().min(1).max(100),
    evaluatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.eligible === (value.blockerCodes.length > 0)) {
      context.addIssue({
        code: 'custom',
        message: '正式资格与阻断原因不一致',
        path: ['eligible'],
      })
    }
  })

export type BusinessProducer = z.infer<typeof BusinessProducerSchema>
export type DerivedMetadataProducer = z.infer<typeof DerivedMetadataProducerSchema>
export type FormalBlockerCode = z.infer<typeof FormalBlockerCodeSchema>
export type FormalEligibility = z.infer<typeof FormalEligibilitySchema>
