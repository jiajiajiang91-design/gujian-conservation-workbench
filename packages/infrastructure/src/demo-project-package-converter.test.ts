import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { buildDemoProjectPackage, type LegacyDemoGeometryManifest } from "./demo-project-package-converter.js";
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

function sampleManifest(): LegacyDemoGeometryManifest {
  return {
      geometryRevisionId: "00000000-0000-5000-8000-000000000001",
      geometrySignature: "a".repeat(64),
      entities: [
        {
          entityId: "00000000-0000-5000-8000-000000000010",
          key: "column:0", componentType: "column", domainTerm: { displayNameZh: "柱（团队演示）" },
          materialFact: { materialCode: "timber-demo" }, bounds: [[-100, -100, 240], [100, 100, 3000]],
          dimensionFacts: [
            { dimensionId: "count-1", category: "countPerLeaf", value: 2 },
            { dimensionId: "length-1", category: "height", value: 2760 },
            { dimensionId: "length-2", category: "bottomDiameter", value: 200 },
            { dimensionId: "length-3", category: "topDiameter", value: 180 },
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
        {
          entityId: "00000000-0000-5000-8000-000000000013",
          key: "column-base:0", componentType: "columnBase", bounds: [[-280, -280, 0], [280, 280, 240]],
          dimensionFacts: [{ dimensionId: "length-4", category: "lowerDiameter", value: 560 }], unknowns: [],
        },
      ],
      interfaces: [
        {
          interfaceId: "IF-COLUMN-BASE-0", role: "column-base",
          fromEntityId: "00000000-0000-5000-8000-000000000010", toEntityId: "00000000-0000-5000-8000-000000000013",
          interfaceKind: "bearing", contactMode: "surface", expectedGapMm: 0, maximumGapMm: 0.5, maximumUnexpectedOverlapMm3: 0.1,
        },
        {
          interfaceId: "IF-TILE-LAP-0", role: "tile-longitudinal-lap",
          fromEntityId: "00000000-0000-5000-8000-000000000012", toEntityId: "00000000-0000-5000-8000-000000000011",
          interfaceKind: "lap", contactMode: "overlapZone", expectedGapMm: 0.5, maximumGapMm: 1.5, maximumUnexpectedOverlapMm3: 0.1,
        },
      ],
  };
}

const SOURCE_FILES = [{
  fileName: "manifest.json", mimeType: "application/json", bytes: new TextEncoder().encode("{}\n"),
  evidenceType: "document" as const, title: "演示 manifest",
}];

function sample() {
  return buildDemoProjectPackage({
    createdAt: "2026-08-14T12:00:00Z",
    projectName: "团队 demo 泛化项目",
    buildingName: "演示构造样本",
    fixtureId: "test-demo-fixture",
    manifest: sampleManifest(),
    sourceFiles: SOURCE_FILES,
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
    expect(column.parameters.find((item) => item.name === "height")).toMatchObject({ valueType: "length", exactValue: "2760", unit: "mm" });
    expect(column.solid).toMatchObject({ kind: "cylinder", radius: "95", axis: "z" });
    expect(spec.unknowns.some((item) => item.reasonCode === "DEMO_TRANSLATION_TAPER_AVERAGED" && item.blocksFormalEligibility)).toBe(true);
    expect(spec.unknowns.some((item) => item.reasonCode === "DEMO_TRANSLATION_BOUNDS_FALLBACK")).toBe(true);
    expect(spec.unknowns.some((item) => item.reasonCode === "DEMO_INTERFACES_NOT_CARRIED")).toBe(true);
    expect(spec.interfaces).toHaveLength(1);
    expect(spec.interfaces[0]).toMatchObject({
      interfaceType: "bearing",
      fromObjectId: "00000000-0000-5000-8000-000000000010",
      toObjectId: "00000000-0000-5000-8000-000000000013",
      fromSurface: "zMin", toSurface: "zMax",
    });
    expect(result.interfaceCount).toBe(1);
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

// 演示包带几何成果时必须带一个合法的几何版本，
// 否则导入后三维视图显示未生成，演示做不到打开即见。
describe("演示包携带几何成果", () => {
  const geometryAsset = (kind: string, fileName: string, mimeType: string) => ({
    kind, fileName, mimeType, bytes: new TextEncoder().encode(`${kind}-content`),
  }) as never;

  function withGeometry() {
    return buildDemoProjectPackage({
      createdAt: "2026-08-14T12:00:00Z",
      projectName: "团队 demo 泛化项目",
      buildingName: "演示构造样本",
      fixtureId: "test-demo-fixture",
      manifest: sampleManifest(),
      sourceFiles: SOURCE_FILES,
      geometry: {
        assets: [
          geometryAsset("ifc", "model.ifc", "application/x-step"),
          geometryAsset("glb", "model.glb", "model/gltf-binary"),
          geometryAsset("brepBundle", "model-brep.zip", "application/zip"),
          geometryAsset("sourceMap", "source-map.ndjson", "application/x-ndjson"),
          geometryAsset("report", "geometry-report.json", "application/json"),
          geometryAsset("preview", "preview.png", "image/png"),
          geometryAsset("manifest", "geometry-manifest.json", "application/json"),
        ],
        inputHash: "b".repeat(64),
        entityClosureHash: "c".repeat(64),
        interfaceClosureHash: "d".repeat(64),
        geometrySignature: "e".repeat(64),
        blockers: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"],
      },
    });
  }

  it("不传几何时行为不变，包内没有几何版本", () => {
    const result = sample();
    expect(result.geometryRevisionId).toBeNull();
    expect(result.geometryAssetCount).toBe(0);
  });

  it("传几何时写入通过契约校验的几何版本与七类资产", async () => {
    const result = withGeometry();
    expect(result.geometryRevisionId).not.toBeNull();
    expect(result.geometryAssetCount).toBe(7);

    const name = `t0b-geometry-${crypto.randomUUID()}`;
    databases.push(name);
    const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(name));
    const projectId = await new ProjectPackageService(repository).import(result.packageBytes, "demo.gujian.zip", crypto.randomUUID());
    const head = await repository.getProjectHead(projectId);
    const revision = head!.snapshot.geometryRevisions.at(-1)!;
    expect(revision.id).toBe(result.geometryRevisionId);
    expect(revision.status).toBe("generated-not-qualified");
    expect(revision.l1Eligible).toBe(false);
    expect(revision.formalEligibility).toBe(false);
    expect([...revision.assets.map((asset) => asset.kind)].sort())
      .toEqual(["brepBundle", "glb", "ifc", "manifest", "preview", "report", "sourceMap"]);

    const assets = await repository.getProjectAssets(projectId);
    const glbRef = revision.assets.find((asset) => asset.kind === "glb")!;
    const glb = assets.find((asset) => asset.record.id === glbRef.assetId)!;
    expect(glb.record.contentStatus).toBe("available");
    expect(glb.content).not.toBeNull();
  });
});
