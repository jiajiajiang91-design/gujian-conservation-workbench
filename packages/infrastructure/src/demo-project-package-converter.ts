import {
  AuditEventSchema,
  ProjectDrivenGeometrySpecSchema,
  ProjectRevisionSchema,
  ProjectSnapshotSchema,
  type ProjectDrivenGeometrySpec,
} from "@gujian/domain";
import { strToU8, zipSync } from "fflate";

import { canonicalJson, recordHash, sha256Hex } from "./hash.js";

interface LegacyDimensionFact {
  readonly dimensionId?: string;
  readonly category: string;
  readonly value: number | string;
}

interface LegacyEntity {
  readonly entityId: string;
  readonly key: string;
  readonly componentType: string;
  readonly domainTerm?: { readonly displayNameZh?: string };
  readonly materialFact?: { readonly materialCode?: string };
  readonly dimensionFacts?: readonly LegacyDimensionFact[];
  readonly unknowns?: readonly string[];
  readonly bounds: readonly [readonly [number, number, number], readonly [number, number, number]];
}

export interface LegacyDemoGeometryManifest {
  readonly geometryRevisionId: string;
  readonly geometrySignature: string;
  readonly entities: readonly LegacyEntity[];
}

export interface DemoSourceFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly evidenceType: "document" | "other";
  readonly title: string;
}

export interface DemoConversionInput {
  readonly manifest: LegacyDemoGeometryManifest;
  readonly sourceFiles: readonly DemoSourceFile[];
  readonly createdAt: string;
  readonly projectName: string;
  readonly buildingName: string;
  readonly fixtureId: string;
}

export interface DemoConversionResult {
  readonly packageBytes: Uint8Array;
  readonly projectId: string;
  readonly buildingId: string;
  readonly geometrySpecId: string;
  readonly packageSha256: string;
  readonly sourceAssetSha256: readonly string[];
  readonly objectCount: number;
  readonly unknownCount: number;
  readonly originalGeometrySignature: string;
}

function deterministicUuid(seed: string): string {
  const hex = sha256Hex(seed).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function exact(value: number | string): string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) throw new Error("DEMO_PARAMETER_NOT_FINITE");
  return Number.isInteger(value) ? String(value) : value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

function parameterType(category: string): "length" | "angle" | "count" | "ratio" {
  if (/(?:count|rows?|columns?|courses?|segments?|bays?)/i.test(category)) return "count";
  if (/(?:angle|slope|pitchDeg)/i.test(category)) return "angle";
  if (/(?:ratio|factor)/i.test(category)) return "ratio";
  return "length";
}

function readableName(entity: LegacyEntity): string {
  const value = entity.domainTerm?.displayNameZh?.trim();
  if (value && /[\u3400-\u9fff]/u.test(value)) return value;
  const names: Record<string, string> = {
    column: "柱（团队演示）",
    columnBase: "柱下承托构件（团队演示）",
    bracketSeat: "承托座（团队演示）",
    bracketArm: "承托臂（团队演示）",
    bearingBlock: "檩下承块（团队演示）",
    panTile: "凹面瓦件（团队演示）",
    coverTile: "盖瓦件（团队演示）",
    ridgeTile: "屋脊构件（团队演示）",
    roofBoard: "屋面板（团队演示）",
    rafter: "椽（团队演示）",
    flyRafter: "檐端续接椽（团队演示）",
    wall: "墙体（团队演示）",
  };
  return names[entity.componentType] ?? `${entity.componentType}（团队演示）`;
}

function representativeKeys(entities: readonly LegacyEntity[], limit = 480): string[] {
  const selected = new Map<string, string>();
  for (const entity of entities) if (!selected.has(entity.componentType)) selected.set(entity.componentType, entity.key);
  const stride = Math.max(1, Math.floor(entities.length / Math.max(1, limit - selected.size)));
  for (let index = 0; index < entities.length && selected.size < limit; index += stride) {
    selected.set(`entity:${entities[index]!.entityId}`, entities[index]!.key);
  }
  return [...selected.values()];
}

function projectGeometrySpec(input: DemoConversionInput, projectId: string, buildingId: string, revisionId: string, evidenceId: string): ProjectDrivenGeometrySpec {
  if (!input.manifest.entities.length) throw new Error("DEMO_MANIFEST_EMPTY");
  const unknowns: ProjectDrivenGeometrySpec["unknowns"] = [];
  const objects: ProjectDrivenGeometrySpec["objects"] = input.manifest.entities.map((entity) => {
    const conversionUnknownId = deterministicUuid(`unknown:conversion:${entity.entityId}`);
    const entityUnknownIds = (entity.unknowns ?? []).map((reason) => deterministicUuid(`unknown:${entity.entityId}:${reason}`));
    unknowns.push({
      id: conversionUnknownId,
      subjectRef: entity.entityId,
      reasonCode: "V3_MESH_TO_PARAMETRIC_BREP_APPROXIMATION",
      description: "旧 v3 网格仅作为团队 demo 证据；当前实体为轴对齐参数化包络，曲面、节点与构造关系尚未按 OCP 精确重建。",
      requiredEvidence: ["经独立复核的 OCP 曲面和节点接口重建记录"],
      affectedRefs: [entity.entityId], evidenceRefs: [evidenceId],
      blocksProxyOutcome: false, blocksFormalEligibility: true,
    });
    for (const [index, reason] of (entity.unknowns ?? []).entries()) {
      unknowns.push({
        id: entityUnknownIds[index]!, subjectRef: entity.entityId,
        reasonCode: `LEGACY_DEMO_${reason.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
        description: `旧 v3 团队 demo 未知项：${reason}`,
        requiredEvidence: ["项目自身证据或专业人员复核记录"], affectedRefs: [entity.entityId], evidenceRefs: [evidenceId],
        blocksProxyOutcome: false, blocksFormalEligibility: true,
      });
    }
    const [minimum, maximum] = entity.bounds;
    const size = maximum.map((value, index) => Math.max(0.001, value - minimum[index]!)) as [number, number, number];
    const center = maximum.map((value, index) => (value + minimum[index]!) / 2) as [number, number, number];
    return {
      id: entity.entityId, stableKey: entity.key, parentId: null,
      componentType: entity.componentType, displayNameZh: readableName(entity),
      materialCode: entity.materialFact?.materialCode ?? "demo-material-unknown",
      solid: { kind: "box" as const, sizeX: exact(size[0]), sizeY: exact(size[1]), sizeZ: exact(size[2]), centerMm: center },
      parameters: (entity.dimensionFacts ?? []).map((fact) => {
        const kind = parameterType(fact.category);
        const base = {
          id: deterministicUuid(`parameter:${entity.entityId}:${fact.dimensionId ?? fact.category}`), name: fact.category,
          basis: "demo" as const, factRefs: [`demo:v3-dimension:${fact.dimensionId ?? fact.category}`], evidenceRefs: [evidenceId],
        };
        if (kind === "count") return { ...base, valueType: "count" as const, value: Math.max(0, Math.round(Number(fact.value))), unit: "1" as const };
        if (kind === "angle") return { ...base, valueType: "angle" as const, exactValue: exact(fact.value), unit: "deg" as const };
        if (kind === "ratio") return { ...base, valueType: "ratio" as const, exactValue: exact(fact.value), unit: "1" as const };
        return { ...base, valueType: "length" as const, exactValue: exact(fact.value), unit: "mm" as const };
      }),
      producer: { producerType: "demo" as const, fixtureId: input.fixtureId },
      factRefs: [`demo:v3-entity:${entity.entityId}`], evidenceRefs: [evidenceId],
      unknownRefs: [conversionUnknownId, ...entityUnknownIds],
    };
  });
  const specBase: ProjectDrivenGeometrySpec = {
    schemaVersion: "2.0", id: deterministicUuid(`geometry-spec:${input.manifest.geometrySignature}`),
    projectId, projectRevisionId: revisionId, buildingId, inputHash: "0".repeat(64),
    coordinateSystem: { name: "团队演示项目局部坐标", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects, interfaces: [], unknowns, createdAt: input.createdAt,
  };
  return ProjectDrivenGeometrySpecSchema.parse({ ...specBase, inputHash: recordHash(specBase) });
}

export function buildDemoProjectPackage(input: DemoConversionInput): DemoConversionResult {
  const sourceSeed = `${input.fixtureId}:${input.manifest.geometrySignature}`;
  const projectId = deterministicUuid(`project:${sourceSeed}`);
  const buildingId = deterministicUuid(`building:${sourceSeed}`);
  const actorId = deterministicUuid(`actor:${sourceSeed}`);
  const sourceRevisionId = deterministicUuid(`revision:${sourceSeed}`);
  const manifestEvidenceId = deterministicUuid(`evidence:manifest:${sourceSeed}`);
  const geometrySpec = projectGeometrySpec(input, projectId, buildingId, sourceRevisionId, manifestEvidenceId);
  const representative = representativeKeys(input.manifest.entities);
  const byType = new Map<string, string[]>();
  for (const entity of input.manifest.entities) byType.set(entity.componentType, [...(byType.get(entity.componentType) ?? []), entity.key]);
  const supportKeys = ["column", "columnBase", "bracketSeat", "bracketArm", "bearingBlock", "purlin", "eaveBeam"]
    .flatMap((type) => (byType.get(type) ?? []).slice(0, 4)).slice(0, 30);
  const allEvidenceIds = input.sourceFiles.map((file) => deterministicUuid(`evidence:${sourceSeed}:${file.fileName}`));
  const taskId = deterministicUuid(`task:${sourceSeed}`);
  const taskDefinition = {
    id: taskId, name: "团队 demo 跨项目成果任务", scope: ["泛化验证", "参数化包络审阅"],
    regulationRefs: ["internal:demo-proxy-policy-v1"], deliverables: ["IFC", "GLB", "DXF", "SVG", "PDF", "检查报告"],
    responsibilities: [{ role: "projectLead" as const, actorId }], automationPolicyRef: "internal:demo-proxy-automation-v1",
    artifactRequirements: {
      titleZh: "团队演示构造样本代理图纸", revisionLabel: "D1",
      geometryTargetRoles: ["column", "roofBoard", "panTile"].filter((type) => byType.has(type)),
      sheets: [
        { key: "sheet-a2", drawingNumber: "D-01", displayLabelZh: "总体与立面", pageMm: [594, 420] },
        { key: "sheet-a3", drawingNumber: "D-02", displayLabelZh: "剖面与承托组合", pageMm: [420, 297] },
      ],
      views: [
        { key: "floor", displayLabelZh: "底层平面示意", drawingRef: "D-01-1", kind: "floorPlan", scaleDenominator: 50, sheetKey: "sheet-a2", viewportRectMm: [20, 220, 260, 175], direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "roof", displayLabelZh: "屋顶平面示意", drawingRef: "D-01-2", kind: "roofPlan", scaleDenominator: 50, sheetKey: "sheet-a2", viewportRectMm: [314, 220, 260, 175], direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "south", displayLabelZh: "南立面示意", drawingRef: "D-01-3", kind: "elevation", scaleDenominator: 50, sheetKey: "sheet-a2", viewportRectMm: [20, 20, 260, 175], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "axon", displayLabelZh: "轴测示意", drawingRef: "D-01-4", kind: "axonometric", scaleDenominator: 50, sheetKey: "sheet-a2", viewportRectMm: [314, 20, 260, 175], direction: [1, 1, -1], right: [1, -1, 0], up: [1, 1, 2], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "transverse", displayLabelZh: "横剖示意", drawingRef: "D-02-1", kind: "transverseSection", scaleDenominator: 50, sheetKey: "sheet-a3", viewportRectMm: [15, 150, 185, 125], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], sectionPlane: { normal: [1, 0, 0], offsetMm: 0 }, targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "longitudinal", displayLabelZh: "纵剖示意", drawingRef: "D-02-2", kind: "longitudinalSection", scaleDenominator: 50, sheetKey: "sheet-a3", viewportRectMm: [220, 150, 185, 125], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], sectionPlane: { normal: [0, 1, 0], offsetMm: 0 }, targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "support-detail", displayLabelZh: "檐下承托组合包络详图", drawingRef: "D-02-3", kind: "detail", scaleDenominator: 20, sheetKey: "sheet-a3", viewportRectMm: [15, 15, 390, 110], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], sectionPlane: { normal: [1, 0, 0], offsetMm: 1800 }, cropBoundsMm: [-3500, 3500, 3600, 5600], targetStableKeys: supportKeys.length ? supportKeys : representative.slice(0, 20), sourceEvidenceRefs: [manifestEvidenceId] },
      ],
    }, confirmedAt: input.createdAt,
  };

  const sourceDeclaration = strToU8(`${canonicalJson({
    schemaVersion: "third-project-demo-source-1", producerType: "demo", formalEligibility: false,
    originalGeometryRevisionId: input.manifest.geometryRevisionId,
    originalGeometrySignature: input.manifest.geometrySignature,
    conversionMode: "axis-aligned-parametric-envelope",
    limitations: ["非实测", "非真实中国古建", "曲面与接口未精确重建", "不可用于正式交付或施工"],
    sourceFiles: input.sourceFiles.map((file) => ({ fileName: file.fileName, sha256: sha256Hex(file.bytes), byteLength: file.bytes.byteLength })),
  })}\n`);
  const sources = [...input.sourceFiles, { fileName: "demo-source-declaration.json", mimeType: "application/json", bytes: sourceDeclaration, evidenceType: "document" as const, title: "团队 demo 来源与转换边界" }];
  const assets = sources.map((file) => {
    const id = deterministicUuid(`asset:${sourceSeed}:${file.fileName}`);
    return {
      id, projectId, fileName: file.fileName, mimeType: file.mimeType, byteLength: file.bytes.byteLength,
      sha256: sha256Hex(file.bytes), contentStatus: "available" as const, createdAt: input.createdAt,
      path: `evidence/${id}/${file.fileName.replace(/[^\p{L}\p{N}._-]+/gu, "_")}`,
      bytes: file.bytes, evidenceType: file.evidenceType, title: file.title,
    };
  });
  const evidences = assets.map((asset) => ({
    id: deterministicUuid(`evidence:${sourceSeed}:${asset.fileName}`), projectId, assetId: asset.id,
    evidenceType: asset.evidenceType, title: asset.title,
    rightsDeclaration: "团队自有 demo，仅用于工程泛化验证；不可作为真实建筑或正式专业成果。",
    intendedUse: "验证跨项目导入、GeometryRevision、同源制图和代理包回导。",
    recordedAt: null, relatedEntityRefs: [geometrySpec.id], dataStatus: "available" as const,
  }));
  const parseRecords = assets.map((asset, index) => ({
    id: deterministicUuid(`parse:${sourceSeed}:${asset.fileName}`), projectId, assetId: asset.id,
    evidenceId: evidences[index]!.id, parser: "demo-package-converter", parserVersion: "1.0.0",
    status: "metadataOnly" as const, extractedText: null,
    warnings: ["团队 demo 来源；参数化包络不等于原始网格曲面或专业构造。"], createdAt: input.createdAt,
  }));
  const snapshot = ProjectSnapshotSchema.parse({
    schemaVersion: "3.0",
    project: { id: projectId, name: input.projectName, status: "active", locationText: "团队演示坐标，不对应真实地点", createdAt: input.createdAt },
    buildings: [{ id: buildingId, projectId, name: input.buildingName, periodText: null, addressText: null, status: "uncertain" }],
    taskDefinitions: [taskDefinition], evidences, parseRecords, entities: [], relations: [], observations: [], measurements: [], facts: [], candidates: [],
    issues: [{
      id: deterministicUuid(`issue:${sourceSeed}`), projectId, issueType: "professionalUncertainty", subjectRefs: [geometrySpec.id],
      description: "旧 v3 网格已转换为参数化包络；曲面、节点接口、年代与类型均未形成专业事实。",
      sourceRef: manifestEvidenceId, status: "open", impactRefs: [geometrySpec.id], blocksProxyOutcome: false, blocksFormalEligibility: true,
      producer: { producerType: "demo", fixtureId: input.fixtureId }, createdAt: input.createdAt, resolvedAt: null,
    }],
    dependencyEdges: [], geometrySpecs: [geometrySpec], geometryRevisions: [], adoptedRecordRefs: [`demo:${input.fixtureId}`],
  });
  const revisionBase = {
    id: sourceRevisionId, projectId, parentId: null, snapshotHash: recordHash(snapshot),
    changedRefs: [projectId, buildingId, taskId, geometrySpec.id, ...assets.map((asset) => asset.id)], committedAt: input.createdAt,
  };
  const sourceRevision = ProjectRevisionSchema.parse({
    ...revisionBase, closureHash: recordHash({ parentId: null, snapshotHash: revisionBase.snapshotHash }), recordHash: recordHash(revisionBase),
  });
  const writeSet = [
    { kind: "record" as const, storeName: "projects", id: projectId, hash: recordHash(snapshot.project) },
    { kind: "record" as const, storeName: "revisions", id: sourceRevisionId, hash: sourceRevision.recordHash },
    ...assets.map((asset) => ({ kind: "asset" as const, storeName: "assets", id: asset.id, hash: asset.sha256 })),
  ];
  const eventBase = {
    id: deterministicUuid(`audit:${sourceSeed}`), projectId, commandId: deterministicUuid(`command:${sourceSeed}`), actorId,
    previousEventHash: null, writeSet, writeSetHash: recordHash(writeSet), outcome: "committed" as const, errorCode: null, occurredAt: input.createdAt,
  };
  const auditEvent = AuditEventSchema.parse({
    ...eventBase, eventHash: recordHash(eventBase), recordHash: recordHash({ ...eventBase, recordType: "AuditEvent" }),
  });
  const projectData = {
    format: "gujian-project-package", packageVersion: 1, sourceRevision, auditHeadHash: auditEvent.eventHash,
    snapshot, auditEvents: [auditEvent], modelRuns: [], ruleRuns: [], decisions: [], cadJobs: [], artifactRequirementMatrices: [], artifacts: [],
    checkRuns: [], deliveryEvaluations: [], deliveries: [],
    assets: assets.map(({ bytes: _bytes, evidenceType: _evidenceType, title: _title, ...asset }) => asset),
  };
  const projectBytes = strToU8(`${canonicalJson(projectData)}\n`);
  const auditBytes = strToU8(`${canonicalJson(auditEvent)}\n`);
  const files = [
    { path: "project.json", bytes: projectBytes, mimeType: "application/json" },
    { path: "audit/events.ndjson", bytes: auditBytes, mimeType: "application/x-ndjson" },
    ...assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, mimeType: asset.mimeType })),
  ];
  const packageManifest = {
    format: "gujian-project-package", packageVersion: 1, projectId, sourceRevisionId,
    files: files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), size: file.bytes.byteLength, mimeType: file.mimeType })),
  };
  const packageBytes = zipSync({
    "manifest.json": strToU8(`${canonicalJson(packageManifest)}\n`),
    ...Object.fromEntries(files.map((file) => [file.path, file.bytes])),
  }, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") });
  return {
    packageBytes, projectId, buildingId, geometrySpecId: geometrySpec.id, packageSha256: sha256Hex(packageBytes),
    sourceAssetSha256: assets.map((asset) => asset.sha256), objectCount: geometrySpec.objects.length,
    unknownCount: geometrySpec.unknowns.length, originalGeometrySignature: input.manifest.geometrySignature,
  };
}
