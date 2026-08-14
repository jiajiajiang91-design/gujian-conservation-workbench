import "fake-indexeddb/auto";

import { ProjectCommandService } from "@gujian/application";
import { afterEach, describe, expect, it } from "vitest";

import { IndexedDbProjectRepository, LocalAuthorization, openWorkbenchDatabase, WORKBENCH_DB_VERSION } from "./indexeddb-project-repository.js";

const databaseNames: string[] = [];

function createCommand(databaseName: string) {
  const projectId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  return {
    databaseName,
    projectId,
    value: {
      commandType: "CreateProject",
      commandId: crypto.randomUUID(),
      projectId,
      actorId,
      expectedRevisionId: null,
      issuedAt: "2026-08-13T10:00:00Z",
      payload: {
        project: { id: projectId, name: "山门测绘", status: "active", locationText: "测试地点", createdAt: "2026-08-13T10:00:00Z" },
        building: { id: crypto.randomUUID(), projectId, name: "山门", periodText: null, addressText: null, status: "existing" },
      },
    },
  } as const;
}

afterEach(async () => {
  for (const name of databaseNames.splice(0)) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
});

describe("IndexedDbProjectRepository", () => {
  it("将已有 v4 数据库向前升级到 v5 并保留项目库", async () => {
    const databaseName = `gujian-upgrade-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 4);
      request.onupgradeneeded = () => request.result.createObjectStore("projects", { keyPath: "projectId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();
    const upgraded = await openWorkbenchDatabase(databaseName);
    expect(upgraded.version).toBe(WORKBENCH_DB_VERSION);
    expect([...upgraded.objectStoreNames]).toEqual(expect.arrayContaining(["projects", "artifacts", "checkRuns", "deliveryEvaluations", "deliveries"]));
    upgraded.close();
  });

  it("通过 v3 原子事务创建、查询并幂等返回项目", async () => {
    const input = createCommand(`gujian-test-${crypto.randomUUID()}`);
    databaseNames.push(input.databaseName);
    const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(input.databaseName));
    const service = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });

    const first = await service.execute(input.value);
    const repeated = await service.execute(input.value);
    const head = await repository.getProjectHead(input.projectId);
    const projects = await repository.listProjects();

    expect(repeated).toEqual(first);
    expect(head?.snapshot.project.name).toBe("山门测绘");
    expect(projects).toHaveLength(1);
    expect(projects[0]?.auditHeadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("拒绝错误的期望版本且不产生新版本", async () => {
    const input = createCommand(`gujian-test-${crypto.randomUUID()}`);
    databaseNames.push(input.databaseName);
    const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(input.databaseName));
    const service = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
    await service.execute(input.value);

    await expect(service.execute({
      commandType: "CommitFacts",
      commandId: crypto.randomUUID(),
      projectId: input.projectId,
      actorId: input.value.actorId,
      expectedRevisionId: crypto.randomUUID(),
      issuedAt: "2026-08-13T10:01:00Z",
      payload: { facts: [{
        id: crypto.randomUUID(), subjectRef: input.projectId, field: "status", value: "ok",
        producer: { producerType: "demo", fixtureId: "indexeddb-test" }, evidenceRefs: [],
        reviewStatus: "unreviewed", dataStatus: "available",
      }] },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await repository.listProjects()).toHaveLength(1);
  });
});
