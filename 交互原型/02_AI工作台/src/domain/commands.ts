import { z } from 'zod'
import { CandidateValueSchema, IsoDateTimeSchema, Sha256Schema, UuidSchema } from './primitives'

export const ActorRoleSchema = z.enum([
  'operator',
  'surveyor',
  'specialist',
  'reviewer',
  'signatory',
])

const ActorSchema = z.object({ id: UuidSchema, role: ActorRoleSchema }).strict()
const ExistingCommandFields = {
  id: UuidSchema,
  projectId: UuidSchema,
  actor: ActorSchema,
  expectedRevisionId: UuidSchema,
  issuedAt: IsoDateTimeSchema,
} as const

const CandidateProposalSchema = z
  .object({
    id: UuidSchema,
    targetRef: UuidSchema,
    field: z.string().trim().min(1).max(200),
    operation: z.enum(['set', 'add', 'remove']),
    value: CandidateValueSchema,
    evidenceRefs: z.array(UuidSchema).max(100),
    confidence: z.number().min(0).max(1).optional(),
    applicability: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict()

export const ProjectCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: UuidSchema,
      projectId: UuidSchema,
      type: z.literal('CreateProject'),
      actor: ActorSchema,
      expectedRevisionId: z.null(),
      issuedAt: IsoDateTimeSchema,
      payload: z
        .object({
          name: z.string().trim().min(1).max(200),
          buildingName: z.string().trim().min(1).max(200),
          taskTitle: z.string().trim().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('ConfirmTaskScope'),
      payload: z
        .object({
          taskId: UuidSchema,
          standardRefs: z.array(z.string().trim().min(1).max(500)).max(100),
          roleAssignments: z
            .array(
              z
                .object({ actorId: UuidSchema, role: ActorRoleSchema, assignedAt: IsoDateTimeSchema })
                .strict(),
            )
            .max(100),
          reason: z.string().trim().min(1).max(4_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('StartModelRun'),
      payload: z
        .object({
          runId: UuidSchema,
          taskType: z.string().trim().min(1).max(100),
          provider: z.string().trim().min(1).max(100),
          model: z.string().trim().min(1).max(200),
          inputHash: Sha256Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('CompleteModelRun'),
      payload: z
        .object({
          runId: UuidSchema,
          finishedAt: IsoDateTimeSchema,
          candidates: z.array(CandidateProposalSchema).max(10_000),
          usage: z
            .object({
              inputTokens: z.number().int().nonnegative(),
              outputTokens: z.number().int().nonnegative(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('FailModelRun'),
      payload: z
        .object({
          runId: UuidSchema,
          finishedAt: IsoDateTimeSchema,
          status: z.enum(['failed', 'cancelled']),
          errorCode: z.string().trim().min(1).max(100).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('CommitRuleEvaluation'),
      payload: z
        .object({
          runId: UuidSchema,
          ruleId: z.string().trim().min(1).max(200),
          ruleVersion: z.string().trim().min(1).max(100),
          inputHash: Sha256Schema,
          result: z.enum(['pass', 'fail', 'blocked']),
          candidates: z.array(CandidateProposalSchema).max(10_000),
          issues: z
            .array(
              z
                .object({
                  id: UuidSchema,
                  type: z.enum(['evidence-gap', 'professional-doubt', 'rule-conflict', 'high-risk']),
                  severity: z.enum(['low', 'medium', 'high', 'critical']),
                  subjectRefs: z.array(UuidSchema).min(1).max(100),
                  blockerCodes: z.array(z.string().trim().min(1).max(100)).max(50),
                })
                .strict(),
            )
            .max(10_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('DecideCandidate'),
      payload: z
        .object({
          candidateId: UuidSchema,
          choice: z.enum(['accept', 'reject', 'replace']),
          reason: z.string().trim().min(1).max(4_000),
          replacementValue: z.string().trim().min(1).max(4_000).optional(),
        })
        .strict()
        .superRefine((payload, context) => {
          if (payload.choice === 'replace' && !payload.replacementValue) {
            context.addIssue({ code: 'custom', message: '替代候选必须提供新值' })
          }
        }),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('ResolveIssue'),
      payload: z
        .object({ issueId: UuidSchema, reason: z.string().trim().min(1).max(4_000) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('UpdateFact'),
      payload: z
        .object({
          observationId: UuidSchema,
          value: z.string().trim().min(1).max(4_000),
          reason: z.string().trim().min(1).max(4_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ExistingCommandFields,
      type: z.literal('ArchiveProject'),
      payload: z.object({ reason: z.string().trim().min(1).max(4_000) }).strict(),
    })
    .strict(),
])

export type ActorRole = z.infer<typeof ActorRoleSchema>
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>

export type CommandResult =
  | {
      ok: true
      revisionId: string
      changedRefs: string[]
      invalidatedRefs: string[]
    }
  | {
      ok: false
      code: string
      message: string
      fieldErrors?: Record<string, string>
    }
