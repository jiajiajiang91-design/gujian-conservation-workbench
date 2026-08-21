import {
  EvidenceSketchInputSchema,
  ProxyDrawingInputSchema,
  type ActorRole,
  type CommandResult,
  type EvidenceSketchInput,
  type ProxyDrawingInput,
} from '../domain'
import {
  generateDeliveryManifestFile,
  generateElevationProxy,
  generateEvidenceSketchProxy,
  type GeneratedArtifactFile,
} from '../adapters/artifact-generators'
import { sha256Hex } from '../infrastructure/hash'
import { IndexedDbProjectRepository } from '../infrastructure/indexeddb-repository'
import { ProjectCommandService } from './project-command-service'

export interface CommandActor {
  id: string
  role: ActorRole
}

export interface ArtifactGenerationResult {
  command: CommandResult
  artifactIds: string[]
  assetIds: string[]
}

export class ArtifactService {
  private readonly commands: ProjectCommandService

  constructor(private readonly repository = new IndexedDbProjectRepository()) {
    this.commands = new ProjectCommandService(repository)
  }

  async generateElevation(
    projectId: string,
    revisionId: string,
    inputValue: ProxyDrawingInput,
    actor: CommandActor,
  ): Promise<ArtifactGenerationResult> {
    const input = ProxyDrawingInputSchema.parse(inputValue)
    const aggregate = await this.repository.loadExport(projectId, revisionId)
    return this.commitGenerated(
      projectId,
      revisionId,
      generateElevationProxy(input, aggregate.transfer.revision),
      actor,
    )
  }

  async generateEvidenceSketch(
    projectId: string,
    revisionId: string,
    inputValue: EvidenceSketchInput,
    actor: CommandActor,
  ): Promise<ArtifactGenerationResult> {
    const input = EvidenceSketchInputSchema.parse(inputValue)
    const aggregate = await this.repository.loadExport(projectId, revisionId)
    return this.commitGenerated(
      projectId,
      revisionId,
      generateEvidenceSketchProxy(input, aggregate.transfer.revision),
      actor,
    )
  }

  async generateDeliveryManifest(
    projectId: string,
    revisionId: string,
    value: unknown,
    actor: CommandActor,
  ): Promise<ArtifactGenerationResult> {
    return this.commitGenerated(
      projectId,
      revisionId,
      [generateDeliveryManifestFile(value)],
      actor,
    )
  }

  private async commitGenerated(
    projectId: string,
    revisionId: string,
    files: GeneratedArtifactFile[],
    actor: CommandActor,
  ): Promise<ArtifactGenerationResult> {
    const issuedAt = new Date().toISOString()
    const sessionId = crypto.randomUUID()
    const artifactIds = files.map(() => crypto.randomUUID())
    const assets = files.map((file) => {
      const id = crypto.randomUUID()
      return {
        id,
        projectId,
        fileName: file.fileName,
        mime: file.mime,
        byteSize: file.bytes.byteLength,
        sha256: sha256Hex(file.bytes),
        importedAt: issuedAt,
      }
    })
    const contents = new Map<string, Blob>()
    files.forEach((file, index) => {
      const copy = new Uint8Array(file.bytes.byteLength)
      copy.set(file.bytes)
      contents.set(assets[index].id, new Blob([copy.buffer], { type: file.mime }))
    })

    try {
      await this.repository.stageGeneratedAssets(sessionId, assets, contents)
      const command = await this.commands.execute({
        id: crypto.randomUUID(),
        projectId,
        type: 'CommitArtifactGeneration',
        actor,
        expectedRevisionId: revisionId,
        issuedAt,
        payload: {
          sessionId,
          assets,
          artifacts: files.map((file, index) => ({
            id: artifactIds[index],
            kind: file.kind,
            assetId: assets[index].id,
            sha256: assets[index].sha256,
            generatorVersion: '1.0.0',
          })),
        },
      })
      if (!command.ok) await this.repository.cleanupImport(sessionId)
      return { command, artifactIds, assetIds: assets.map((asset) => asset.id) }
    } catch (error) {
      try {
        await this.repository.cleanupImport(sessionId)
      } catch {
        // 下次启动继续清理。
      }
      throw error
    }
  }
}
