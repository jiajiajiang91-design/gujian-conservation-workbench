import type { ActorRole, CommandResult } from '../domain'
import { IndexedDbProjectRepository } from '../infrastructure/indexeddb-repository'
import { ArtifactService, type CommandActor } from './artifact-service'
import { ProjectCommandService } from './project-command-service'
import { ProjectPackageService } from './project-package-service'

export interface DeliveryEvaluation {
  eligible: boolean
  blockerCodes: string[]
  artifactIds: string[]
  confirmationDecisionId?: string
  limitations: string[]
}

export interface ProxyDeliveryResult {
  command: CommandResult
  blob?: Blob
  sha256?: string
  deliveryId?: string
  packageAssetId?: string
}

export class DeliveryService {
  private readonly commands: ProjectCommandService
  private readonly artifacts: ArtifactService
  private readonly packages: ProjectPackageService

  constructor(private readonly repository = new IndexedDbProjectRepository()) {
    this.commands = new ProjectCommandService(repository)
    this.artifacts = new ArtifactService(repository)
    this.packages = new ProjectPackageService(repository)
  }

  async confirmProxy(
    projectId: string,
    revisionId: string,
    actor: { id: string; role: ActorRole },
    reason: string,
  ): Promise<CommandResult> {
    return this.commands.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'ConfirmProxyDelivery',
      actor,
      expectedRevisionId: revisionId,
      issuedAt: new Date().toISOString(),
      payload: { reason },
    })
  }

  async evaluate(
    projectId: string,
    revisionId: string,
    mode: 'proxy' | 'formal',
  ): Promise<DeliveryEvaluation> {
    const aggregate = await this.repository.loadExport(projectId, revisionId)
    if (mode === 'formal') {
      return {
        eligible: false,
        blockerCodes: [
          'IDENTITY_UNAVAILABLE',
          'AUTHORIZATION_UNAVAILABLE',
          'SIGNATURE_UNAVAILABLE',
        ],
        artifactIds: [],
        limitations: ['本轮未实现正式身份、权限和签名能力。'],
      }
    }

    const validArtifacts = aggregate.transfer.artifacts.filter((artifact) => artifact.status === 'valid')
    const byKind = new Map(validArtifacts.map((artifact) => [artifact.kind, artifact]))
    const blockers: string[] = []
    for (const requiredKind of ['elevation-svg', 'elevation-dxf', 'check-report'] as const) {
      if (!byKind.has(requiredKind)) blockers.push(`ARTIFACT_MISSING:${requiredKind}`)
    }
    const confirmation = [...aggregate.transfer.decisions]
      .reverse()
      .find((decision) => decision.choice === 'confirm-proxy')
    if (!confirmation) blockers.push('PROXY_CONFIRMATION_REQUIRED')

    const artifactIds = validArtifacts
      .filter((artifact) => ['elevation-svg', 'elevation-dxf', 'check-report'].includes(artifact.kind))
      .map((artifact) => artifact.id)
    const limitations = [
      '代理成果仅用于验证流程，不代表现场实测或正式签发。',
      ...aggregate.transfer.revision.issues
        .filter((issue) => issue.status === 'open')
        .map((issue) => `未决问题：${issue.type} / ${issue.blockerCodes.join(', ')}`),
    ]
    return {
      eligible: blockers.length === 0,
      blockerCodes: blockers,
      artifactIds,
      confirmationDecisionId: confirmation?.id,
      limitations,
    }
  }

  async createProxy(
    projectId: string,
    revisionId: string,
    actor: CommandActor,
  ): Promise<ProxyDeliveryResult> {
    const evaluation = await this.evaluate(projectId, revisionId, 'proxy')
    if (!evaluation.eligible || !evaluation.confirmationDecisionId) {
      return {
        command: {
          ok: false,
          code: 'DELIVERY_BLOCKED',
          message: evaluation.blockerCodes.join(', '),
        },
      }
    }

    const aggregate = await this.repository.loadExport(projectId, revisionId)
    const manifestResult = await this.artifacts.generateDeliveryManifest(
      projectId,
      revisionId,
      {
        kind: 'proxy-delivery',
        projectId,
        sourceRevisionId: revisionId,
        createdAt: new Date().toISOString(),
        artifactIds: evaluation.artifactIds,
        limitations: evaluation.limitations,
        formalEligibility: false,
      },
      actor,
    )
    if (!manifestResult.command.ok) return { command: manifestResult.command }

    const manifestRevisionId = manifestResult.command.revisionId
    const afterManifest = await this.repository.loadExport(projectId, manifestRevisionId)
    const manifestArtifact = afterManifest.transfer.artifacts.find(
      (artifact) => manifestResult.artifactIds.includes(artifact.id) && artifact.kind === 'delivery-manifest',
    )
    if (!manifestArtifact) {
      return { command: { ok: false, code: 'MANIFEST_NOT_FOUND', message: '交付清单生成后无法读取' } }
    }

    const packed = await this.packages.exportPackage(projectId, manifestRevisionId, 'proxy-delivery')
    const sessionId = crypto.randomUUID()
    const packageAssetId = crypto.randomUUID()
    const safeName = aggregate.transfer.revision.project.name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100)
    const packageAsset = {
      id: packageAssetId,
      projectId,
      fileName: `${safeName}-proxy-delivery.gujian.zip`,
      mime: 'application/zip' as const,
      byteSize: packed.blob.size,
      sha256: packed.sha256,
      importedAt: new Date().toISOString(),
    }
    const deliveryId = crypto.randomUUID()

    try {
      await this.repository.stageGeneratedAssets(
        sessionId,
        [packageAsset],
        new Map([[packageAssetId, packed.blob]]),
      )
      const command = await this.commands.execute({
        id: crypto.randomUUID(),
        projectId,
        type: 'CommitDelivery',
        actor,
        expectedRevisionId: manifestRevisionId,
        issuedAt: new Date().toISOString(),
        payload: {
          sessionId,
          packageAsset,
          deliveryId,
          artifactIds: [...evaluation.artifactIds, manifestArtifact.id],
          manifestAssetId: manifestArtifact.id,
          eligibility: {
            eligible: true,
            blockerCodes: [],
            policyVersion: 'proxy-v1',
            evaluatedAt: new Date().toISOString(),
          },
          confirmedByDecisionId: evaluation.confirmationDecisionId,
        },
      })
      if (!command.ok) {
        await this.repository.cleanupImport(sessionId)
        return { command }
      }
      return { command, blob: packed.blob, sha256: packed.sha256, deliveryId, packageAssetId }
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
