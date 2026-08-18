import type {
  CommandReceipt,
  CommitProjectMutation,
  ProjectHead,
  ProjectQueryPort,
  ProjectRepositoryPort,
  ProjectSummary,
  ProjectTransaction,
} from "@gujian/application";
import {
  AuditEventSchema,
  ProjectRevisionSchema,
  ProjectSnapshotSchema,
  type ProjectSnapshot,
  type AuditEvent,
  type AssetRecord,
  type ProjectRevision,
  type ModelRun,
  type RuleRun,
  type Decision,
  type CadJob,
  type ArtifactRecord,
  type ArtifactRequirementMatrix,
  type CheckRun,
  type DeliveryEvaluation,
  type DeliveryDraft,
  type ConceptEntry,
  type ArchetypeSpec,
} from "@gujian/domain";

import { recordHash, sha256Hex } from "./hash.js";

export const WORKBENCH_DB_NAME = "gujian-workbench-v3";
// v7（架构 v1.4 §6.2）：一次新增词表条目、形制参数与助手动作层三库
export const WORKBENCH_DB_VERSION = 7;

const STORE_NAMES = [
  "projects", "revisions", "commandReceipts", "auditEvents", "assets",
  "importSessions", "modelRuns", "modelRunEvents", "ruleRuns", "decisions",
  "cadJobs", "cadJobEvents", "geometrySpecs", "geometryRevisions", "artifactRequirementMatrices", "artifacts", "checkRuns", "deliveryEvaluations", "deliveries",
  "conceptEntries", "archetypeSpecs", "componentLibraryEntries", "exclusionRecords", "returnRecords",
] as const;

interface PersistedRevision {
  id: string;
  projectId: string;
  auditEventId: string;
  revision: ProjectRevision;
  snapshot: ProjectSnapshot;
}

interface PersistedSummary extends ProjectSummary {
  auditEventId: string;
}

interface PersistedReceipt extends CommandReceipt {
  id: string;
}

interface PersistedAsset {
  id: string;
  projectId: string;
  record: AssetRecord;
  content?: Blob;
  stagingSessionId?: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务已中止"));
  });
}

export function openWorkbenchDatabase(databaseName = WORKBENCH_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, WORKBENCH_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("无法打开工作台数据库"));
    request.onblocked = () => reject(new Error("数据库升级被其他工作台页面阻止"));
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of STORE_NAMES) {
        if (database.objectStoreNames.contains(storeName)) continue;
        const keyPath = storeName === "projects" ? "projectId" : storeName === "conceptEntries" ? "conceptId" : "id";
        const store = database.createObjectStore(storeName, { keyPath });
        // conceptEntries 是部署级词表（跨项目共享），不建 projectId 索引
        if (storeName !== "projects" && storeName !== "importSessions" && storeName !== "conceptEntries") {
          store.createIndex("projectId", "projectId", { unique: false });
        }
        if (storeName === "projects") store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      // 其它页面发起升级时主动让出连接，避免旧连接永久阻塞版本升级
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function currentHead(summary: PersistedSummary, revision: PersistedRevision): ProjectHead {
  return {
    projectId: summary.projectId,
    revisionId: summary.currentRevisionId,
    auditEventId: summary.auditEventId,
    snapshot: ProjectSnapshotSchema.parse(revision.snapshot),
  };
}

function orderAuditChain(events: readonly AuditEvent[]): AuditEvent[] {
  const byPrevious = new Map<string, AuditEvent>();
  for (const event of events) {
    const key = event.previousEventHash ?? "ROOT";
    if (byPrevious.has(key)) throw new Error("AUDIT_CHAIN_BRANCH");
    byPrevious.set(key, event);
  }
  const ordered: AuditEvent[] = [];
  let previous: string | null = null;
  while (ordered.length < events.length) {
    const next = byPrevious.get(previous ?? "ROOT");
    if (!next) throw new Error("AUDIT_CHAIN_BROKEN");
    ordered.push(next);
    previous = next.eventHash;
  }
  return ordered;
}

export class IndexedDbProjectRepository implements ProjectRepositoryPort, ProjectQueryPort {
  readonly #database: Promise<IDBDatabase>;

  constructor(database: Promise<IDBDatabase> | IDBDatabase = openWorkbenchDatabase()) {
    this.#database = database instanceof IDBDatabase ? Promise.resolve(database) : database;
  }

  async listProjects(): Promise<readonly ProjectSummary[]> {
    const database = await this.#database;
    const transaction = database.transaction("projects", "readonly");
    const done = transactionDone(transaction);
    const records = await requestResult<PersistedSummary[]>(transaction.objectStore("projects").getAll());
    await done;
    return records
      .filter((record) => record.status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getProjectHead(projectId: string): Promise<ProjectHead | null> {
    const database = await this.#database;
    const transaction = database.transaction(["projects", "revisions"], "readonly");
    const done = transactionDone(transaction);
    const summary = await requestResult<PersistedSummary | undefined>(transaction.objectStore("projects").get(projectId));
    if (!summary) {
      await done;
      return null;
    }
    const revision = await requestResult<PersistedRevision | undefined>(
      transaction.objectStore("revisions").get(summary.currentRevisionId),
    );
    await done;
    if (!revision || revision.projectId !== projectId) throw new Error("项目版本闭包不完整");
    return currentHead(summary, revision);
  }

  async exportProjectClosure(projectId: string): Promise<{
    head: ProjectHead;
    revision: ProjectRevision;
    auditEvents: readonly AuditEvent[];
  }> {
    const database = await this.#database;
    const transaction = database.transaction(["projects", "revisions", "auditEvents"], "readonly");
    const done = transactionDone(transaction);
    const summary = await requestResult<PersistedSummary | undefined>(transaction.objectStore("projects").get(projectId));
    if (!summary) {
      await done;
      throw new Error("PROJECT_NOT_FOUND");
    }
    const revision = await requestResult<PersistedRevision | undefined>(
      transaction.objectStore("revisions").get(summary.currentRevisionId),
    );
    const auditEvents = await requestResult<AuditEvent[]>(
      transaction.objectStore("auditEvents").index("projectId").getAll(projectId),
    );
    await done;
    if (!revision) throw new Error("REVISION_NOT_FOUND");
    return {
      head: currentHead(summary, revision),
      revision: ProjectRevisionSchema.parse(revision.revision),
      auditEvents: orderAuditChain(auditEvents),
    };
  }

  async clearAllData(): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction([...STORE_NAMES], "readwrite");
    const done = transactionDone(transaction);
    for (const storeName of STORE_NAMES) transaction.objectStore(storeName).clear();
    await done;
  }

  async stageAssets(sessionId: string, records: readonly AssetRecord[], contents: ReadonlyMap<string, Blob>): Promise<void> {
    if (!records.length || records.some((record) => !contents.has(record.id))) throw new Error("ASSET_STAGING_INCOMPLETE");
    for (const record of records) {
      const content = contents.get(record.id)!;
      if (content.size === record.byteLength && sha256Hex(new Uint8Array(await content.arrayBuffer())) === record.sha256) {
        continue;
      }
      throw new Error("ASSET_STAGING_HASH_MISMATCH");
    }
    const database = await this.#database;
    const transaction = database.transaction(["assets", "importSessions"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("importSessions").add({ id: sessionId, createdAt: new Date().toISOString(), status: "staging" });
    for (const record of records) {
      transaction.objectStore("assets").add({
        id: record.id,
        projectId: record.projectId,
        record,
        content: contents.get(record.id)!,
        stagingSessionId: sessionId,
      } satisfies PersistedAsset);
    }
    await done;
  }

  async cleanupStaging(sessionId: string): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(["assets", "importSessions"], "readwrite");
    const done = transactionDone(transaction);
    const request = transaction.objectStore("assets").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const asset = cursor.value as PersistedAsset;
      if (asset.stagingSessionId === sessionId) cursor.delete();
      cursor.continue();
    };
    transaction.objectStore("importSessions").delete(sessionId);
    await done;
  }

  async getProjectAssets(projectId: string): Promise<readonly { record: AssetRecord; content: Blob | null }[]> {
    const database = await this.#database;
    const transaction = database.transaction("assets", "readonly");
    const done = transactionDone(transaction);
    const assets = await requestResult<PersistedAsset[]>(transaction.objectStore("assets").index("projectId").getAll(projectId));
    await done;
    return assets.filter((asset) => !asset.stagingSessionId).map((asset) => ({ record: asset.record, content: asset.content ?? null }));
  }

  async getAsset(assetId: string): Promise<{ record: AssetRecord; content: Blob }> {
    const database = await this.#database;
    const transaction = database.transaction("assets", "readonly");
    const done = transactionDone(transaction);
    const asset = await requestResult<PersistedAsset | undefined>(transaction.objectStore("assets").get(assetId));
    await done;
    if (!asset || asset.stagingSessionId) throw new Error("ASSET_NOT_FOUND");
    if (!asset.content) throw new Error("ASSET_CONTENT_MISSING");
    return { record: asset.record, content: asset.content };
  }

  async getProjectModelRuns(projectId: string): Promise<readonly ModelRun[]> {
    const database = await this.#database;
    const transaction = database.transaction("modelRuns", "readonly");
    const done = transactionDone(transaction);
    const runs = await requestResult<ModelRun[]>(transaction.objectStore("modelRuns").index("projectId").getAll(projectId));
    await done;
    return runs.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async getProjectRuleRuns(projectId: string): Promise<readonly RuleRun[]> {
    const database = await this.#database;
    const transaction = database.transaction("ruleRuns", "readonly");
    const done = transactionDone(transaction);
    const runs = await requestResult<RuleRun[]>(transaction.objectStore("ruleRuns").index("projectId").getAll(projectId));
    await done;
    return runs.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async getProjectDecisions(projectId: string): Promise<readonly Decision[]> {
    const database = await this.#database;
    const transaction = database.transaction("decisions", "readonly");
    const done = transactionDone(transaction);
    const decisions = await requestResult<Decision[]>(transaction.objectStore("decisions").index("projectId").getAll(projectId));
    await done;
    return decisions.sort((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  }

  async getProjectArchetypeSpecs(projectId: string): Promise<readonly ArchetypeSpec[]> {
    const database = await this.#database;
    const transaction = database.transaction("archetypeSpecs", "readonly");
    const done = transactionDone(transaction);
    const specs = await requestResult<ArchetypeSpec[]>(transaction.objectStore("archetypeSpecs").index("projectId").getAll(projectId));
    await done;
    return specs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  // 部署级词表 overlay（种子词表在代码内，此处只读用户提交的增量条目）
  async getConceptEntries(): Promise<readonly ConceptEntry[]> {
    const database = await this.#database;
    const transaction = database.transaction("conceptEntries", "readonly");
    const done = transactionDone(transaction);
    const entries = await requestResult<ConceptEntry[]>(transaction.objectStore("conceptEntries").getAll());
    await done;
    return entries.sort((left, right) => left.conceptId.localeCompare(right.conceptId));
  }

  async getProjectCadJobs(projectId: string): Promise<readonly CadJob[]> {
    const database = await this.#database;
    const transaction = database.transaction("cadJobs", "readonly");
    const done = transactionDone(transaction);
    const jobs = await requestResult<CadJob[]>(transaction.objectStore("cadJobs").index("projectId").getAll(projectId));
    await done;
    return jobs.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async getProjectArtifacts(projectId: string): Promise<readonly ArtifactRecord[]> {
    return this.#getProjectRecords<ArtifactRecord>("artifacts", projectId);
  }

  async getProjectArtifactRequirementMatrices(projectId: string): Promise<readonly ArtifactRequirementMatrix[]> {
    return this.#getProjectRecords<ArtifactRequirementMatrix>("artifactRequirementMatrices", projectId);
  }

  async getProjectCheckRuns(projectId: string): Promise<readonly CheckRun[]> {
    return this.#getProjectRecords<CheckRun>("checkRuns", projectId);
  }

  async getProjectDeliveryEvaluations(projectId: string): Promise<readonly DeliveryEvaluation[]> {
    return this.#getProjectRecords<DeliveryEvaluation>("deliveryEvaluations", projectId);
  }

  async getProjectDeliveries(projectId: string): Promise<readonly DeliveryDraft[]> {
    return this.#getProjectRecords<DeliveryDraft>("deliveries", projectId);
  }

  async #getProjectRecords<T>(storeName: "artifactRequirementMatrices" | "artifacts" | "checkRuns" | "deliveryEvaluations" | "deliveries", projectId: string): Promise<readonly T[]> {
    const database = await this.#database;
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const records = await requestResult<T[]>(transaction.objectStore(storeName).index("projectId").getAll(projectId));
    await done;
    return records;
  }

  async transaction<T>(projectId: string, operation: (transaction: ProjectTransaction) => Promise<T>): Promise<T> {
    const database = await this.#database;
    const transaction = database.transaction(
      ["projects", "revisions", "commandReceipts", "auditEvents", "assets", "importSessions", "modelRuns", "ruleRuns", "decisions", "cadJobs", "cadJobEvents", "geometrySpecs", "geometryRevisions", "artifactRequirementMatrices", "artifacts", "checkRuns", "deliveryEvaluations", "deliveries", "conceptEntries", "archetypeSpecs"],
      "readwrite",
    );
    const done = transactionDone(transaction);
    let committed = false;
    const adapter: ProjectTransaction = {
      getCommandReceipt: async (commandId) => {
        const record = await requestResult<PersistedReceipt | undefined>(
          transaction.objectStore("commandReceipts").get(commandId),
        );
        if (!record) return null;
        if (record.projectId !== projectId) throw new Error("命令 ID 已由其他项目使用");
        return record;
      },
      getProjectHead: async () => {
        const summary = await requestResult<PersistedSummary | undefined>(transaction.objectStore("projects").get(projectId));
        if (!summary) return null;
        const revision = await requestResult<PersistedRevision | undefined>(
          transaction.objectStore("revisions").get(summary.currentRevisionId),
        );
        if (!revision) throw new Error("项目头引用的版本不存在");
        return currentHead(summary, revision);
      },
      getCadJob: async (jobId) => {
        const job = await requestResult<CadJob | undefined>(transaction.objectStore("cadJobs").get(jobId));
        if (!job) return null;
        if (job.projectId !== projectId) throw new Error("CAD_JOB_PROJECT_MISMATCH");
        return job;
      },
      getArtifactRequirementMatrix: async (matrixId) => {
        const item = await requestResult<ArtifactRequirementMatrix | undefined>(transaction.objectStore("artifactRequirementMatrices").get(matrixId));
        if (!item) return null;
        if (item.projectId !== projectId) throw new Error("ARTIFACT_REQUIREMENT_MATRIX_PROJECT_MISMATCH");
        return item;
      },
      getArtifact: async (artifactId) => {
        const item = await requestResult<ArtifactRecord | undefined>(transaction.objectStore("artifacts").get(artifactId));
        if (!item) return null;
        if (item.projectId !== projectId) throw new Error("ARTIFACT_PROJECT_MISMATCH");
        return item;
      },
      getCheckRun: async (checkRunId) => {
        const item = await requestResult<CheckRun | undefined>(transaction.objectStore("checkRuns").get(checkRunId));
        if (!item) return null;
        if (item.projectId !== projectId) throw new Error("CHECK_RUN_PROJECT_MISMATCH");
        return item;
      },
      getDeliveryEvaluation: async (evaluationId) => {
        const item = await requestResult<DeliveryEvaluation | undefined>(transaction.objectStore("deliveryEvaluations").get(evaluationId));
        if (!item) return null;
        if (item.projectId !== projectId) throw new Error("DELIVERY_EVALUATION_PROJECT_MISMATCH");
        return item;
      },
      commit: async (mutation) => {
        if (committed) throw new Error("同一事务只能提交一次");
        committed = true;
        return this.#commitMutation(transaction, mutation);
      },
    };
    try {
      const result = await operation(adapter);
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction already settled */ }
      await done.catch(() => undefined);
      throw error;
    }
  }

  #commitMutation(transaction: IDBTransaction, mutation: CommitProjectMutation): CommandReceipt {
    const revisionId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const committedAt = mutation.command.issuedAt;
    const snapshotHash = recordHash(mutation.snapshot);
    const revisionBase = {
      id: revisionId,
      projectId: mutation.command.projectId,
      parentId: mutation.parentRevisionId,
      snapshotHash,
      changedRefs: [...mutation.changedRefs],
      committedAt,
    };
    const revision = ProjectRevisionSchema.parse({
      ...revisionBase,
      closureHash: recordHash({ parentId: mutation.parentRevisionId, snapshotHash }),
      recordHash: recordHash(revisionBase),
    });
    const summary: PersistedSummary = {
      projectId: mutation.command.projectId,
      currentRevisionId: revisionId,
      name: mutation.snapshot.project.name,
      buildingName: mutation.snapshot.buildings[0]?.name ?? "未命名建筑",
      status: mutation.snapshot.project.status,
      updatedAt: committedAt,
      auditEventId,
      auditHeadHash: "0".repeat(64),
    };
    const previousSummaryRequest = transaction.objectStore("projects").get(mutation.command.projectId);
    previousSummaryRequest.onsuccess = () => {
      const previous = previousSummaryRequest.result as PersistedSummary | undefined;
      const writeSet = [
        { kind: "record", storeName: "projects", id: mutation.command.projectId, hash: recordHash(summary) },
        { kind: "record", storeName: "revisions", id: revisionId, hash: revision.recordHash },
        ...(mutation.assetWrites?.records.map((asset) => ({
          kind: "asset" as const,
          storeName: "assets",
          id: asset.id,
          hash: asset.sha256,
        })) ?? []),
        ...(mutation.modelRunsToPut?.map((run) => ({
          kind: "record" as const,
          storeName: "modelRuns",
          id: run.id,
          hash: recordHash(run),
        })) ?? []),
        ...(mutation.ruleRunsToPut?.map((run) => ({
          kind: "record" as const,
          storeName: "ruleRuns",
          id: run.id,
          hash: recordHash(run),
        })) ?? []),
        ...(mutation.decisionsToPut?.map((decision) => ({
          kind: "record" as const,
          storeName: "decisions",
          id: decision.id,
          hash: recordHash(decision),
        })) ?? []),
        ...(mutation.artifactRequirementMatricesToPut?.map((item) => ({ kind: "record" as const, storeName: "artifactRequirementMatrices", id: item.id, hash: recordHash(item) })) ?? []),
        ...(mutation.artifactsToPut?.map((item) => ({ kind: "record" as const, storeName: "artifacts", id: item.id, hash: recordHash(item) })) ?? []),
        ...(mutation.checkRunsToPut?.map((item) => ({ kind: "record" as const, storeName: "checkRuns", id: item.id, hash: recordHash(item) })) ?? []),
        ...(mutation.deliveryEvaluationsToPut?.map((item) => ({ kind: "record" as const, storeName: "deliveryEvaluations", id: item.id, hash: recordHash(item) })) ?? []),
        ...(mutation.deliveriesToPut?.map((item) => ({ kind: "record" as const, storeName: "deliveries", id: item.id, hash: recordHash(item) })) ?? []),
        ...(mutation.conceptEntriesToPut?.map((item) => ({ kind: "record" as const, storeName: "conceptEntries", id: item.conceptId, hash: recordHash(item) })) ?? []),
        ...(mutation.archetypeSpecsToPut?.map((item) => ({ kind: "record" as const, storeName: "archetypeSpecs", id: item.id, hash: recordHash(item) })) ?? []),
      ];
      const eventBase = {
        id: auditEventId,
        projectId: mutation.command.projectId,
        commandId: mutation.command.commandId,
        actorId: mutation.authoritativeActorId,
        previousEventHash: previous?.auditHeadHash ?? mutation.priorAuditEvents?.at(-1)?.eventHash ?? null,
        writeSet,
        writeSetHash: recordHash(writeSet),
        outcome: "committed",
        errorCode: null,
        occurredAt: committedAt,
      } as const;
      const auditEvent = AuditEventSchema.parse({
        ...eventBase,
        eventHash: recordHash(eventBase),
        recordHash: recordHash({ ...eventBase, recordType: "AuditEvent" }),
      });
      const committedSummary: PersistedSummary = { ...summary, auditHeadHash: auditEvent.eventHash };
      transaction.objectStore("projects").put(committedSummary);
      for (const priorEvent of mutation.priorAuditEvents ?? []) {
        transaction.objectStore("auditEvents").add(AuditEventSchema.parse(priorEvent));
      }
      transaction.objectStore("auditEvents").add(auditEvent);
    };
    transaction.objectStore("revisions").add({
      id: revisionId,
      projectId: mutation.command.projectId,
      auditEventId,
      revision,
      snapshot: mutation.snapshot,
    } satisfies PersistedRevision);
    const receipt: PersistedReceipt = {
      id: mutation.command.commandId,
      commandId: mutation.command.commandId,
      commandType: mutation.command.commandType,
      projectId: mutation.command.projectId,
      revisionId,
      auditEventId,
      committedAt,
    };
    transaction.objectStore("commandReceipts").add(receipt);
    for (const run of mutation.modelRunsToPut ?? []) transaction.objectStore("modelRuns").put(run);
    for (const run of mutation.ruleRunsToPut ?? []) transaction.objectStore("ruleRuns").put(run);
    for (const decision of mutation.decisionsToPut ?? []) transaction.objectStore("decisions").put(decision);
    for (const job of mutation.cadJobsToPut ?? []) {
      transaction.objectStore("cadJobs").put(job);
      for (const event of job.events) transaction.objectStore("cadJobEvents").put({ ...event, projectId: job.projectId });
    }
    for (const spec of mutation.geometrySpecsToPut ?? []) transaction.objectStore("geometrySpecs").put(spec);
    for (const revision of mutation.geometryRevisionsToPut ?? []) transaction.objectStore("geometryRevisions").put(revision);
    for (const item of mutation.artifactRequirementMatricesToPut ?? []) transaction.objectStore("artifactRequirementMatrices").put(item);
    for (const item of mutation.artifactsToPut ?? []) transaction.objectStore("artifacts").put(item);
    for (const item of mutation.checkRunsToPut ?? []) transaction.objectStore("checkRuns").put(item);
    for (const item of mutation.deliveryEvaluationsToPut ?? []) transaction.objectStore("deliveryEvaluations").put(item);
    for (const item of mutation.deliveriesToPut ?? []) transaction.objectStore("deliveries").put(item);
    for (const item of mutation.conceptEntriesToPut ?? []) transaction.objectStore("conceptEntries").put(item);
    for (const item of mutation.archetypeSpecsToPut ?? []) transaction.objectStore("archetypeSpecs").put(item);
    const assetWrite = mutation.assetWrites;
    if (assetWrite) {
      for (const record of assetWrite.records) {
        if (assetWrite.stagingSessionId) {
          const request = transaction.objectStore("assets").get(record.id);
          request.onsuccess = () => {
            const staged = request.result as PersistedAsset | undefined;
            if (!staged) {
              // 标为缺失的资料本来就没有原件可暂存，直接写记录。
              // 其余情况下没有暂存条目说明内容未经校验，整批回滚。
              if (record.contentStatus === "missing") {
                transaction.objectStore("assets").add({ id: record.id, projectId: record.projectId, record } satisfies PersistedAsset);
                return;
              }
              transaction.abort();
              return;
            }
            if (staged.stagingSessionId !== assetWrite.stagingSessionId || staged.projectId !== mutation.command.projectId) {
              transaction.abort();
              return;
            }
            const promoted: PersistedAsset = { ...staged, record };
            delete promoted.stagingSessionId;
            transaction.objectStore("assets").put(promoted);
          };
        } else {
          transaction.objectStore("assets").add({ id: record.id, projectId: record.projectId, record } satisfies PersistedAsset);
        }
      }
      if (assetWrite.stagingSessionId) {
        transaction.objectStore("importSessions").put({
          id: assetWrite.stagingSessionId,
          createdAt: committedAt,
          status: "committed",
        });
      }
    }
    return receipt;
  }
}

export class LocalAuthorization {
  async assertAuthorized(): Promise<void> {
    return Promise.resolve();
  }
}
