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
  return { projectId, repository, packages: new ProjectPackageService(repository) };
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
});
