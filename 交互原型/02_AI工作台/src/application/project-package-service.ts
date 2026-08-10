import { strToU8, zipSync } from 'fflate'
import type { AuditEvent, Observation } from '../domain'
import { AuditEventSchema } from '../domain'
import { sha256Hex } from '../infrastructure/hash'
import {
  IndexedDbProjectRepository,
  type RepositoryExport,
} from '../infrastructure/indexeddb-repository'
import { assertSafePackagePath, extractZip, type ExtractedZip } from '../infrastructure/zip-reader'
import {
  type ImportResult,
  type PackageFileEntry,
  PackageLimits,
  PackageManifestSchema,
  type PackagePreview,
  type ProjectTransfer,
  ProjectTransferSchema,
  type ValidationReport,
} from './package-contract'

const textDecoder = new TextDecoder('utf-8', { fatal: true })

interface ParsedPackage {
  transfer: ProjectTransfer
  contents: Map<string, Blob>
  auditEvents: AuditEvent[]
  packageKind: 'project-json' | 'project-archive' | 'proxy-delivery' | 'formal-delivery'
}

export interface ImportOptions {
  onConflict?: 'reject' | 'copy'
}

function cloneParsedPackage(parsed: ParsedPackage): ParsedPackage {
  const source = parsed.transfer
  const idMap = new Map<string, string>()
  const add = (value: string) => idMap.set(value, crypto.randomUUID())
  const map = (value: string) => idMap.get(value) ?? value
  const mapOptional = (value: string | undefined) => (value ? map(value) : undefined)

  add(source.revision.project.id)
  add(source.revision.revision.id)
  for (const group of [
    source.revision.buildings,
    source.revision.tasks,
    source.revision.evidence,
    source.revision.entities,
    source.revision.observations,
    source.revision.candidates,
    source.revision.issues,
    source.assets,
    source.modelRuns,
    source.ruleRuns,
    source.decisions,
    source.artifacts,
    source.deliveries,
  ]) {
    for (const record of group) add(record.id)
  }
  for (const task of source.revision.tasks) {
    for (const requirement of task.requirements) add(requirement.id)
  }

  const projectId = map(source.revision.project.id)
  const revisionId = map(source.revision.revision.id)
  const now = new Date().toISOString()
  const mapProducer = <T extends { producerType: string }>(producer: T) => {
    if (producer.producerType === 'model' && 'runId' in producer) {
      return { ...producer, runId: map(String(producer.runId)) }
    }
    if (producer.producerType === 'rule' && 'ruleRunId' in producer) {
      return { ...producer, ruleRunId: map(String(producer.ruleRunId)) }
    }
    if (producer.producerType === 'human' && 'decisionId' in producer) {
      return { ...producer, decisionId: map(String(producer.decisionId)) }
    }
    return producer
  }
  const mapObservation = (record: Observation): Observation => {
    if (record.observationType === 'professional-conclusion') {
      return {
        ...record,
        id: map(record.id),
        projectId,
        subjectRef: map(record.subjectRef),
        evidenceRefs: record.evidenceRefs.map(map),
        reviewDecisionRefs: record.reviewDecisionRefs.map(map),
        producer: { ...record.producer, decisionId: map(record.producer.decisionId) },
      }
    }
    if (record.observationType === 'measurement') {
      return {
        ...record,
        id: map(record.id),
        projectId,
        subjectRef: map(record.subjectRef),
        evidenceRefs: record.evidenceRefs.map(map),
        reviewDecisionRefs: record.reviewDecisionRefs.map(map),
        producer: mapProducer(record.producer),
        originalEvidenceRef: map(record.originalEvidenceRef),
        transcriptionCandidateRef: mapOptional(record.transcriptionCandidateRef),
      }
    }
    return {
      ...record,
      id: map(record.id),
      projectId,
      subjectRef: map(record.subjectRef),
      evidenceRefs: record.evidenceRefs.map(map),
      reviewDecisionRefs: record.reviewDecisionRefs.map(map),
      producer: mapProducer(record.producer),
    }
  }

  const transfer: ProjectTransfer = {
    packageVersion: 1,
    revision: {
      ...source.revision,
      revision: {
        ...source.revision.revision,
        id: revisionId,
        previousRevisionId: null,
        number: 1,
        createdAt: now,
      },
      project: {
        ...source.revision.project,
        id: projectId,
        name: `${source.revision.project.name}（副本）`,
        createdAt: now,
        updatedAt: now,
      },
      buildings: source.revision.buildings.map((record) => ({
        ...record,
        id: map(record.id),
        projectId,
      })),
      tasks: source.revision.tasks.map((record) => ({
        ...record,
        id: map(record.id),
        projectId,
        requirements: record.requirements.map((requirement) => ({
          ...requirement,
          id: map(requirement.id),
        })),
      })),
      evidence: source.revision.evidence.map((record) => ({
        ...record,
        id: map(record.id),
        projectId,
        assetId: map(record.assetId),
        relatedEntityRefs: record.relatedEntityRefs.map(map),
      })),
      entities: source.revision.entities.map((record) => ({
        ...record,
        id: map(record.id),
        buildingId: map(record.buildingId),
        parentId: record.parentId ? map(record.parentId) : null,
      })),
      observations: source.revision.observations.map(mapObservation),
      candidates: source.revision.candidates.map((record) => ({
        ...record,
        id: map(record.id),
        projectId,
        targetRef: map(record.targetRef),
        sourceRevisionId: revisionId,
        producer: mapProducer(record.producer),
        evidenceRefs: record.evidenceRefs.map(map),
      })),
      issues: source.revision.issues.map((record) => ({
        ...record,
        id: map(record.id),
        projectId,
        subjectRefs: record.subjectRefs.map(map),
      })),
    },
    assets: source.assets.map((record) => ({
      ...record,
      id: map(record.id),
      projectId,
    })),
    modelRuns: source.modelRuns.map((record) => ({
      ...record,
      id: map(record.id),
      projectId,
      sourceRevisionId: revisionId,
    })),
    ruleRuns: source.ruleRuns.map((record) => ({
      ...record,
      id: map(record.id),
      projectId,
      sourceRevisionId: revisionId,
      outputRefs: record.outputRefs.map(map),
    })),
    decisions: source.decisions.map((record) => ({
      ...record,
      id: map(record.id),
      projectId,
      sourceRevisionId: revisionId,
      scopeRefs: record.scopeRefs.map(map),
      supersedesDecisionId: mapOptional(record.supersedesDecisionId),
    })),
    artifacts: source.artifacts.map((record) => ({
      ...record,
      id: map(record.id),
      projectId,
      sourceRevisionId: revisionId,
      assetId: map(record.assetId),
    })),
    deliveries: source.deliveries.map((record) => ({
      ...record,
      id: map(record.id),
      projectId,
      sourceRevisionId: revisionId,
      artifactIds: record.artifactIds.map(map),
      manifestAssetId: map(record.manifestAssetId),
      packageAssetId: map(record.packageAssetId),
      confirmedByDecisionId: map(record.confirmedByDecisionId),
    })),
    audit: { included: false, headHash: null },
  }

  const contents = new Map<string, Blob>()
  for (const [assetId, content] of parsed.contents) contents.set(map(assetId), content)
  return { transfer: ProjectTransferSchema.parse(transfer), contents, auditEvents: [], packageKind: parsed.packageKind }
}

function decodeText(bytes: Uint8Array, label: string): string {
  try {
    return textDecoder.decode(bytes)
  } catch {
    throw new Error(`${label} 不是有效的 UTF-8 文本`)
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decodeText(bytes, label))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} 不是有效的 JSON`)
    throw error
  }
}

function parseProjectJson(bytes: Uint8Array): ProjectTransfer {
  if (bytes.byteLength > PackageLimits.projectJsonBytes) {
    throw new Error('project.json 超过大小限制')
  }
  const result = ProjectTransferSchema.safeParse(parseJson(bytes, 'project.json'))
  if (!result.success) {
    throw new Error(`project.json 不符合数据结构：${result.error.issues[0]?.message ?? '未知错误'}`)
  }
  return result.data
}

function parseAudit(bytes: Uint8Array): AuditEvent[] {
  const text = decodeText(bytes, 'audit/events.ndjson').trim()
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines.length > 100_000) throw new Error('审计记录数量超过限制')
  return lines.map((line, index) => {
    const result = AuditEventSchema.safeParse(parseJson(strToU8(line), `审计记录第 ${index + 1} 行`))
    if (!result.success) throw new Error(`审计记录第 ${index + 1} 行不符合数据结构`)
    return result.data
  })
}

function validateAuditChain(transfer: ProjectTransfer, events: AuditEvent[]): void {
  if (transfer.audit.included !== (events.length > 0)) {
    throw new Error('审计包含状态与审计正文不一致')
  }
  let previousHash: string | null = null
  for (const event of events) {
    if (event.projectId !== transfer.revision.project.id) {
      throw new Error('审计记录不属于当前项目')
    }
    if (event.previousEventHash !== previousHash) {
      throw new Error('审计记录哈希链不连续')
    }
    previousHash = event.eventHash
  }
  if (previousHash !== transfer.audit.headHash) {
    throw new Error('审计头哈希与审计正文不一致')
  }
}

function isMimeContent(bytes: Uint8Array, mime: string): boolean {
  const startsWith = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  if (mime === 'image/jpeg') return startsWith(0xff, 0xd8, 0xff)
  if (mime === 'image/png') return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  if (mime === 'image/webp') {
    return (
      decodeText(bytes.slice(0, 4), 'WebP 文件头') === 'RIFF' &&
      decodeText(bytes.slice(8, 12), 'WebP 文件头') === 'WEBP'
    )
  }
  if (mime === 'application/pdf') return decodeText(bytes.slice(0, 5), 'PDF 文件头') === '%PDF-'
  if (mime === 'application/json') {
    try {
      JSON.parse(decodeText(bytes, 'JSON 文件'))
      return true
    } catch {
      return false
    }
  }
  if (mime === 'application/x-ndjson') {
    try {
      const text = decodeText(bytes, 'NDJSON 文件').trim()
      return !text || text.split(/\r?\n/).every((line) => Boolean(JSON.parse(line)))
    } catch {
      return false
    }
  }
  if (mime === 'image/svg+xml') {
    try {
      return /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(decodeText(bytes, 'SVG 文件').trimStart())
    } catch {
      return false
    }
  }
  if (mime === 'application/dxf') {
    try {
      return /^\s*0\s*(?:\r?\n)SECTION\b/i.test(decodeText(bytes, 'DXF 文件'))
    } catch {
      return false
    }
  }
  if (mime === 'text/plain' || mime === 'text/csv') {
    try {
      decodeText(bytes, '文本文件')
      return true
    } catch {
      return false
    }
  }
  return false
}

function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'image/svg+xml': 'svg',
    'application/dxf': 'dxf',
    'text/plain': 'txt',
    'text/csv': 'csv',
  }
  const extension = extensions[mime]
  if (!extension) throw new Error(`不支持写入项目包的 MIME：${mime}`)
  return extension
}

function packagePreview(
  transfer: ProjectTransfer,
  packageKind: PackagePreview['packageKind'],
  missingAssetCount: number,
): PackagePreview {
  const warnings = []
  if (!transfer.audit.included) warnings.push('审计正文未包含')
  if (missingAssetCount > 0) warnings.push(`${missingAssetCount} 个资源缺失`)
  return {
    packageKind,
    projectId: transfer.revision.project.id,
    revisionId: transfer.revision.revision.id,
    projectName: transfer.revision.project.name,
    assetCount: transfer.assets.length,
    auditIncluded: transfer.audit.included,
    warnings,
  }
}

function verifyManifestFiles(entries: ExtractedZip, manifest: ReturnType<typeof PackageManifestSchema.parse>) {
  const actualPaths = new Set([...entries.keys()].filter((path) => path !== 'manifest.json'))
  const declaredPaths = new Set(manifest.files.map((file) => file.path))
  for (const path of actualPaths) {
    if (!declaredPaths.has(path)) throw new Error(`项目包包含未声明文件：${path}`)
  }
  for (const file of manifest.files) {
    assertSafePackagePath(file.path)
    const entry = entries.get(file.path)
    if (!entry) throw new Error(`项目包缺少文件：${file.path}`)
    if (entry.bytes.byteLength !== file.byteSize) throw new Error(`文件大小不符：${file.path}`)
    if (entry.sha256 !== file.sha256) throw new Error(`文件哈希不符：${file.path}`)
    if (!isMimeContent(entry.bytes, file.mime)) throw new Error(`文件内容与 MIME 不符：${file.path}`)
  }
  if (actualPaths.size !== declaredPaths.size) throw new Error('项目包文件表不完整')
}

async function parseZipPackage(blob: Blob): Promise<ParsedPackage> {
  const entries = await extractZip(blob)
  const manifestEntry = entries.get('manifest.json')
  if (!manifestEntry) throw new Error('项目包缺少 manifest.json')
  const manifestResult = PackageManifestSchema.safeParse(
    parseJson(manifestEntry.bytes, 'manifest.json'),
  )
  if (!manifestResult.success) {
    throw new Error(`manifest.json 不符合数据结构：${manifestResult.error.issues[0]?.message ?? ''}`)
  }
  const manifest = manifestResult.data
  verifyManifestFiles(entries, manifest)

  const projectFile = manifest.files.find(
    (file) => file.path === 'project.json' && file.purpose === 'project-data',
  )
  if (!projectFile) throw new Error('清单缺少 project.json')
  const projectEntry = entries.get(projectFile.path)
  if (!projectEntry) throw new Error('项目包缺少 project.json')
  const transfer = parseProjectJson(projectEntry.bytes)
  if (
    transfer.revision.project.id !== manifest.projectId ||
    transfer.revision.revision.id !== manifest.revisionId
  ) {
    throw new Error('清单项目身份与 project.json 不一致')
  }

  const auditFile = manifest.files.find((file) => file.purpose === 'audit')
  const auditEvents = auditFile ? parseAudit(entries.get(auditFile.path)!.bytes) : []
  validateAuditChain(transfer, auditEvents)

  const assetsById = new Map(transfer.assets.map((asset) => [asset.id, asset]))
  const contents = new Map<string, Blob>()
  for (const file of manifest.files) {
    if (!file.assetId) continue
    const asset = assetsById.get(file.assetId)
    if (!asset) throw new Error(`清单引用未知资源：${file.assetId}`)
    if (asset.mime !== file.mime || asset.byteSize !== file.byteSize || asset.sha256 !== file.sha256) {
      throw new Error(`资源元数据与清单不一致：${file.assetId}`)
    }
    const entry = entries.get(file.path)!
    const content = new Uint8Array(entry.bytes.byteLength)
    content.set(entry.bytes)
    contents.set(file.assetId, new Blob([content.buffer], { type: file.mime }))
  }

  return { transfer, contents, auditEvents, packageKind: manifest.packageKind }
}

function auditText(events: AuditEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
}

function addFile(
  archive: Record<string, Uint8Array>,
  files: PackageFileEntry[],
  path: string,
  mime: PackageFileEntry['mime'],
  bytes: Uint8Array,
  purpose: PackageFileEntry['purpose'],
  assetId?: string,
) {
  archive[path] = bytes
  files.push({ path, mime, byteSize: bytes.byteLength, sha256: sha256Hex(bytes), purpose, assetId })
}

async function buildZipAsync(
  exported: RepositoryExport,
  packageKind: 'project-archive' | 'proxy-delivery',
): Promise<{ blob: Blob; sha256: string }> {
  const archive: Record<string, Uint8Array> = {}
  const files: PackageFileEntry[] = []
  addFile(
    archive,
    files,
    'project.json',
    'application/json',
    strToU8(JSON.stringify(exported.transfer, null, 2)),
    'project-data',
  )
  if (exported.transfer.audit.included) {
    addFile(
      archive,
      files,
      'audit/events.ndjson',
      'application/x-ndjson',
      strToU8(auditText(exported.auditEvents)),
      'audit',
    )
  }
  const artifactAssetIds = new Set(exported.transfer.artifacts.map((artifact) => artifact.assetId))
  for (const asset of exported.transfer.assets) {
    const content = exported.assets.get(asset.id)
    if (!content || asset.mime === 'application/zip') continue
    const purpose = artifactAssetIds.has(asset.id) ? 'artifact' : 'evidence'
    const path = `${purpose === 'artifact' ? 'artifacts' : 'evidence'}/${asset.id}.${extensionForMime(asset.mime)}`
    addFile(
      archive,
      files,
      path,
      asset.mime as PackageFileEntry['mime'],
      new Uint8Array(await content.arrayBuffer()),
      purpose,
      asset.id,
    )
  }
  const manifest = PackageManifestSchema.parse({
    packageKind,
    packageVersion: 1,
    projectId: exported.transfer.revision.project.id,
    revisionId: exported.transfer.revision.revision.id,
    createdAt: new Date().toISOString(),
    files,
  })
  archive['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  const zipped = zipSync(archive, { level: 6 })
  return {
    blob: new Blob([zipped], { type: 'application/zip' }),
    sha256: sha256Hex(zipped),
  }
}

export class ProjectPackageService {
  constructor(private readonly repository = new IndexedDbProjectRepository()) {}

  async preview(input: Blob): Promise<PackagePreview> {
    const parsed = await this.parse(input)
    return packagePreview(
      parsed.transfer,
      parsed.packageKind,
      parsed.transfer.assets.length - parsed.contents.size,
    )
  }

  async validate(input: Blob): Promise<ValidationReport> {
    try {
      return { valid: true, preview: await this.preview(input), errors: [] }
    } catch (error) {
      return { valid: false, errors: [error instanceof Error ? error.message : String(error)] }
    }
  }

  async importPackage(input: Blob, options: ImportOptions = {}): Promise<ImportResult> {
    const parsed = await parseZipPackage(input)
    return this.commitParsed(parsed, options)
  }

  async importProjectJson(input: Blob, options: ImportOptions = {}): Promise<ImportResult> {
    if (input.size > PackageLimits.projectJsonBytes) throw new Error('project.json 超过大小限制')
    const transfer = parseProjectJson(new Uint8Array(await input.arrayBuffer()))
    if (transfer.audit.included) throw new Error('单独的 project.json 不能声明已包含审计正文')
    return this.commitParsed(
      {
        transfer,
        contents: new Map(),
        auditEvents: [],
        packageKind: 'project-archive',
      },
      options,
    )
  }

  async exportProjectJson(projectId: string, revisionId?: string): Promise<Blob> {
    const exported = await this.repository.loadExport(projectId, revisionId)
    return new Blob([JSON.stringify(exported.transfer, null, 2)], { type: 'application/json' })
  }

  async exportPackage(
    projectId: string,
    revisionId: string | undefined,
    packageKind: 'project-archive' | 'proxy-delivery',
  ): Promise<{ blob: Blob; sha256: string }> {
    const exported = await this.repository.loadExport(projectId, revisionId)
    return buildZipAsync(exported, packageKind)
  }

  private async parse(input: Blob): Promise<ParsedPackage> {
    const header = new Uint8Array(await input.slice(0, 4).arrayBuffer())
    const isZip = header[0] === 0x50 && header[1] === 0x4b
    if (isZip) return parseZipPackage(input)
    const transfer = parseProjectJson(new Uint8Array(await input.arrayBuffer()))
    if (transfer.audit.included) throw new Error('单独的 project.json 不能声明已包含审计正文')
    return {
      transfer,
      contents: new Map(),
      auditEvents: [],
      packageKind: 'project-json',
    }
  }

  private async commitParsed(parsed: ParsedPackage, options: ImportOptions = {}): Promise<ImportResult> {
    const prepared =
      options.onConflict === 'copy' &&
      (await this.repository.hasProject(parsed.transfer.revision.project.id))
        ? cloneParsedPackage(parsed)
        : parsed
    const sessionId = crypto.randomUUID()
    try {
      await this.repository.stageImport(sessionId, prepared.transfer, prepared.contents)
      return await this.repository.commitImport(
        sessionId,
        prepared.transfer,
        prepared.auditEvents,
        prepared.transfer.assets.length - prepared.contents.size,
      )
    } catch (error) {
      try {
        await this.repository.cleanupImport(sessionId)
      } catch {
        // 下一次启动继续清理，不覆盖原始导入错误。
      }
      throw error
    }
  }
}
