import "fake-indexeddb/auto";

import { ProjectCommandService } from "@gujian/application";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import { IndexedDbProjectRepository, LocalAuthorization, openWorkbenchDatabase } from "./indexeddb-project-repository.js";
import { ProjectPackageService } from "./project-package-service.js";

async function seededRepository() {
  const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(`gujian-package-${crypto.randomUUID()}`));
  const commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
  const projectId = crypto.randomUUID();
  await commands.execute({
    commandType: "CreateProject",
    commandId: crypto.randomUUID(),
    projectId,
    actorId: crypto.randomUUID(),
    expectedRevisionId: null,
    issuedAt: "2026-08-13T12:00:00Z",
    payload: {
      project: { id: projectId, name: "项目包往返测试", status: "active", locationText: null, createdAt: "2026-08-13T12:00:00Z" },
      building: { id: crypto.randomUUID(), projectId, name: "正殿", periodText: null, addressText: null, status: "existing" },
    },
  });
  return { projectId, repository, commands, packages: new ProjectPackageService(repository) };
}

describe("ProjectPackageService", () => {
  it("JSON 与 ZIP 均可在空库回导并保留来源版本和审计前缀", async () => {
    for (const type of ["json", "zip"] as const) {
      const seeded = await seededRepository();
      const bytes = type === "json"
        ? await seeded.packages.exportJson(seeded.projectId)
        : await seeded.packages.exportZip(seeded.projectId);
      await seeded.repository.clearAllData();

      await seeded.packages.import(bytes, `project.${type}`, crypto.randomUUID());
      const closure = await seeded.repository.exportProjectClosure(seeded.projectId);

      expect(closure.head.snapshot.adoptedRecordRefs.some((ref) => ref.startsWith("revision:"))).toBe(true);
      expect(closure.auditEvents).toHaveLength(2);
      expect(closure.auditEvents[1]?.previousEventHash).toBe(closure.auditEvents[0]?.eventHash);
    }
  });

  it("ZIP 空库回导保留模型运行和未审核候选", async () => {
    const seeded = await seededRepository();
    const head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing seeded project");
    const runId = crypto.randomUUID();
    const now = "2026-08-13T12:05:00Z";
    const events = ["queued", "succeeded"].map((eventType, sequence) => ({
      id: crypto.randomUUID(), runId, sequence, eventType: eventType as "queued" | "succeeded",
      attempt: 1, detail: null, occurredAt: now,
    }));
    await seeded.commands.execute({
      commandType: "CommitModelRunResult",
      commandId: crypto.randomUUID(),
      projectId: seeded.projectId,
      actorId: crypto.randomUUID(),
      expectedRevisionId: head.revisionId,
      issuedAt: now,
      payload: {
        run: {
          id: runId, projectId: seeded.projectId, inputRevisionId: head.revisionId,
          inputHash: "a".repeat(64), provider: "moonshot", model: "kimi-k2.6", taskType: "evidence-summary",
          status: "succeeded", evidenceRefs: [], events,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0 },
          outputHash: "b".repeat(64), startedAt: now, completedAt: now,
        },
        candidate: {
          id: crypto.randomUUID(), projectId: seeded.projectId, runId, inputRevisionId: head.revisionId,
          taskType: "evidence-summary", contentText: "候选摘要",
          structured: { summary: "候选摘要", findings: [], missingInformation: ["现场尺寸"] },
          producer: { producerType: "model", runId }, evidenceRefs: [], reviewStatus: "unreviewed", createdAt: now,
        },
      },
    });
    const zip = await seeded.packages.exportZip(seeded.projectId);
    await seeded.repository.clearAllData();
    await seeded.packages.import(zip, "project.gujian.zip", crypto.randomUUID());
    const imported = await seeded.repository.getProjectHead(seeded.projectId);
    expect(imported?.snapshot.candidates).toHaveLength(1);
    expect(imported?.snapshot.candidates[0]?.producer.producerType).toBe("model");
    expect(await seeded.repository.getProjectModelRuns(seeded.projectId)).toHaveLength(1);
  });

  it("拒绝 ZIP 路径穿越和未支持的文件类型", async () => {
    const seeded = await seededRepository();
    const malicious = zipSync({ "../project.json": strToU8("{}"), "manifest.json": strToU8("{}") });
    expect(() => seeded.packages.parse(malicious, "project.zip")).toThrow("PACKAGE_PATH_INVALID");
    expect(() => seeded.packages.parse(strToU8("{}"), "project.dwg")).toThrow("PACKAGE_TYPE_NOT_SUPPORTED");
  });

  it("哈希篡改后拒绝导入", async () => {
    const seeded = await seededRepository();
    const zip = await seeded.packages.exportZip(seeded.projectId);
    zip[Math.floor(zip.length / 2)] = (zip[Math.floor(zip.length / 2)] ?? 0) ^ 1;
    expect(() => seeded.packages.parse(zip, "project.zip")).toThrow();
  });

  it("兼容尚未包含运行与决定数组的早期 v3 JSON 包", async () => {
    const seeded = await seededRepository();
    const bytes = await seeded.packages.exportJson(seeded.projectId);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    delete value.modelRuns;
    delete value.ruleRuns;
    delete value.decisions;
    const parsed = seeded.packages.parse(new TextEncoder().encode(JSON.stringify(value)), "project.json");
    expect(parsed.modelRuns).toEqual([]);
    expect(parsed.ruleRuns).toEqual([]);
    expect(parsed.decisions).toEqual([]);
  });
});
