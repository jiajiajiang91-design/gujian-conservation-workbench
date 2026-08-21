import { z } from 'zod'
import { FormalEligibilitySchema } from './provenance'
import {
  IsoDateTimeSchema,
  LongTextSchema,
  QuantitySchema,
  Sha256Schema,
  UuidSchema,
} from './primitives'

export const ExecutionRunSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    sourceRevisionId: UuidSchema,
    taskType: z.string().trim().min(1).max(100),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.optional(),
    status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
    inputHash: Sha256Schema,
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cost: z
          .object({
            amount: z.number().nonnegative().finite(),
            currency: z.string().trim().length(3),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === 'running' && run.finishedAt) {
      context.addIssue({ code: 'custom', message: '运行中记录不能有完成时间' })
    }
    if (run.status !== 'running' && !run.finishedAt) {
      context.addIssue({ code: 'custom', message: '终态运行必须有完成时间' })
    }
    if (run.status === 'failed' && !run.errorCode) {
      context.addIssue({ code: 'custom', message: '失败运行必须有错误码' })
    }
  })

export const RuleRunSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    ruleId: z.string().trim().min(1).max(200),
    ruleVersion: z.string().trim().min(1).max(100),
    sourceRevisionId: UuidSchema,
    inputHash: Sha256Schema,
    result: z.enum(['pass', 'fail', 'blocked']),
    outputRefs: z.array(UuidSchema).max(10_000),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const TrustedRuleRefSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100),
    parameters: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(100),
            value: z.union([z.string().max(500), z.number().finite(), z.boolean()]),
          })
          .strict(),
      )
      .max(100),
    contentHash: Sha256Schema,
  })
  .strict()

export const DecisionSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    sourceRevisionId: UuidSchema,
    actorId: UuidSchema,
    actorRole: z.enum(['operator', 'surveyor', 'specialist', 'reviewer', 'signatory']),
    choice: z.enum([
      'accept',
      'reject',
      'replace',
      'resolve',
      'confirm-scope',
      'confirm-proxy',
      'archive',
    ]),
    reason: LongTextSchema,
    scopeRefs: z.array(UuidSchema).min(1).max(1_000),
    decidedAt: IsoDateTimeSchema,
    supersedesDecisionId: UuidSchema.optional(),
  })
  .strict()

export const ArtifactSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    kind: z.enum([
      'elevation-svg',
      'elevation-dxf',
      'evidence-sketch-svg',
      'project-data',
      'check-report',
      'delivery-manifest',
      'audit-log',
    ]),
    sourceRevisionId: UuidSchema,
    generatorVersion: z.string().trim().min(1).max(100),
    assetId: UuidSchema,
    sha256: Sha256Schema,
    status: z.enum(['valid', 'stale', 'superseded']),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const DeliverySchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    sourceRevisionId: UuidSchema,
    mode: z.enum(['proxy', 'formal']),
    artifactIds: z.array(UuidSchema).min(1).max(1_000),
    manifestAssetId: UuidSchema,
    packageAssetId: UuidSchema,
    eligibility: FormalEligibilitySchema,
    createdAt: IsoDateTimeSchema,
    confirmedByDecisionId: UuidSchema,
  })
  .strict()
  .superRefine((delivery, context) => {
    if (delivery.mode === 'formal' && !delivery.eligibility.eligible) {
      context.addIssue({ code: 'custom', message: '正式交付不能保存在阻断状态' })
    }
  })

export const AuditEventSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    commandId: UuidSchema,
    actorId: UuidSchema,
    type: z.string().trim().min(1).max(200),
    timestamp: IsoDateTimeSchema,
    beforeHash: Sha256Schema.nullable(),
    afterHash: Sha256Schema,
    previousEventHash: Sha256Schema.nullable(),
    eventHash: Sha256Schema,
  })
  .strict()

const GeometrySpanSchema = z
  .object({ entityId: UuidSchema, width: QuantitySchema })
  .strict()

export const ElevationGeometrySchema = z
  .object({
    baySpans: z.array(GeometrySpanSchema).min(1).max(100),
    baseHeight: QuantitySchema,
    columnHeight: QuantitySchema,
    roofRise: QuantitySchema,
    eaveProjection: QuantitySchema.optional(),
  })
  .strict()

export const ProxyDrawingInputSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    fixtureId: UuidSchema,
    purpose: z.literal('proxy-artifact-generation'),
    geometry: ElevationGeometrySchema,
    limitations: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
  })
  .strict()

export const EvidenceSketchInputSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    fixtureId: UuidSchema,
    purpose: z.literal('proxy-evidence-sketch'),
    photoLabel: z.string().trim().min(1).max(500),
    boxes: z
      .array(
        z
          .object({
            entityId: UuidSchema,
            label: z.string().trim().min(1).max(200),
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().positive().max(1),
            height: z.number().positive().max(1),
          })
          .strict()
          .superRefine((box, context) => {
            if (box.x + box.width > 1 || box.y + box.height > 1) {
              context.addIssue({ code: 'custom', message: '框选范围超出画布' })
            }
          }),
      )
      .min(1)
      .max(100),
    limitations: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
  })
  .strict()

export type ExecutionRun = z.infer<typeof ExecutionRunSchema>
export type RuleRun = z.infer<typeof RuleRunSchema>
export type Decision = z.infer<typeof DecisionSchema>
export type Artifact = z.infer<typeof ArtifactSchema>
export type Delivery = z.infer<typeof DeliverySchema>
export type AuditEvent = z.infer<typeof AuditEventSchema>
export type ElevationGeometry = z.infer<typeof ElevationGeometrySchema>
export type ProxyDrawingInput = z.infer<typeof ProxyDrawingInputSchema>
export type EvidenceSketchInput = z.infer<typeof EvidenceSketchInputSchema>
