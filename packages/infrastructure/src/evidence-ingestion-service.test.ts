import "fake-indexeddb/auto";

import { ProjectCommandService } from "@gujian/application";
import { describe, expect, it } from "vitest";

import { EvidenceIngestionService, type UploadFile } from "./evidence-ingestion-service.js";
import { IndexedDbProjectRepository, LocalAuthorization, openWorkbenchDatabase } from "./indexeddb-project-repository.js";
import { ProjectPackageService } from "./project-package-service.js";

async function project() {
  const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(`gujian-evidence-${crypto.randomUUID()}`));
  const commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
  const projectId = crypto.randomUUID();
  await commands.execute({
    commandType: "CreateProject", commandId: crypto.randomUUID(), projectId, actorId: crypto.randomUUID(),
    expectedRevisionId: null, issuedAt: "2026-08-13T13:00:00Z",
    payload: {
      project: { id: projectId, name: "资料测试", status: "active", locationText: null, createdAt: "2026-08-13T13:00:00Z" },
      building: { id: crypto.randomUUID(), projectId, name: "大殿", periodText: null, addressText: null, status: "existing" },
    },
  });
  const head = await repository.getProjectHead(projectId);
  if (!head) throw new Error("test project missing");
  return { repository, head };
}

function upload(name: string, content: string, type: string): UploadFile {
  const blob = new Blob([content], { type }) as UploadFile & { name: string };
  Object.defineProperty(blob, "name", { value: name });
  return blob;
}

describe("EvidenceIngestionService", () => {
  it("原子保存原文件、证据、解析记录和来源关系", async () => {
    const input = await project();
    const service = new EvidenceIngestionService(input.repository);
    const updated = await service.ingest(input.head, crypto.randomUUID(), upload("测量记录.txt", "通面阔：15800 mm", "text/plain"));

    expect(updated.snapshot.evidences).toHaveLength(1);
    expect(updated.snapshot.parseRecords[0]).toMatchObject({ status: "parsed", extractedText: "通面阔：15800 mm" });
    const stored = await input.repository.getAsset(updated.snapshot.evidences[0]!.assetId);
    expect(await stored.content.text()).toBe("通面阔：15800 mm");
  });

  it("ZIP 回导实际证据，JSON 回导保留缺失资源记录", async () => {
    for (const type of ["zip", "json"] as const) {
      const input = await project();
      const service = new EvidenceIngestionService(input.repository);
      await service.ingest(input.head, crypto.randomUUID(), upload("说明.md", "# 调查记录", "text/markdown"));
      const packages = new ProjectPackageService(input.repository);
      const bytes = type === "zip" ? await packages.exportZip(input.head.projectId) : await packages.exportJson(input.head.projectId);
      await input.repository.clearAllData();
      await packages.import(bytes, `project.${type}`, crypto.randomUUID());
      const assets = await input.repository.getProjectAssets(input.head.projectId);

      expect(assets).toHaveLength(1);
      expect(assets[0]?.record.contentStatus).toBe(type === "zip" ? "available" : "missing");
      expect(assets[0]?.content === null).toBe(type === "json");
    }
  });

  it("文件过大时在暂存前拒绝", async () => {
    const input = await project();
    const service = new EvidenceIngestionService(input.repository, 4);
    await expect(service.ingest(input.head, crypto.randomUUID(), upload("note.txt", "12345", "text/plain")))
      .rejects.toThrow("FILE_SIZE_NOT_ALLOWED");
    expect(await input.repository.getProjectAssets(input.head.projectId)).toHaveLength(0);
  });
});
