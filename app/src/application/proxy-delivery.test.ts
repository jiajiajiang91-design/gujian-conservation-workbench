import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import gaoduProject from '../../data/v2/gaodu.project.json'
import gaoduProxyInput from '../../data/v2/gaodu.proxy-input.json'
import dongchengProject from '../../data/v2/dongcheng.project.json'
import dongchengSketchInput from '../../data/v2/dongcheng.evidence-sketch-input.json'
import {
  EvidenceSketchInputSchema,
  ProxyDrawingInputSchema,
} from '../domain'
import { IndexedDbProjectRepository, openWorkbenchDb } from '../infrastructure/indexeddb-repository'
import { ArtifactService } from './artifact-service'
import { DeliveryService } from './delivery-service'
import { ProjectTransferSchema } from './package-contract'
import { ProjectPackageService } from './project-package-service'

function setup(label: string) {
  const repository = new IndexedDbProjectRepository(
    openWorkbenchDb(`${label}-${crypto.randomUUID()}`),
  )
  return {
    repository,
    artifacts: new ArtifactService(repository),
    deliveries: new DeliveryService(repository),
    packages: new ProjectPackageService(repository),
  }
}

const actor = { id: '99000000-0000-4000-8000-000000000001', role: 'reviewer' as const }

describe('高都代理交付', () => {
  it('使用独立 demo 几何生成真实 SVG、DXF、报告和可重导入 ZIP', async () => {
    const { repository, artifacts, deliveries, packages } = setup('gaodu')
    const transfer = ProjectTransferSchema.parse(gaoduProject)
    const input = ProxyDrawingInputSchema.parse(gaoduProxyInput)
    const imported = await packages.importProjectJson(
      new Blob([JSON.stringify(transfer)], { type: 'application/json' }),
    )

    const generated = await artifacts.generateElevation(
      imported.projectId,
      imported.revisionId,
      input,
      actor,
    )
    if (!generated.command.ok) throw new Error(generated.command.message)
    const afterGeneration = await repository.loadExport(imported.projectId)
    expect(afterGeneration.transfer.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'check-report',
      'elevation-dxf',
      'elevation-svg',
    ])

    const dxfArtifact = afterGeneration.transfer.artifacts.find(
      (artifact) => artifact.kind === 'elevation-dxf',
    )!
    const reportArtifact = afterGeneration.transfer.artifacts.find(
      (artifact) => artifact.kind === 'check-report',
    )!
    const dxf = await repository.getAsset(dxfArtifact.assetId)
    const report = await repository.getAsset(reportArtifact.assetId)
    expect(await dxf.content.text()).toContain('SECTION')
    expect(await report.content.text()).toContain('4400 mm')

    const confirmed = await deliveries.confirmProxy(
      imported.projectId,
      generated.command.revisionId,
      actor,
      '确认仅生成代理交付，已知尺寸矛盾和 demo 来源继续保留。',
    )
    if (!confirmed.ok) throw new Error(confirmed.message)
    expect((await deliveries.evaluate(imported.projectId, confirmed.revisionId, 'proxy')).eligible).toBe(
      true,
    )
    expect((await deliveries.evaluate(imported.projectId, confirmed.revisionId, 'formal'))).toMatchObject(
      {
        eligible: false,
        blockerCodes: expect.arrayContaining(['IDENTITY_UNAVAILABLE', 'SIGNATURE_UNAVAILABLE']),
      },
    )

    const delivery = await deliveries.createProxy(imported.projectId, confirmed.revisionId, actor)
    if (!delivery.command.ok) throw new Error(delivery.command.message)
    expect(delivery.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(delivery.blob?.size).toBeGreaterThan(500)
    expect((await packages.validate(delivery.blob!)).valid).toBe(true)

    const final = await repository.loadExport(imported.projectId)
    expect(final.transfer.deliveries).toHaveLength(1)
    expect(final.transfer.deliveries[0].mode).toBe('proxy')
    expect(final.transfer.deliveries[0].eligibility.eligible).toBe(true)
  })
})

describe('东呈资料不足路径', () => {
  it('按五个框选对象生成证据草图，但不生成尺寸立面或 DXF', async () => {
    const { repository, artifacts, deliveries, packages } = setup('dongcheng')
    const transfer = ProjectTransferSchema.parse(dongchengProject)
    const input = EvidenceSketchInputSchema.parse(dongchengSketchInput)
    const imported = await packages.importProjectJson(
      new Blob([JSON.stringify(transfer)], { type: 'application/json' }),
    )

    const generated = await artifacts.generateEvidenceSketch(
      imported.projectId,
      imported.revisionId,
      input,
      actor,
    )
    if (!generated.command.ok) throw new Error(generated.command.message)
    const aggregate = await repository.loadExport(imported.projectId)
    expect(aggregate.transfer.revision.entities.filter((entity) => entity.kind === 'bay')).toHaveLength(5)
    expect(aggregate.transfer.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'check-report',
      'evidence-sketch-svg',
    ])
    expect(aggregate.transfer.artifacts.some((artifact) => artifact.kind === 'elevation-dxf')).toBe(
      false,
    )

    const evaluation = await deliveries.evaluate(
      imported.projectId,
      generated.command.revisionId,
      'proxy',
    )
    expect(evaluation.eligible).toBe(false)
    expect(evaluation.blockerCodes).toEqual(
      expect.arrayContaining(['ARTIFACT_MISSING:elevation-svg', 'ARTIFACT_MISSING:elevation-dxf']),
    )
  })
})
