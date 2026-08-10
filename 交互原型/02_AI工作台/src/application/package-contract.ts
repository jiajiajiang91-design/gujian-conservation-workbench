import { z } from 'zod'
import {
  ArtifactSchema,
  AssetRecordSchema,
  AuditEventSchema,
  DecisionSchema,
  DeliverySchema,
  ExecutionRunSchema,
  IsoDateTimeSchema,
  ProjectSnapshotSchema,
  RuleRunSchema,
  Sha256Schema,
  UuidSchema,
} from '../domain'

export const PackageLimits = {
  compressedBytes: 250 * 1024 * 1024,
  singleFileBytes: 25 * 1024 * 1024,
  fileCount: 200,
  expandedBytes: 500 * 1024 * 1024,
  compressionRatio: 100,
  projectJsonBytes: 5 * 1024 * 1024,
} as const

export const ProjectTransferSchema = z
  .object({
    packageVersion: z.literal(1),
    revision: ProjectSnapshotSchema,
    assets: z.array(AssetRecordSchema).max(10_000),
    modelRuns: z.array(ExecutionRunSchema).max(10_000),
    ruleRuns: z.array(RuleRunSchema).max(10_000),
    decisions: z.array(DecisionSchema).max(10_000),
    artifacts: z.array(ArtifactSchema).max(10_000),
    deliveries: z.array(DeliverySchema).max(1_000),
    audit: z
      .object({
        included: z.boolean(),
        headHash: Sha256Schema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((transfer, context) => {
    const projectId = transfer.revision.project.id
    const assetIds = new Set(transfer.assets.map((record) => record.id))
    const modelRunIds = new Set(transfer.modelRuns.map((record) => record.id))
    const ruleRunIds = new Set(transfer.ruleRuns.map((record) => record.id))
    const decisionIds = new Set(transfer.decisions.map((record) => record.id))
    const artifactIds = new Set(transfer.artifacts.map((record) => record.id))

    const records = [
      ...transfer.assets,
      ...transfer.modelRuns,
      ...transfer.ruleRuns,
      ...transfer.decisions,
      ...transfer.artifacts,
      ...transfer.deliveries,
    ]
    for (const record of records) {
      if (record.projectId !== projectId) {
        context.addIssue({ code: 'custom', message: `记录不属于当前项目：${record.id}` })
      }
    }
    for (const evidence of transfer.revision.evidence) {
      if (!assetIds.has(evidence.assetId)) {
        context.addIssue({ code: 'custom', message: `证据资源不存在：${evidence.id}` })
      }
    }
    for (const observation of transfer.revision.observations) {
      const producer = observation.producer
      if (producer.producerType === 'model' && !modelRunIds.has(producer.runId)) {
        context.addIssue({ code: 'custom', message: `事实缺少模型运行：${observation.id}` })
      }
      if (producer.producerType === 'rule' && !ruleRunIds.has(producer.ruleRunId)) {
        context.addIssue({ code: 'custom', message: `事实缺少规则运行：${observation.id}` })
      }
      if (producer.producerType === 'human' && !decisionIds.has(producer.decisionId)) {
        context.addIssue({ code: 'custom', message: `事实缺少人工决定：${observation.id}` })
      }
      for (const decisionRef of observation.reviewDecisionRefs) {
        if (!decisionIds.has(decisionRef)) {
          context.addIssue({ code: 'custom', message: `事实缺少核对决定：${observation.id}` })
        }
      }
    }
    for (const candidate of transfer.revision.candidates) {
      if (candidate.producer.producerType === 'model' && !modelRunIds.has(candidate.producer.runId)) {
        context.addIssue({ code: 'custom', message: `候选缺少模型运行：${candidate.id}` })
      }
      if (
        candidate.producer.producerType === 'rule' &&
        !ruleRunIds.has(candidate.producer.ruleRunId)
      ) {
        context.addIssue({ code: 'custom', message: `候选缺少规则运行：${candidate.id}` })
      }
    }
    for (const artifact of transfer.artifacts) {
      if (!assetIds.has(artifact.assetId)) {
        context.addIssue({ code: 'custom', message: `成果资源不存在：${artifact.id}` })
      }
    }
    for (const delivery of transfer.deliveries) {
      if (!assetIds.has(delivery.manifestAssetId) || !assetIds.has(delivery.packageAssetId)) {
        context.addIssue({ code: 'custom', message: `交付资源不存在：${delivery.id}` })
      }
      if (!delivery.artifactIds.every((artifactId) => artifactIds.has(artifactId))) {
        context.addIssue({ code: 'custom', message: `交付成果不存在：${delivery.id}` })
      }
      if (!decisionIds.has(delivery.confirmedByDecisionId)) {
        context.addIssue({ code: 'custom', message: `交付缺少确认决定：${delivery.id}` })
      }
    }
  })

const PackageMimeSchema = z.enum([
  'application/json',
  'application/x-ndjson',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'image/svg+xml',
  'application/dxf',
  'text/plain',
  'text/csv',
])

export const PackageFileEntrySchema = z
  .object({
    path: z.string().trim().min(1).max(500),
    mime: PackageMimeSchema,
    byteSize: z.number().int().nonnegative().max(PackageLimits.singleFileBytes),
    sha256: Sha256Schema,
    purpose: z.enum(['project-data', 'audit', 'evidence', 'artifact']),
    assetId: UuidSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const requiresAsset = entry.purpose === 'evidence' || entry.purpose === 'artifact'
    if (requiresAsset !== Boolean(entry.assetId)) {
      context.addIssue({ code: 'custom', message: '资源文件与 assetId 不一致' })
    }
  })

export const PackageManifestSchema = z
  .object({
    packageKind: z.enum(['project-archive', 'proxy-delivery', 'formal-delivery']),
    packageVersion: z.literal(1),
    projectId: UuidSchema,
    revisionId: UuidSchema,
    createdAt: IsoDateTimeSchema,
    files: z.array(PackageFileEntrySchema).min(1).max(PackageLimits.fileCount),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>()
    const assetIds = new Set<string>()
    for (const file of manifest.files) {
      const normalized = file.path.normalize('NFC').toLocaleLowerCase('en-US')
      if (paths.has(normalized)) {
        context.addIssue({ code: 'custom', message: `清单路径重复：${file.path}` })
      }
      paths.add(normalized)
      if (file.assetId) {
        if (assetIds.has(file.assetId)) {
          context.addIssue({ code: 'custom', message: `清单资源重复：${file.assetId}` })
        }
        assetIds.add(file.assetId)
      }
    }
  })

export const ProjectPackageAuditSchema = z.array(AuditEventSchema).max(100_000)

export type ProjectTransfer = z.infer<typeof ProjectTransferSchema>
export type PackageManifest = z.infer<typeof PackageManifestSchema>
export type PackageFileEntry = z.infer<typeof PackageFileEntrySchema>

export interface PackagePreview {
  packageKind: 'project-json' | 'project-archive' | 'proxy-delivery' | 'formal-delivery'
  projectId: string
  revisionId: string
  projectName: string
  assetCount: number
  auditIncluded: boolean
  warnings: string[]
}

export interface ValidationReport {
  valid: boolean
  preview?: PackagePreview
  errors: string[]
}

export interface ImportResult {
  projectId: string
  revisionId: string
  assetCount: number
  missingAssetCount: number
  auditStatus: 'complete' | 'not-included'
}
