import type {
  Artifact,
  AssetRecord,
  AuditEvent,
  Decision,
  Delivery,
  ExecutionRun,
  ProjectSnapshot,
  RuleRun,
  CommandResult,
  ProjectCommand,
} from '../domain'
import type { ImportResult, ProjectTransfer } from '../application/package-contract'

export const WORKBENCH_DB_NAME = 'gujian-workbench-v2'
export const WORKBENCH_DB_VERSION = 2

const storeNames = [
  'projects',
  'revisions',
  'assets',
  'modelRuns',
  'ruleRuns',
  'decisions',
  'artifacts',
  'deliveries',
  'auditEvents',
  'importSessions',
  'commandReceipts',
] as const

type StoreName = (typeof storeNames)[number]

export interface ProjectSummary {
  projectId: string
  currentRevisionId: string
  name: string
  status: 'active' | 'archived'
  updatedAt: string
  auditIncluded: boolean
  auditHeadHash: string | null
}

interface PersistedRevision {
  id: string
  projectId: string
  snapshot: ProjectSnapshot
}

interface PersistedAsset {
  id: string
  projectId: string
  sha256: string
  record: AssetRecord
  content?: Blob
  importSessionId?: string
}

interface ImportSession {
  id: string
  status: 'staging' | 'committed'
  createdAt: string
}

interface CommandReceipt {
  id: string
  projectId: string
  result: CommandResult
}

export interface CommandWriteSet {
  snapshot: ProjectSnapshot
  auditEvent: AuditEvent
  changedRefs: string[]
  invalidatedRefs: string[]
  modelRunsToPut?: ExecutionRun[]
  ruleRunsToAdd?: RuleRun[]
  decisionsToAdd?: Decision[]
  artifactsToPut?: Artifact[]
  deliveriesToAdd?: Delivery[]
}

export interface RepositoryExport {
  transfer: ProjectTransfer
  assets: Map<string, Blob>
  auditEvents: AuditEvent[]
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'))
  })
}

export function openWorkbenchDb(databaseName = WORKBENCH_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, WORKBENCH_DB_VERSION)
    request.onerror = () => reject(request.error ?? new Error('无法打开项目数据库'))
    request.onblocked = () => reject(new Error('项目数据库升级被其他页面阻止'))
    request.onupgradeneeded = (event) => {
      const db = request.result
      if (event.oldVersion < 1) {
        const projects = db.createObjectStore('projects', { keyPath: 'projectId' })
        projects.createIndex('updatedAt', 'updatedAt')

        const revisions = db.createObjectStore('revisions', { keyPath: 'id' })
        revisions.createIndex('projectId', 'projectId')

        const assets = db.createObjectStore('assets', { keyPath: 'id' })
        assets.createIndex('projectId', 'projectId')
        assets.createIndex('sha256', 'sha256')
        assets.createIndex('importSessionId', 'importSessionId')

        for (const name of ['modelRuns', 'ruleRuns', 'decisions', 'artifacts', 'deliveries'] as const) {
          const store = db.createObjectStore(name, { keyPath: 'id' })
          store.createIndex('projectId', 'projectId')
          store.createIndex('sourceRevisionId', 'sourceRevisionId')
        }

        const auditEvents = db.createObjectStore('auditEvents', { keyPath: 'id' })
        auditEvents.createIndex('projectId', 'projectId')
        auditEvents.createIndex('timestamp', 'timestamp')

        const sessions = db.createObjectStore('importSessions', { keyPath: 'id' })
        sessions.createIndex('status', 'status')
        sessions.createIndex('createdAt', 'createdAt')
      }
      if (event.oldVersion < 2) {
        const receipts = db.createObjectStore('commandReceipts', { keyPath: 'id' })
        receipts.createIndex('projectId', 'projectId')
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

export class IndexedDbProjectRepository {
  private readonly database: Promise<IDBDatabase>

  constructor(database = openWorkbenchDb()) {
    this.database = database
  }

  async list(): Promise<ProjectSummary[]> {
    const db = await this.database
    const tx = db.transaction('projects', 'readonly')
    const done = transactionDone(tx)
    const projects = await requestResult<ProjectSummary[]>(tx.objectStore('projects').getAll())
    await done
    return projects
      .filter((project) => project.status !== 'archived')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async hasProject(projectId: string): Promise<boolean> {
    const db = await this.database
    const tx = db.transaction('projects', 'readonly')
    const done = transactionDone(tx)
    const key = await requestResult<IDBValidKey | undefined>(
      tx.objectStore('projects').getKey(projectId),
    )
    await done
    return key !== undefined
  }

  async getCommandResult(commandId: string, projectId: string): Promise<CommandResult | undefined> {
    const db = await this.database
    const tx = db.transaction('commandReceipts', 'readonly')
    const done = transactionDone(tx)
    const receipt = await requestResult<CommandReceipt | undefined>(
      tx.objectStore('commandReceipts').get(commandId),
    )
    await done
    if (!receipt) return undefined
    if (receipt.projectId !== projectId) {
      return { ok: false, code: 'COMMAND_ID_CONFLICT', message: '命令 ID 已由其他项目使用' }
    }
    return receipt.result
  }

  async stageImport(
    sessionId: string,
    transfer: ProjectTransfer,
    contents: ReadonlyMap<string, Blob>,
  ): Promise<void> {
    const db = await this.database
    const tx = db.transaction(['assets', 'importSessions'], 'readwrite')
    const done = transactionDone(tx)
    const session: ImportSession = {
      id: sessionId,
      status: 'staging',
      createdAt: new Date().toISOString(),
    }
    tx.objectStore('importSessions').add(session)
    const assets = tx.objectStore('assets')
    for (const record of transfer.assets) {
      const persisted: PersistedAsset = {
        id: record.id,
        projectId: record.projectId,
        sha256: record.sha256,
        record,
        content: contents.get(record.id),
        importSessionId: sessionId,
      }
      assets.add(persisted)
    }
    await done
  }

  async commitImport(
    sessionId: string,
    transfer: ProjectTransfer,
    auditEvents: AuditEvent[],
    missingAssetCount = 0,
  ): Promise<ImportResult> {
    const db = await this.database
    const tx = db.transaction(storeNames, 'readwrite')
    const done = transactionDone(tx)
    const projectId = transfer.revision.project.id
    const revisionId = transfer.revision.revision.id
    const headHash = auditEvents.at(-1)?.eventHash ?? transfer.audit.headHash
    const summary: ProjectSummary = {
      projectId,
      currentRevisionId: revisionId,
      name: transfer.revision.project.name,
      status: transfer.revision.project.status,
      updatedAt: transfer.revision.project.updatedAt,
      auditIncluded: transfer.audit.included,
      auditHeadHash: headHash,
    }

    tx.objectStore('projects').add(summary)
    const revision: PersistedRevision = {
      id: revisionId,
      projectId,
      snapshot: transfer.revision,
    }
    tx.objectStore('revisions').add(revision)

    const assets = tx.objectStore('assets')
    for (const record of transfer.assets) {
      const request = assets.get(record.id)
      request.onsuccess = () => {
        const staged = request.result as PersistedAsset | undefined
        if (!staged || staged.importSessionId !== sessionId) {
          tx.abort()
          return
        }
        const promoted: PersistedAsset = { ...staged }
        delete promoted.importSessionId
        assets.put(promoted)
      }
    }

    this.addRecords(tx, 'modelRuns', transfer.modelRuns)
    this.addRecords(tx, 'ruleRuns', transfer.ruleRuns)
    this.addRecords(tx, 'decisions', transfer.decisions)
    this.addRecords(tx, 'artifacts', transfer.artifacts)
    this.addRecords(tx, 'deliveries', transfer.deliveries)
    this.addRecords(tx, 'auditEvents', auditEvents)
    tx.objectStore('importSessions').put({
      id: sessionId,
      status: 'committed',
      createdAt: new Date().toISOString(),
    } satisfies ImportSession)

    await done
    return {
      projectId,
      revisionId,
      assetCount: transfer.assets.length,
      missingAssetCount,
      auditStatus: transfer.audit.included ? 'complete' : 'not-included',
    }
  }

  async cleanupImport(sessionId: string): Promise<void> {
    const db = await this.database
    const tx = db.transaction(['assets', 'importSessions'], 'readwrite')
    const done = transactionDone(tx)
    const cursorRequest = tx
      .objectStore('assets')
      .index('importSessionId')
      .openCursor(IDBKeyRange.only(sessionId))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      cursor.delete()
      cursor.continue()
    }
    tx.objectStore('importSessions').delete(sessionId)
    await done
  }

  async recoverStagingImports(): Promise<number> {
    const db = await this.database
    const tx = db.transaction('importSessions', 'readonly')
    const done = transactionDone(tx)
    const sessions = await requestResult<ImportSession[]>(
      tx.objectStore('importSessions').index('status').getAll('staging'),
    )
    await done
    for (const session of sessions) {
      await this.cleanupImport(session.id)
    }
    return sessions.length
  }

  async loadExport(projectId: string, revisionId?: string): Promise<RepositoryExport> {
    const db = await this.database
    const summaryTx = db.transaction('projects', 'readonly')
    const summaryDone = transactionDone(summaryTx)
    const summary = await requestResult<ProjectSummary | undefined>(
      summaryTx.objectStore('projects').get(projectId),
    )
    await summaryDone
    if (!summary) throw new Error('PROJECT_NOT_FOUND')

    const selectedRevisionId = revisionId ?? summary.currentRevisionId
    const tx = db.transaction(
      [
        'revisions',
        'assets',
        'modelRuns',
        'ruleRuns',
        'decisions',
        'artifacts',
        'deliveries',
        'auditEvents',
      ],
      'readonly',
    )
    const done = transactionDone(tx)
    const revisionRequest = tx.objectStore('revisions').get(selectedRevisionId)
    const modelRequest = tx.objectStore('modelRuns').index('projectId').getAll(projectId)
    const ruleRequest = tx.objectStore('ruleRuns').index('projectId').getAll(projectId)
    const decisionRequest = tx.objectStore('decisions').index('projectId').getAll(projectId)
    const artifactRequest = tx.objectStore('artifacts').index('projectId').getAll(projectId)
    const deliveryRequest = tx.objectStore('deliveries').index('projectId').getAll(projectId)
    const assetRequest = tx.objectStore('assets').index('projectId').getAll(projectId)
    const auditRequest = tx.objectStore('auditEvents').index('projectId').getAll(projectId)

    const revision = await requestResult<PersistedRevision | undefined>(revisionRequest)
    if (!revision || revision.projectId !== projectId) throw new Error('REVISION_NOT_FOUND')

    const [modelRuns, ruleRuns, decisions, artifacts, deliveries, persistedAssets, auditEvents] =
      await Promise.all([
        requestResult<ExecutionRun[]>(modelRequest),
        requestResult<RuleRun[]>(ruleRequest),
        requestResult<Decision[]>(decisionRequest),
        requestResult<Artifact[]>(artifactRequest),
        requestResult<Delivery[]>(deliveryRequest),
        requestResult<PersistedAsset[]>(assetRequest),
        requestResult<AuditEvent[]>(auditRequest),
      ])
    await done

    const assetContents = new Map<string, Blob>()
    for (const asset of persistedAssets) {
      if (asset.content) assetContents.set(asset.id, asset.content)
    }
    const sortedAudit = auditEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    return {
      transfer: {
        packageVersion: 1,
        revision: revision.snapshot,
        assets: persistedAssets.map((asset) => asset.record),
        modelRuns,
        ruleRuns,
        decisions,
        artifacts,
        deliveries,
        audit: {
          included: summary.auditIncluded,
          headHash: sortedAudit.at(-1)?.eventHash ?? summary.auditHeadHash,
        },
      },
      assets: assetContents,
      auditEvents: sortedAudit,
    }
  }

  async getAsset(assetId: string): Promise<{ record: AssetRecord; content: Blob }> {
    const db = await this.database
    const tx = db.transaction('assets', 'readonly')
    const done = transactionDone(tx)
    const asset = await requestResult<PersistedAsset | undefined>(tx.objectStore('assets').get(assetId))
    await done
    if (!asset) throw new Error('ASSET_NOT_FOUND')
    if (!asset.content) throw new Error('ASSET_CONTENT_MISSING')
    return { record: asset.record, content: asset.content }
  }

  async commitCommand(command: ProjectCommand, writeSet: CommandWriteSet): Promise<CommandResult> {
    const db = await this.database
    const tx = db.transaction(
      [
        'projects',
        'revisions',
        'modelRuns',
        'ruleRuns',
        'decisions',
        'artifacts',
        'deliveries',
        'auditEvents',
        'commandReceipts',
      ],
      'readwrite',
    )
    const done = transactionDone(tx)
    const receiptRequest = tx.objectStore('commandReceipts').get(command.id)
    const projectRequest = tx.objectStore('projects').get(command.projectId)
    let receipt: CommandReceipt | undefined
    let summary: ProjectSummary | undefined
    let readCount = 0
    let outcome: CommandResult | undefined

    const finishReads = () => {
      readCount += 1
      if (readCount !== 2) return
      if (receipt) {
        outcome =
          receipt.projectId === command.projectId
            ? receipt.result
            : { ok: false, code: 'COMMAND_ID_CONFLICT', message: '命令 ID 已由其他项目使用' }
        return
      }

      const isCreate = command.type === 'CreateProject'
      if (isCreate && summary) {
        outcome = { ok: false, code: 'PROJECT_EXISTS', message: '项目 ID 已存在' }
        return
      }
      if (!isCreate && !summary) {
        outcome = { ok: false, code: 'PROJECT_NOT_FOUND', message: '项目不存在' }
        return
      }
      if (
        !isCreate &&
        summary &&
        command.expectedRevisionId !== summary.currentRevisionId
      ) {
        outcome = { ok: false, code: 'REVISION_CONFLICT', message: '项目版本已变化，请刷新后重试' }
        return
      }

      outcome = {
        ok: true,
        revisionId: writeSet.snapshot.revision.id,
        changedRefs: writeSet.changedRefs,
        invalidatedRefs: writeSet.invalidatedRefs,
      }
      const nextSummary: ProjectSummary = {
        projectId: writeSet.snapshot.project.id,
        currentRevisionId: writeSet.snapshot.revision.id,
        name: writeSet.snapshot.project.name,
        status: writeSet.snapshot.project.status,
        updatedAt: writeSet.snapshot.project.updatedAt,
        auditIncluded: true,
        auditHeadHash: writeSet.auditEvent.eventHash,
      }
      tx.objectStore('projects').put(nextSummary)
      tx.objectStore('revisions').add({
        id: writeSet.snapshot.revision.id,
        projectId: writeSet.snapshot.project.id,
        snapshot: writeSet.snapshot,
      } satisfies PersistedRevision)
      for (const run of writeSet.modelRunsToPut ?? []) tx.objectStore('modelRuns').put(run)
      this.addRecords(tx, 'ruleRuns', writeSet.ruleRunsToAdd ?? [])
      this.addRecords(tx, 'decisions', writeSet.decisionsToAdd ?? [])
      for (const artifact of writeSet.artifactsToPut ?? []) tx.objectStore('artifacts').put(artifact)
      this.addRecords(tx, 'deliveries', writeSet.deliveriesToAdd ?? [])
      tx.objectStore('auditEvents').add(writeSet.auditEvent)
      tx.objectStore('commandReceipts').add({
        id: command.id,
        projectId: command.projectId,
        result: outcome,
      } satisfies CommandReceipt)
    }

    receiptRequest.onsuccess = () => {
      receipt = receiptRequest.result as CommandReceipt | undefined
      finishReads()
    }
    projectRequest.onsuccess = () => {
      summary = projectRequest.result as ProjectSummary | undefined
      finishReads()
    }
    await done
    if (!outcome) throw new Error('命令事务没有产生结果')
    return outcome
  }

  private addRecords<T>(transaction: IDBTransaction, storeName: StoreName, records: T[]): void {
    const store = transaction.objectStore(storeName)
    for (const record of records) store.add(record)
  }
}
