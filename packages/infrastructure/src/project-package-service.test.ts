import "fake-indexeddb/auto";

import { ProjectCommandService } from "@gujian/application";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import { IndexedDbProjectRepository, LocalAuthorization, openWorkbenchDatabase } from "./indexeddb-project-repository.js";
import { ProjectPackageService } from "./project-package-service.js";
import { sha256Hex } from "./hash.js";

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

async function commitFollowOnProxyChain(seeded: Awaited<ReturnType<typeof seededRepository>>, tag: string) {
  let head = await seeded.repository.getProjectHead(seeded.projectId);
  if (!head) throw new Error("missing imported project");
  const actorId = crypto.randomUUID();
  const now = "2026-08-13T13:00:00Z";
  const geometrySpecId = crypto.randomUUID();
  const cadJobId = crypto.randomUUID();
  const inputRevisionId = head.revisionId;
  const baseJob = {
    id: cadJobId, projectId: seeded.projectId, inputRevisionId, geometrySpecId, inputHash: sha256Hex(new TextEncoder().encode(`input-${tag}`)),
    idempotencyKey: crypto.randomUUID(), status: "queued" as const, events: [], outputManifestHash: null,
    startedAt: now, completedAt: null,
  };
  await seeded.commands.execute({ commandType: "StartCadJob", commandId: crypto.randomUUID(), projectId: seeded.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: now, payload: { job: baseJob } });
  head = await seeded.repository.getProjectHead(seeded.projectId);
  if (!head) throw new Error("missing project after follow-on CAD start");

  const geometryFiles = [
    ["ifc", "model.ifc", "application/x-step"], ["glb", "model.glb", "model/gltf-binary"],
    ["brepBundle", "model-brep.zip", "application/zip"], ["manifest", "geometry-manifest.json", "application/json"],
    ["sourceMap", "source-map.ndjson", "application/x-ndjson"], ["report", "geometry-report.json", "application/json"],
    ["preview", "geometry-preview.png", "image/png"],
  ] as const;
  const geometryContents = new Map<string, Blob>();
  const geometryAssets = geometryFiles.map(([kind, fileName, mimeType], index) => {
    const id = crypto.randomUUID();
    const bytes = new TextEncoder().encode(`${tag}-geometry-${index}`);
    geometryContents.set(id, new Blob([bytes], { type: mimeType }));
    return { id, projectId: seeded.projectId, fileName, mimeType, byteLength: bytes.byteLength, sha256: sha256Hex(bytes), contentStatus: "available" as const, createdAt: now, kind };
  });
  const geometrySessionId = crypto.randomUUID();
  await seeded.repository.stageAssets(geometrySessionId, geometryAssets.map(({ kind: _kind, ...asset }) => asset), geometryContents);
  const queuedHash = sha256Hex(new TextEncoder().encode(`${tag}-queued`));
  const succeededJob = {
    ...baseJob, status: "succeeded" as const, outputManifestHash: geometryAssets.find((item) => item.kind === "manifest")!.sha256,
    completedAt: now, events: [
      { id: crypto.randomUUID(), jobId: cadJobId, sequence: 0, eventType: "queued" as const, detail: null, occurredAt: now, previousHash: null, eventHash: queuedHash },
      { id: crypto.randomUUID(), jobId: cadJobId, sequence: 1, eventType: "succeeded" as const, detail: null, occurredAt: now, previousHash: queuedHash, eventHash: sha256Hex(new TextEncoder().encode(`${tag}-succeeded`)) },
    ],
  };
  await seeded.commands.execute({ commandType: "SyncCadJobEvents", commandId: crypto.randomUUID(), projectId: seeded.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: now, payload: { job: succeededJob } });
  head = await seeded.repository.getProjectHead(seeded.projectId);
  if (!head) throw new Error("missing project after follow-on CAD sync");

  const objectId = crypto.randomUUID();
  const geometryRevisionId = crypto.randomUUID();
  const geometrySpec = {
    schemaVersion: "2.0" as const, id: geometrySpecId, projectId: seeded.projectId, projectRevisionId: inputRevisionId,
    buildingId: head.snapshot.buildings[0]!.id, inputHash: baseJob.inputHash,
    coordinateSystem: { name: `local-${tag}`, axisOrder: "XYZ" as const, upAxis: "Z" as const, lengthUnit: "mm" as const, origin: [0, 0, 0] as [number, number, number] },
    tolerances: { modellingMm: 0.5, interfaceMm: 0.5, tessellationMm: 1 }, objects: [{
      id: objectId, stableKey: `${tag}-base`, parentId: null, componentType: "base", displayNameZh: "回导后基座", materialCode: "demo",
      solid: { kind: "box" as const, sizeX: "1200", sizeY: "900", sizeZ: "120", centerMm: [0, 0, 60] as [number, number, number] },
      parameters: [], producer: { producerType: "demo" as const, fixtureId: `roundtrip:${tag}` }, factRefs: [], evidenceRefs: [], unknownRefs: [],
    }], interfaces: [], unknowns: [], createdAt: now,
  };
  const geometryRevision = {
    id: geometryRevisionId, projectId: seeded.projectId, projectRevisionId: inputRevisionId, geometrySpecId,
    inputHash: baseJob.inputHash, entityClosureHash: sha256Hex(new TextEncoder().encode(`${tag}-entities`)),
    interfaceClosureHash: sha256Hex(new TextEncoder().encode(`${tag}-interfaces`)), geometrySignature: sha256Hex(new TextEncoder().encode(`${tag}-geometry`)),
    assets: geometryAssets.map(({ id, kind, sha256, mimeType, byteLength }) => ({ assetId: id, kind, sha256, mimeType, byteLength })),
    status: "generated-not-qualified" as const, l1Eligible: false as const, formalEligibility: false as const,
    blockers: ["PROXY_ONLY"], createdAt: now,
  };
  await seeded.commands.execute({ commandType: "CommitGeometryRevision", commandId: crypto.randomUUID(), projectId: seeded.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: now, payload: { cadJobId, geometrySpec, geometryRevision, assets: geometryAssets.map(({ kind: _kind, ...asset }) => asset), stagingSessionId: geometrySessionId } });
  head = await seeded.repository.getProjectHead(seeded.projectId);
  if (!head) throw new Error("missing project after follow-on geometry");

  const matrixId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  const sheetId = crypto.randomUUID();
  const matrix = {
    schemaVersion: "1.0" as const, id: matrixId, projectId: seeded.projectId, projectRevisionId: inputRevisionId, geometryRevisionId,
    titleZh: "回导后新图纸", buildingDisplayNameZh: "正殿", issueState: "proxy-unissued" as const, issueDate: null, revisionLabel: "P02",
    views: [{ id: viewId, key: `${tag}-plan`, displayLabelZh: "回导后平面图", drawingRef: "平-02", kind: "floorPlan" as const, scaleDenominator: 50,
      sheetId, viewportRectMm: [20, 40, 240, 160] as [number, number, number, number], direction: [0, 0, 1] as [number, number, number],
      right: [1, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], sourceTypes: [], sourceEntityIds: [objectId], sourceEvidenceRefs: [], detailRules: [] }],
    sheets: [{ id: sheetId, drawingNumber: "P-02", displayLabelZh: "回导后平面图", pageMm: [420, 297] as [number, number], viewIds: [viewId] }],
    observationCandidates: [], createdAt: now,
  };
  const outputSpecs = [
    { kind: "dxf" as const, name: "drawings-v2.dxf", mime: "image/vnd.dxf", content: `${tag}-native-dxf` },
    { kind: "checkReport" as const, name: "drawing-check-v2.json", mime: "application/json", content: `${tag}-check-report` },
  ];
  const outputContents = new Map<string, Blob>();
  const outputAssets = outputSpecs.map((item) => {
    const id = crypto.randomUUID();
    const bytes = new TextEncoder().encode(item.content);
    outputContents.set(id, new Blob([bytes], { type: item.mime }));
    return { id, projectId: seeded.projectId, fileName: item.name, mimeType: item.mime, byteLength: bytes.byteLength, sha256: sha256Hex(bytes), contentStatus: "available" as const, createdAt: now, kind: item.kind };
  });
  const outputSessionId = crypto.randomUUID();
  await seeded.repository.stageAssets(outputSessionId, outputAssets.map(({ kind: _kind, ...asset }) => asset), outputContents);
  const artifacts = outputAssets.map(({ id: assetId, kind, fileName, sha256, mimeType, byteLength }) => ({
    id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: inputRevisionId, geometryRevisionId, requirementMatrixId: matrixId,
    kind, fileName, assetId, sha256, mimeType, byteLength, status: "generated-not-qualified" as const, l1Eligible: false as const,
    formalEligibility: false as const, sourceRefs: [geometryRevisionId, matrixId], blockers: ["PROXY_ONLY"], createdAt: now,
  }));
  await seeded.commands.execute({ commandType: "CommitArtifactSet", commandId: crypto.randomUUID(), projectId: seeded.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: now, payload: { artifactRequirementMatrices: [matrix], artifacts, assets: outputAssets.map(({ kind: _kind, ...asset }) => asset), stagingSessionId: outputSessionId } });
  head = await seeded.repository.getProjectHead(seeded.projectId);
  if (!head) throw new Error("missing project after follow-on drawings");
  const report = artifacts.find((item) => item.kind === "checkReport")!;
  const checkRun = {
    id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: inputRevisionId, geometryRevisionId, artifactRefs: artifacts.map((item) => item.id),
    status: "completed" as const, results: [{ code: "ROUNDTRIP_DRAWING_HASH", outcome: "passed" as const, message: "回导后新图纸哈希闭合", sourceRefs: [matrixId] }],
    reportAssetId: report.assetId, reportHash: report.sha256, qualification: "generated-not-qualified" as const, l1Eligible: false as const,
    formalEligibility: false as const, completedAt: now,
  };
  await seeded.commands.execute({ commandType: "CommitCheckRun", commandId: crypto.randomUUID(), projectId: seeded.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: now, payload: { checkRun } });
  head = await seeded.repository.getProjectHead(seeded.projectId);
  if (!head) throw new Error("missing project after follow-on check");
  const evaluation = {
    id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: inputRevisionId, geometryRevisionId,
    artifactRefs: artifacts.map((item) => item.id), checkRunRefs: [checkRun.id], outcome: "proxy-ready" as const,
    blockerCodes: ["PROXY_ONLY"], formalEligibility: false as const, evaluatedAt: now,
  };
  await seeded.commands.execute({ commandType: "EvaluateDelivery", commandId: crypto.randomUUID(), projectId: seeded.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: now, payload: { evaluation } });
  head = await seeded.repository.getProjectHead(seeded.projectId);
  if (!head) throw new Error("missing project after follow-on evaluation");
  const manifestBytes = new TextEncoder().encode(`${tag}-delivery-manifest`);
  const manifestAsset = { id: crypto.randomUUID(), projectId: seeded.projectId, fileName: "delivery-manifest-v2.json", mimeType: "application/json", byteLength: manifestBytes.byteLength, sha256: sha256Hex(manifestBytes), contentStatus: "available" as const, createdAt: now };
  const manifestSessionId = crypto.randomUUID();
  await seeded.repository.stageAssets(manifestSessionId, [manifestAsset], new Map([[manifestAsset.id, new Blob([manifestBytes], { type: manifestAsset.mimeType })]]));
  const manifestArtifact = { id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: inputRevisionId, geometryRevisionId, requirementMatrixId: null,
    kind: "deliveryManifest" as const, fileName: manifestAsset.fileName, assetId: manifestAsset.id, sha256: manifestAsset.sha256, mimeType: manifestAsset.mimeType,
    byteLength: manifestAsset.byteLength, status: "generated-not-qualified" as const, l1Eligible: false as const, formalEligibility: false as const,
    sourceRefs: [evaluation.id], blockers: ["PROXY_ONLY"], createdAt: now };
  const draft = { id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: inputRevisionId, geometryRevisionId, evaluationId: evaluation.id,
    artifactRefs: [...artifacts.map((item) => item.id), manifestArtifact.id], manifestAssetId: manifestAsset.id, manifestHash: manifestAsset.sha256,
    status: "proxy-unissued" as const, l1Eligible: false as const, formalEligibility: false as const, signatureStatus: "unsigned" as const,
    restrictions: ["代理成果，不可正式使用"], createdAt: now };
  await seeded.commands.execute({ commandType: "CreateDeliveryDraft", commandId: crypto.randomUUID(), projectId: seeded.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: now, payload: { draft, manifestAsset, manifestArtifact, stagingSessionId: manifestSessionId } });
  return { geometryRevisionId, matrixId, draftId: draft.id };
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
          structured: { kind: "evidenceSummary", summary: "候选摘要", findings: [], missingInformation: ["现场尺寸"] },
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

  it("ZIP 空库回导保留几何、成果、检查、交付和真实成果文件", async () => {
    const seeded = await seededRepository();
    let head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing seeded project");
    const geometrySpecId = crypto.randomUUID();
    const cadJobId = crypto.randomUUID();
    const jobEvent = {
      id: crypto.randomUUID(), jobId: cadJobId, sequence: 0, eventType: "queued" as const,
      detail: null, occurredAt: "2026-08-13T12:10:00Z", previousHash: null, eventHash: "1".repeat(64),
    };
    const baseJob = {
      id: cadJobId, projectId: seeded.projectId, inputRevisionId: head.revisionId,
      geometrySpecId, inputHash: "2".repeat(64), idempotencyKey: crypto.randomUUID(),
      status: "queued" as const, events: [], outputManifestHash: null,
      startedAt: "2026-08-13T12:10:00Z", completedAt: null,
    };
    await seeded.commands.execute({
      commandType: "StartCadJob", commandId: crypto.randomUUID(), projectId: seeded.projectId,
      actorId: crypto.randomUUID(), expectedRevisionId: head.revisionId, issuedAt: "2026-08-13T12:10:00Z",
      payload: { job: baseJob },
    });
    head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing project after start job");

    const geometryFiles = [
      ["ifc", "model.ifc", "application/x-step"], ["glb", "model.glb", "model/gltf-binary"],
      ["brepBundle", "model-brep.zip", "application/zip"],
      ["manifest", "geometry-manifest.json", "application/json"], ["sourceMap", "source-map.ndjson", "application/x-ndjson"],
      ["report", "geometry-report.json", "application/json"], ["preview", "geometry-preview.png", "image/png"],
    ] as const;
    const now = "2026-08-13T12:11:00Z";
    const sessionId = crypto.randomUUID();
    const geometryContents = new Map<string, Blob>();
    const geometryAssets = geometryFiles.map(([kind, fileName, mimeType], index) => {
      const id = crypto.randomUUID();
      const bytes = new TextEncoder().encode(`geometry-${index}`);
      geometryContents.set(id, new Blob([bytes], { type: mimeType }));
      return { id, projectId: seeded.projectId, fileName, mimeType, byteLength: bytes.byteLength, sha256: sha256Hex(bytes), contentStatus: "available" as const, createdAt: now, kind };
    });
    await seeded.repository.stageAssets(sessionId, geometryAssets.map(({ kind: _kind, ...asset }) => asset), geometryContents);
    const manifestHash = geometryAssets.find((item) => item.kind === "manifest")!.sha256;
    const succeededJob = {
      ...baseJob,
      status: "succeeded" as const,
      outputManifestHash: manifestHash,
      completedAt: now,
      events: [jobEvent, {
        id: crypto.randomUUID(), jobId: cadJobId, sequence: 1, eventType: "succeeded" as const,
        detail: null, occurredAt: now, previousHash: jobEvent.eventHash, eventHash: "3".repeat(64),
      }],
    };
    await seeded.commands.execute({
      commandType: "SyncCadJobEvents", commandId: crypto.randomUUID(), projectId: seeded.projectId,
      actorId: crypto.randomUUID(), expectedRevisionId: head.revisionId, issuedAt: now, payload: { job: succeededJob },
    });
    head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing project after job sync");
    const objectId = crypto.randomUUID();
    const factRef = `fact:${crypto.randomUUID()}`;
    const geometrySpec = {
      schemaVersion: "2.0" as const, id: geometrySpecId, projectId: seeded.projectId,
      projectRevisionId: baseJob.inputRevisionId, buildingId: head.snapshot.buildings[0]!.id,
      inputHash: baseJob.inputHash,
      coordinateSystem: { name: "local-demo", axisOrder: "XYZ" as const, upAxis: "Z" as const, lengthUnit: "mm" as const, origin: [0, 0, 0] as [number, number, number] },
      tolerances: { modellingMm: 0.5, interfaceMm: 0.5, tessellationMm: 1 },
      objects: [{
        id: objectId, stableKey: "base", parentId: null, componentType: "base", displayNameZh: "基座", materialCode: "demo",
        solid: { kind: "box" as const, sizeX: "1000", sizeY: "800", sizeZ: "100", centerMm: [0, 0, 50] as [number, number, number] },
        parameters: [], producer: { producerType: "rule" as const, ruleRunId: crypto.randomUUID() },
        factRefs: [factRef], evidenceRefs: [], unknownRefs: [],
      }], interfaces: [], unknowns: [], createdAt: now,
    };
    const geometryRevisionId = crypto.randomUUID();
    const geometryRevision = {
      id: geometryRevisionId, projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId,
      geometrySpecId, inputHash: baseJob.inputHash, entityClosureHash: "4".repeat(64), interfaceClosureHash: "5".repeat(64), geometrySignature: "6".repeat(64),
      assets: geometryAssets.map(({ id, kind, sha256, mimeType, byteLength }) => ({ assetId: id, kind, sha256, mimeType, byteLength })),
      status: "generated-not-qualified" as const, l1Eligible: false as const, formalEligibility: false as const,
      blockers: ["PROXY_ONLY"], createdAt: now,
    };
    await seeded.commands.execute({
      commandType: "CommitGeometryRevision", commandId: crypto.randomUUID(), projectId: seeded.projectId,
      actorId: crypto.randomUUID(), expectedRevisionId: head.revisionId, issuedAt: now,
      payload: { cadJobId, geometrySpec, geometryRevision, assets: geometryAssets.map(({ kind: _kind, ...asset }) => asset), stagingSessionId: sessionId },
    });
    head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing project after geometry commit");
    const geometryArtifacts = geometryAssets.map(({ id: assetId, kind, fileName, sha256, mimeType, byteLength }) => ({
      id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId,
      geometryRevisionId, requirementMatrixId: null, kind: kind === "manifest" ? "geometryManifest" as const : kind === "sourceMap" ? "geometrySourceMap" as const : kind === "report" ? "geometryReport" as const : kind === "preview" ? "geometryPreview" as const : kind,
      fileName, assetId, sha256, mimeType, byteLength, status: "generated-not-qualified" as const,
      l1Eligible: false as const, formalEligibility: false as const, sourceRefs: [`geometry:${geometryRevisionId}`], blockers: ["PROXY_ONLY"], createdAt: now,
    }));
    const matrixId = crypto.randomUUID();
    const viewId = crypto.randomUUID();
    const sheetId = crypto.randomUUID();
    const artifactRequirementMatrix = {
      schemaVersion: "1.0" as const, id: matrixId, projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId,
      geometryRevisionId, titleZh: "项目包往返图纸", buildingDisplayNameZh: "正殿", issueState: "proxy-unissued" as const,
      issueDate: null, revisionLabel: "P01", views: [{
        id: viewId, key: "plan", displayLabelZh: "平面图", drawingRef: "平-01", kind: "floorPlan" as const,
        scaleDenominator: 50, sheetId, viewportRectMm: [20, 40, 240, 160] as [number, number, number, number],
        direction: [0, 0, 1] as [number, number, number], right: [1, 0, 0] as [number, number, number],
        up: [0, 1, 0] as [number, number, number], sourceTypes: [], sourceEntityIds: [objectId], sourceEvidenceRefs: [], detailRules: [],
      }], sheets: [{ id: sheetId, drawingNumber: "P-01", displayLabelZh: "平面图", pageMm: [420, 297] as [number, number], viewIds: [viewId] }],
      observationCandidates: [], createdAt: now,
    };
    const drawingBytes = new TextEncoder().encode("native-dxf-roundtrip");
    const drawingAsset = {
      id: crypto.randomUUID(), projectId: seeded.projectId, fileName: "drawings.dxf", mimeType: "image/vnd.dxf",
      byteLength: drawingBytes.byteLength, sha256: sha256Hex(drawingBytes), contentStatus: "available" as const, createdAt: now,
    };
    const drawingSessionId = crypto.randomUUID();
    await seeded.repository.stageAssets(drawingSessionId, [drawingAsset], new Map([[drawingAsset.id, new Blob([drawingBytes], { type: drawingAsset.mimeType })]]));
    const drawingArtifact = {
      id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId,
      geometryRevisionId, requirementMatrixId: matrixId, kind: "dxf" as const, fileName: drawingAsset.fileName,
      assetId: drawingAsset.id, sha256: drawingAsset.sha256, mimeType: drawingAsset.mimeType, byteLength: drawingAsset.byteLength,
      status: "generated-not-qualified" as const, l1Eligible: false as const, formalEligibility: false as const,
      sourceRefs: [geometryRevisionId, matrixId], blockers: ["PROXY_ONLY"], createdAt: now,
    };
    const artifacts = [...geometryArtifacts, drawingArtifact];
    await seeded.commands.execute({
      commandType: "CommitArtifactSet", commandId: crypto.randomUUID(), projectId: seeded.projectId,
      actorId: crypto.randomUUID(), expectedRevisionId: head.revisionId, issuedAt: now,
      payload: { artifactRequirementMatrices: [artifactRequirementMatrix], artifacts, assets: [drawingAsset], stagingSessionId: drawingSessionId },
    });
    head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing project after artifact commit");
    const reportArtifact = artifacts.find((item) => item.kind === "geometryReport")!;
    const checkRun = {
      id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId, geometryRevisionId,
      artifactRefs: artifacts.map((item) => item.id), status: "completed" as const,
      results: [{ code: "PROXY_TECHNICAL", outcome: "passed" as const, message: "代理技术闭包通过", sourceRefs: [`geometry:${geometryRevisionId}`] }],
      reportAssetId: reportArtifact.assetId, reportHash: reportArtifact.sha256,
      qualification: "generated-not-qualified" as const, l1Eligible: false as const, formalEligibility: false as const, completedAt: now,
    };
    await seeded.commands.execute({
      commandType: "CommitCheckRun", commandId: crypto.randomUUID(), projectId: seeded.projectId,
      actorId: crypto.randomUUID(), expectedRevisionId: head.revisionId, issuedAt: now, payload: { checkRun },
    });
    head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing project after check commit");
    const evaluation = {
      id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId, geometryRevisionId,
      artifactRefs: artifacts.map((item) => item.id), checkRunRefs: [checkRun.id], outcome: "proxy-ready" as const,
      blockerCodes: ["FORMAL_EVIDENCE_MISSING"], formalEligibility: false as const, evaluatedAt: now,
    };
    await seeded.commands.execute({
      commandType: "EvaluateDelivery", commandId: crypto.randomUUID(), projectId: seeded.projectId,
      actorId: crypto.randomUUID(), expectedRevisionId: head.revisionId, issuedAt: now, payload: { evaluation },
    });
    head = await seeded.repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("missing project after evaluation");
    const manifestBytes = new TextEncoder().encode("proxy-delivery-manifest");
    const manifestAssetId = crypto.randomUUID();
    const manifestSessionId = crypto.randomUUID();
    const manifestAsset = {
      id: manifestAssetId, projectId: seeded.projectId, fileName: "delivery-manifest.json", mimeType: "application/json",
      byteLength: manifestBytes.byteLength, sha256: sha256Hex(manifestBytes), contentStatus: "available" as const, createdAt: now,
    };
    await seeded.repository.stageAssets(manifestSessionId, [manifestAsset], new Map([[manifestAssetId, new Blob([manifestBytes], { type: manifestAsset.mimeType })]]));
    const manifestArtifact = {
      id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId,
      geometryRevisionId, requirementMatrixId: null, kind: "deliveryManifest" as const, fileName: manifestAsset.fileName,
      assetId: manifestAssetId, sha256: manifestAsset.sha256, mimeType: manifestAsset.mimeType, byteLength: manifestAsset.byteLength,
      status: "generated-not-qualified" as const, l1Eligible: false as const, formalEligibility: false as const,
      sourceRefs: [`delivery-evaluation:${evaluation.id}`], blockers: ["FORMAL_EVIDENCE_MISSING"], createdAt: now,
    };
    const draft = {
      id: crypto.randomUUID(), projectId: seeded.projectId, projectRevisionId: baseJob.inputRevisionId, geometryRevisionId,
      evaluationId: evaluation.id, artifactRefs: [...artifacts.map((item) => item.id), manifestArtifact.id],
      manifestAssetId, manifestHash: manifestAsset.sha256, status: "proxy-unissued" as const,
      l1Eligible: false as const, formalEligibility: false as const, signatureStatus: "unsigned" as const,
      restrictions: ["代理成果，不可用于正式交付"], createdAt: now,
    };
    await seeded.commands.execute({
      commandType: "CreateDeliveryDraft", commandId: crypto.randomUUID(), projectId: seeded.projectId,
      actorId: crypto.randomUUID(), expectedRevisionId: head.revisionId, issuedAt: now,
      payload: { draft, manifestAsset, manifestArtifact, stagingSessionId: manifestSessionId },
    });

    const json = await seeded.packages.exportJson(seeded.projectId);
    const zip = await seeded.packages.exportZip(seeded.projectId);
    await seeded.repository.clearAllData();
    await seeded.packages.import(json, "project.gujian.json", crypto.randomUUID());
    const jsonMatrices = await seeded.repository.getProjectArtifactRequirementMatrices(seeded.projectId);
    const jsonDrawing = (await seeded.repository.getProjectArtifacts(seeded.projectId)).find((item) => item.id === drawingArtifact.id);
    expect(jsonMatrices).toEqual([artifactRequirementMatrix]);
    expect(jsonMatrices.some((item) => item.id === jsonDrawing?.requirementMatrixId)).toBe(true);
    await expect(seeded.repository.getAsset(drawingAsset.id)).rejects.toThrow("ASSET_CONTENT_MISSING");

    await seeded.repository.clearAllData();
    await seeded.packages.import(zip, "project.gujian.zip", crypto.randomUUID());
    const imported = await seeded.repository.getProjectHead(seeded.projectId);
    expect(imported?.snapshot.geometryRevisions.map((item) => item.id)).toContain(geometryRevisionId);
    expect(await seeded.repository.getProjectCadJobs(seeded.projectId)).toHaveLength(1);
    expect(await seeded.repository.getProjectArtifactRequirementMatrices(seeded.projectId)).toEqual([artifactRequirementMatrix]);
    expect(await seeded.repository.getProjectArtifacts(seeded.projectId)).toHaveLength(artifacts.length + 1);
    const importedDrawing = (await seeded.repository.getProjectArtifacts(seeded.projectId)).find((item) => item.id === drawingArtifact.id);
    expect(importedDrawing?.requirementMatrixId).toBe(matrixId);
    expect((await seeded.repository.getProjectArtifactRequirementMatrices(seeded.projectId)).some((item) => item.id === importedDrawing?.requirementMatrixId)).toBe(true);
    expect(await seeded.repository.getProjectCheckRuns(seeded.projectId)).toEqual([checkRun]);
    expect(await seeded.repository.getProjectDeliveryEvaluations(seeded.projectId)).toEqual([evaluation]);
    expect(await seeded.repository.getProjectDeliveries(seeded.projectId)).toEqual([draft]);
    const importedManifest = await seeded.repository.getAsset(manifestAssetId);
    expect(new TextDecoder().decode(await importedManifest.content.arrayBuffer())).toBe("proxy-delivery-manifest");

    const followOn = await commitFollowOnProxyChain(seeded, "post-import");
    const followOnHead = await seeded.repository.getProjectHead(seeded.projectId);
    expect(followOnHead?.snapshot.geometryRevisions.map((item) => item.id)).toContain(followOn.geometryRevisionId);
    expect((await seeded.repository.getProjectArtifactRequirementMatrices(seeded.projectId)).map((item) => item.id)).toContain(followOn.matrixId);
    expect((await seeded.repository.getProjectDeliveries(seeded.projectId)).map((item) => item.id)).toContain(followOn.draftId);
  });
});
