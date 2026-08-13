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
} from "@gujian/domain";

import { recordHash, sha256Hex } from "./hash.js";

export const WORKBENCH_DB_NAME = "gujian-workbench-v3";
export const WORKBENCH_DB_VERSION = 3;

const STORE_NAMES = [
  "projects", "revisions", "commandReceipts", "auditEvents", "assets",
  "importSessions", "modelRuns", "modelRunEvents", "ruleRuns", "decisions",
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
        const keyPath = storeName === "projects" ? "projectId" : "id";
        const store = database.createObjectStore(storeName, { keyPath });
        if (storeName !== "projects" && storeName !== "importSessions") {
          store.createIndex("projectId", "projectId", { unique: false });
        }
        if (storeName === "projects") store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
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
      auditEvents: auditEvents.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)),
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

  async transaction<T>(projectId: string, operation: (transaction: ProjectTransaction) => Promise<T>): Promise<T> {
    const database = await this.#database;
    const transaction = database.transaction(
      ["projects", "revisions", "commandReceipts", "auditEvents", "assets", "importSessions", "modelRuns"],
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
    const assetWrite = mutation.assetWrites;
    if (assetWrite) {
      for (const record of assetWrite.records) {
        if (assetWrite.stagingSessionId) {
          const request = transaction.objectStore("assets").get(record.id);
          request.onsuccess = () => {
            const staged = request.result as PersistedAsset | undefined;
            if (!staged || staged.stagingSessionId !== assetWrite.stagingSessionId || staged.projectId !== mutation.command.projectId) {
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
