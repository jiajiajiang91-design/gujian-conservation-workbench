import type { ProjectTransfer } from '../application/package-contract'
import type { AssetRecord, EvidenceRecord, ProjectSnapshot } from '../domain'
import { sha256Hex } from '../infrastructure/hash'

const timestamp = '2026-08-10T00:00:00.000Z'

export function createProjectFixture(
  name: string,
  options: { withAsset?: boolean } = {},
): { transfer: ProjectTransfer; contents: Map<string, Blob> } {
  const projectId = crypto.randomUUID()
  const revisionId = crypto.randomUUID()
  const actorId = crypto.randomUUID()
  const buildingId = crypto.randomUUID()
  const entityId = crypto.randomUUID()
  const contents = new Map<string, Blob>()
  const assets: AssetRecord[] = []
  const evidence: EvidenceRecord[] = []

  if (options.withAsset) {
    const assetId = crypto.randomUUID()
    const evidenceId = crypto.randomUUID()
    const bytes = new TextEncoder().encode('现场尺寸记录：通面阔待复核。')
    assets.push({
      id: assetId,
      projectId,
      fileName: 'survey-note.txt',
      mime: 'text/plain',
      byteSize: bytes.byteLength,
      sha256: sha256Hex(bytes),
      importedAt: timestamp,
    })
    evidence.push({
      id: evidenceId,
      projectId,
      assetId,
      evidenceType: 'survey-note',
      importedAt: timestamp,
      quality: 'uncertain',
      relatedEntityRefs: [entityId],
      declarations: {
        ownership: { status: 'missing' },
        permittedUse: { status: 'missing' },
        confidentiality: { status: 'missing' },
      },
    })
    contents.set(assetId, new Blob([bytes], { type: 'text/plain' }))
  }

  const revision: ProjectSnapshot = {
    schemaVersion: 2,
    revision: {
      id: revisionId,
      previousRevisionId: null,
      number: 1,
      createdAt: timestamp,
      createdByActorId: actorId,
    },
    project: {
      id: projectId,
      name,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    buildings: [{ id: buildingId, projectId, name: '正房' }],
    tasks: [],
    evidence,
    entities: [
      {
        id: entityId,
        buildingId,
        parentId: null,
        kind: 'building-facade',
        name: '正立面',
      },
    ],
    observations: [],
    candidates: [],
    issues: [],
  }

  return {
    transfer: {
      packageVersion: 1,
      revision,
      assets,
      modelRuns: [],
      ruleRuns: [],
      decisions: [],
      artifacts: [],
      deliveries: [],
      audit: { included: false, headHash: null },
    },
    contents,
  }
}
