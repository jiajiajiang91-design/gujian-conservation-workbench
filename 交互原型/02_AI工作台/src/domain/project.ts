import { z } from 'zod'
import {
  BusinessProducerSchema,
  DataStatusSchema,
  FormalEligibilitySchema,
  HumanProducerSchema,
  ReviewStatusSchema,
} from './provenance'
import {
  CandidateValueSchema,
  IsoDateTimeSchema,
  LongTextSchema,
  QuantitySchema,
  Sha256Schema,
  ShortTextSchema,
  UuidSchema,
} from './primitives'

export const EvidenceTypeSchema = z.enum([
  'photo',
  'document',
  'drawing',
  'measurement-sheet',
  'survey-note',
  'artifact',
])

const DeclarationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('declared'), statement: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ status: z.literal('missing') }).strict(),
])

export const AssetRecordSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (name) =>
          !name.includes('/') &&
          !name.includes('\\') &&
          !name.includes('\0') &&
          !/^[a-z][a-z0-9+.-]*:/i.test(name),
        '资源名称不能包含路径或 URL',
      ),
    mime: z.enum([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/json',
      'image/svg+xml',
      'application/dxf',
      'text/plain',
      'text/csv',
      'application/zip',
    ]),
    byteSize: z.number().int().nonnegative().max(100 * 1024 * 1024),
    sha256: Sha256Schema,
    importedAt: IsoDateTimeSchema,
  })
  .strict()

export const EvidenceRecordSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    assetId: UuidSchema,
    evidenceType: EvidenceTypeSchema,
    capturedAt: IsoDateTimeSchema.optional(),
    importedAt: IsoDateTimeSchema,
    quality: z.enum(['usable', 'uncertain', 'unusable']),
    relatedEntityRefs: z.array(UuidSchema).max(500),
    declarations: z
      .object({
        ownership: DeclarationSchema,
        permittedUse: DeclarationSchema,
        confidentiality: DeclarationSchema,
      })
      .strict(),
  })
  .strict()

const FactBaseFields = {
  id: UuidSchema,
  projectId: UuidSchema,
  subjectRef: UuidSchema,
  field: z.string().trim().min(1).max(200),
  producer: BusinessProducerSchema,
  evidenceRefs: z.array(UuidSchema).max(100),
  reviewDecisionRefs: z.array(UuidSchema).max(20),
  reviewStatus: ReviewStatusSchema,
  dataStatus: DataStatusSchema,
  formalEligibility: FormalEligibilitySchema,
} as const

export const VisibleObservationSchema = z
  .object({
    ...FactBaseFields,
    observationType: z.literal('visible'),
    value: z.string().trim().min(1).max(4_000),
  })
  .strict()

export const MeasurementRecordSchema = z
  .object({
    ...FactBaseFields,
    observationType: z.literal('measurement'),
    value: QuantitySchema,
    measuredByActorId: UuidSchema,
    measuredAt: IsoDateTimeSchema,
    method: z.string().trim().min(1).max(500),
    originalEvidenceRef: UuidSchema,
    transcriptionCandidateRef: UuidSchema.optional(),
  })
  .strict()

export const ProfessionalConclusionSchema = z
  .object({
    ...FactBaseFields,
    observationType: z.literal('professional-conclusion'),
    producer: HumanProducerSchema,
    value: LongTextSchema,
  })
  .strict()

export const ObservationSchema = z.discriminatedUnion('observationType', [
  VisibleObservationSchema,
  MeasurementRecordSchema,
  ProfessionalConclusionSchema,
])

export const CandidateSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    targetRef: UuidSchema,
    field: z.string().trim().min(1).max(200),
    operation: z.enum(['set', 'add', 'remove']),
    value: CandidateValueSchema,
    sourceRevisionId: UuidSchema,
    inputHash: Sha256Schema,
    producer: z.discriminatedUnion('producerType', [
      z.object({ producerType: z.literal('model'), runId: UuidSchema }).strict(),
      z.object({ producerType: z.literal('rule'), ruleRunId: UuidSchema }).strict(),
      z.object({ producerType: z.literal('demo'), fixtureId: UuidSchema }).strict(),
    ]),
    evidenceRefs: z.array(UuidSchema).max(100),
    confidence: z.number().min(0).max(1).optional(),
    applicability: z.array(z.string().trim().min(1).max(500)).max(100),
    status: z.enum(['unreviewed', 'confirmed', 'rejected', 'superseded', 'stale']),
  })
  .strict()

export const BuildingSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    name: ShortTextSchema,
    location: z.string().trim().max(1_000).optional(),
    protectionLevel: z.string().trim().max(200).optional(),
  })
  .strict()

export const HeritageEntitySchema = z
  .object({
    id: UuidSchema,
    buildingId: UuidSchema,
    parentId: UuidSchema.nullable(),
    kind: z.string().trim().min(1).max(100),
    name: ShortTextSchema,
    location: z.string().trim().max(1_000).optional(),
  })
  .strict()

export const TaskRequirementSchema = z
  .object({
    id: UuidSchema,
    code: z.string().trim().min(1).max(50),
    name: ShortTextSchema,
    description: z.string().trim().max(2_000),
    status: z.enum(['pending', 'ready', 'blocked', 'completed']),
  })
  .strict()

export const RoleAssignmentSchema = z
  .object({
    actorId: UuidSchema,
    role: z.enum(['operator', 'surveyor', 'specialist', 'reviewer', 'signatory']),
    assignedAt: IsoDateTimeSchema,
  })
  .strict()

export const TaskBriefSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    title: ShortTextSchema,
    requirements: z.array(TaskRequirementSchema).max(100),
    standardRefs: z.array(z.string().trim().min(1).max(500)).max(100),
    roleAssignments: z.array(RoleAssignmentSchema).max(100),
    scopeConfirmedAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const IssueSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    type: z.enum(['evidence-gap', 'professional-doubt', 'rule-conflict', 'high-risk']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    subjectRefs: z.array(UuidSchema).min(1).max(100),
    blockerCodes: z.array(z.string().trim().min(1).max(100)).max(50),
    status: z.enum(['open', 'resolved', 'superseded']),
  })
  .strict()

export const ProjectSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z
      .object({
        id: UuidSchema,
        previousRevisionId: UuidSchema.nullable(),
        number: z.number().int().positive(),
        createdAt: IsoDateTimeSchema,
        createdByActorId: UuidSchema,
      })
      .strict(),
    project: z
      .object({
        id: UuidSchema,
        name: ShortTextSchema,
        code: z.string().trim().max(100).optional(),
        status: z.enum(['active', 'archived']),
        createdAt: IsoDateTimeSchema,
        updatedAt: IsoDateTimeSchema,
      })
      .strict(),
    buildings: z.array(BuildingSchema).max(500),
    tasks: z.array(TaskBriefSchema).max(100),
    evidence: z.array(EvidenceRecordSchema).max(10_000),
    entities: z.array(HeritageEntitySchema).max(50_000),
    observations: z.array(ObservationSchema).max(50_000),
    candidates: z.array(CandidateSchema).max(50_000),
    issues: z.array(IssueSchema).max(10_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const projectId = snapshot.project.id
    const idGroups = [
      snapshot.buildings,
      snapshot.tasks,
      snapshot.evidence,
      snapshot.entities,
      snapshot.observations,
      snapshot.candidates,
      snapshot.issues,
    ]
    const allIds = new Set<string>([projectId, snapshot.revision.id])

    for (const group of idGroups) {
      for (const record of group) {
        if (allIds.has(record.id)) {
          context.addIssue({ code: 'custom', message: `ID 重复：${record.id}` })
        }
        allIds.add(record.id)
      }
    }

    const projectRecords = [
      ...snapshot.buildings,
      ...snapshot.tasks,
      ...snapshot.evidence,
      ...snapshot.observations,
      ...snapshot.candidates,
      ...snapshot.issues,
    ]
    for (const record of projectRecords) {
      if (record.projectId !== projectId) {
        context.addIssue({ code: 'custom', message: `记录不属于当前项目：${record.id}` })
      }
    }

    const buildingIds = new Set(snapshot.buildings.map((record) => record.id))
    const entityIds = new Set(snapshot.entities.map((record) => record.id))
    const evidenceById = new Map(snapshot.evidence.map((record) => [record.id, record]))
    const validSubjects = new Set([...buildingIds, ...entityIds])

    for (const entity of snapshot.entities) {
      if (!buildingIds.has(entity.buildingId)) {
        context.addIssue({ code: 'custom', message: `构件缺少所属建筑：${entity.id}` })
      }
      if (entity.parentId && !entityIds.has(entity.parentId)) {
        context.addIssue({ code: 'custom', message: `构件缺少上级对象：${entity.id}` })
      }
    }

    for (const fact of snapshot.observations) {
      if (!validSubjects.has(fact.subjectRef)) {
        context.addIssue({ code: 'custom', message: `观察对象不存在：${fact.id}` })
      }
      for (const evidenceRef of fact.evidenceRefs) {
        if (!evidenceById.has(evidenceRef)) {
          context.addIssue({ code: 'custom', message: `观察证据不存在：${fact.id}` })
        }
      }
      if (fact.observationType === 'measurement') {
        const original = evidenceById.get(fact.originalEvidenceRef)
        if (!original || !['measurement-sheet', 'survey-note'].includes(original.evidenceType)) {
          context.addIssue({ code: 'custom', message: `测量记录缺少现场原记录：${fact.id}` })
        }
      }
    }

    for (const candidate of snapshot.candidates) {
      if (!validSubjects.has(candidate.targetRef)) {
        context.addIssue({ code: 'custom', message: `候选目标不存在：${candidate.id}` })
      }
      for (const evidenceRef of candidate.evidenceRefs) {
        if (!evidenceById.has(evidenceRef)) {
          context.addIssue({ code: 'custom', message: `候选证据不存在：${candidate.id}` })
        }
      }
    }
  })

export type AssetRecord = z.infer<typeof AssetRecordSchema>
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>
export type Observation = z.infer<typeof ObservationSchema>
export type MeasurementRecord = z.infer<typeof MeasurementRecordSchema>
export type Candidate = z.infer<typeof CandidateSchema>
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>
