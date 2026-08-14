import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { buildDemoProjectPackage } from "./demo-project-package-converter.js";
import { IndexedDbProjectRepository, openWorkbenchDatabase } from "./indexeddb-project-repository.js";
import { ProjectPackageService } from "./project-package-service.js";

const databases: string[] = [];

afterEach(async () => {
  for (const name of databases.splice(0)) await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
});

function sample() {
  return buildDemoProjectPackage({
    createdAt: "2026-08-14T12:00:00Z",
    projectName: "团队 demo 泛化项目",
    buildingName: "演示构造样本",
    fixtureId: "test-demo-fixture",
    manifest: {
      geometryRevisionId: "00000000-0000-5000-8000-000000000001",
      geometrySignature: "a".repeat(64),
      entities: [
        {
          entityId: "00000000-0000-5000-8000-000000000010",
          key: "column:0", componentType: "column", domainTerm: { displayNameZh: "柱（团队演示）" },
          materialFact: { materialCode: "timber-demo" }, bounds: [[-100, -100, 0], [100, 100, 3000]],
          dimensionFacts: [
            { dimensionId: "count-1", category: "countPerLeaf", value: 2 },
            { dimensionId: "length-1", category: "height", value: 3000 },
          ], unknowns: ["actual-timber-species"],
        },
        {
          entityId: "00000000-0000-5000-8000-000000000011",
          key: "roof-board:0", componentType: "roofBoard", bounds: [[-1200, -800, 3000], [1200, 800, 3120]],
          dimensionFacts: [], unknowns: [],
        },
        {
          entityId: "00000000-0000-5000-8000-000000000012",
          key: "pan-tile:0", componentType: "panTile", bounds: [[-1000, -700, 3120], [1000, 700, 3300]],
          dimensionFacts: [], unknowns: [],
        },
      ],
    },
    sourceFiles: [{
      fileName: "manifest.json", mimeType: "application/json", bytes: new TextEncoder().encode("{}\n"),
      evidenceType: "document", title: "演示 manifest",
    }],
  });
}

describe("demo project package converter", () => {
  it("把历史 demo 变成标准包，并在空库保持来源、类型化数量和 GeometrySpec", async () => {
    const result = sample();
    const name = `third-project-${crypto.randomUUID()}`;
    databases.push(name);
    const database = await openWorkbenchDatabase(name);
    const repository = new IndexedDbProjectRepository(database);
    const service = new ProjectPackageService(repository);

    const parsed = service.parse(result.packageBytes, "third-project.gujian.zip");
    const spec = parsed.snapshot.geometrySpecs[0]!;
    const column = spec.objects.find((item) => item.stableKey === "column:0")!;
    expect(column.id).toBe("00000000-0000-5000-8000-000000000010");
    expect(column.producer).toEqual({ producerType: "demo", fixtureId: "test-demo-fixture" });
    expect(column.parameters.find((item) => item.name === "countPerLeaf")).toMatchObject({ valueType: "count", value: 2, unit: "1" });
    expect(column.parameters.find((item) => item.name === "height")).toMatchObject({ valueType: "length", exactValue: "3000", unit: "mm" });
    expect(spec.unknowns.some((item) => item.reasonCode === "V3_MESH_TO_PARAMETRIC_BREP_APPROXIMATION" && item.blocksFormalEligibility)).toBe(true);
    expect(parsed.snapshot.taskDefinitions[0]?.artifactRequirements?.sheets.map((item) => item.pageMm)).toEqual([[594, 420], [420, 297]]);

    const importedId = await service.import(result.packageBytes, "third-project.gujian.zip", crypto.randomUUID());
    const head = await repository.getProjectHead(importedId);
    expect(head?.snapshot.geometrySpecs).toHaveLength(1);
    expect(head?.snapshot.evidences.every((item) => item.dataStatus === "available")).toBe(true);
    expect((await repository.getProjectAssets(importedId)).every((item) => item.content !== null)).toBe(true);
    database.close();
  });

  it("同一冻结输入产生逐字节一致的项目包", () => {
    const first = sample();
    const second = sample();
    expect(second.packageSha256).toBe(first.packageSha256);
    expect(second.packageBytes).toEqual(first.packageBytes);
  });
});
