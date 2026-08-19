import {
  AuditEventSchema,
  GeometryRevisionSchema,
  ProjectDrivenGeometrySpecSchema,
  ProjectRevisionSchema,
  ProjectSnapshotSchema,
  type ProjectDrivenGeometrySpec,
} from "@gujian/domain";
import { strToU8, zipSync } from "fflate";

import { parseSourceMeshBundle, solidBounds, translateEntity, type ApproximationTag, type SourceMesh } from "./demo-component-translation.js";
import { canonicalJson, recordHash, sha256Hex } from "./hash.js";

interface LegacyDimensionFact {
  readonly dimensionId?: string;
  readonly category: string;
  readonly value: number | string;
}

type LegacyUnknown = string | { readonly stableKey?: string; readonly reasonCode?: string; readonly displayNameZh?: string };

interface LegacyEntity {
  readonly entityId: string;
  readonly key: string;
  readonly componentType: string;
  readonly domainTerm?: { readonly displayNameZh?: string };
  readonly materialFact?: { readonly materialCode?: string };
  readonly dimensionFacts?: readonly LegacyDimensionFact[];
  readonly unknowns?: readonly LegacyUnknown[];
  readonly bounds: readonly [readonly [number, number, number], readonly [number, number, number]];
}

function unknownKey(item: LegacyUnknown): string {
  return typeof item === "string" ? item : item.stableKey ?? item.reasonCode ?? "unknown";
}

function unknownLabel(item: LegacyUnknown): string {
  return typeof item === "string" ? item : item.displayNameZh ?? unknownKey(item);
}

interface LegacyInterface {
  readonly interfaceId: string;
  readonly role: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly interfaceKind?: string;
  readonly contactMode?: string;
  readonly expectedGapMm?: number;
  readonly maximumGapMm?: number;
  readonly maximumUnexpectedOverlapMm3?: number;
}

export interface LegacyDemoGeometryManifest {
  readonly geometryRevisionId: string;
  readonly geometrySignature: string;
  readonly entities: readonly LegacyEntity[];
  readonly interfaces?: readonly LegacyInterface[];
}

export interface DemoSourceFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly evidenceType: "document" | "other";
  readonly title: string;
}

// 已生成的几何成果。传入后包内带 GeometryRevision，导入即可直接看模型；
// 不传时行为与原来一致，只带 GeometrySpec，需要在工作台里现场生成。
export interface DemoGeometryAsset {
  readonly kind: "ifc" | "glb" | "brepBundle" | "manifest" | "sourceMap" | "report" | "preview";
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface DemoGeometryOutput {
  readonly assets: readonly DemoGeometryAsset[];
  readonly inputHash: string;
  readonly entityClosureHash: string;
  readonly interfaceClosureHash: string;
  readonly geometrySignature: string;
  readonly blockers: readonly string[];
}

export interface DemoConversionInput {
  readonly manifest: LegacyDemoGeometryManifest;
  readonly sourceFiles: readonly DemoSourceFile[];
  readonly createdAt: string;
  readonly projectName: string;
  readonly buildingName: string;
  readonly fixtureId: string;
  readonly geometry?: DemoGeometryOutput;
}

export interface DemoConversionResult {
  readonly packageBytes: Uint8Array;
  readonly projectId: string;
  readonly buildingId: string;
  readonly geometrySpecId: string;
  readonly packageSha256: string;
  readonly sourceAssetSha256: readonly string[];
  readonly objectCount: number;
  readonly entityCount: number;
  readonly partCount: number;
  readonly interfaceCount: number;
  readonly unknownCount: number;
  readonly solidKindCounts: Readonly<Record<string, number>>;
  readonly approximationCounts: Readonly<Record<string, number>>;
  readonly originalGeometrySignature: string;
  readonly geometryRevisionId: string | null;
  readonly geometryAssetCount: number;
  // 翻译得到的 GeometrySpec。构建演示包时要把它交给几何管线生成成果，
  // 调用方不必再从包里解回来。
  readonly geometrySpec: ProjectDrivenGeometrySpec;
}

// 只携带极值面语义可以正确表达的完整竖向承重链接口；
// 长构件多点接触（椽对檩等）和瓦件接口不携带，改记结构化未知项。
const STRUCTURAL_INTERFACE_ROLES = new Set([
  "foundation-ground", "foundation-course-stack", "foundation-bearing-ground",
  "terrace-foundation", "terrace-course-stack", "base-terrace",
  "step-course-stack", "ground-step", "step-terrace",
  "column-base", "column-eave-beam", "column-tie-beam",
  "eave-beam-seat", "seat-arm-x", "seat-arm-y", "arm-bearing-block", "bearing-block-purlin",
  "wall-terrace", "door-frame-terrace", "tie-beam-interior-post", "interior-post-purlin",
]);

const TILE_INTERFACE_ROLES = new Set([
  "cover-tile-pan-tile", "tile-longitudinal-lap", "pan-tile-roof-board", "ridge-roof-finish",
]);

const APPROXIMATED_TYPES = new Set(["column", "columnBase", "panTile", "coverTile", "ridgeTile"]);

const APPROXIMATION_REASONS: Record<ApproximationTag, { code: string; description: string } | null> = {
  exactPrism: null,
  exactBox: null,
  cylinderAveragedTaper: {
    code: "DEMO_TRANSLATION_TAPER_AVERAGED",
    description: "收分构件按上下径平均转换为等径圆柱，收分与曲线轮廓未保留。",
  },
  cylinderEnvelope: {
    code: "DEMO_TRANSLATION_CYLINDER_ENVELOPE",
    description: "旋转轮廓构件按外接圆柱转换，原始轮廓曲线未保留。",
  },
  stripCrossSectionFlattened: {
    code: "DEMO_TRANSLATION_TILE_SECTION_FLATTENED",
    description: "瓦件按中线纵向剖面条带挤出转换，纵向曲线与压茬保留，横向抛物断面被展平。",
  },
  decomposedParts: {
    code: "DEMO_TRANSLATION_DECOMPOSED_PARTS",
    description: "合并多块构件按网格连通分量拆分为多个实体分件，分件通过 parentId 归组，构造关系保留。",
  },
  boundsEnvelopeFallback: {
    code: "DEMO_TRANSLATION_BOUNDS_FALLBACK",
    description: "该构件网格无法识别为棱柱、圆柱或剖面条带，退化为轴对齐包围盒。",
  },
};

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
  if (/(?:count|rows?|columns?|courses?|segments?|bays?|facets?)/i.test(category)) return "count";
  if (/(?:angle|slope|pitchDeg)/i.test(category)) return "angle";
  if (/(?:ratio|factor)/i.test(category)) return "ratio";
  return "length";
}

function readableName(entity: LegacyEntity): string {
  // 源数据的名称带有内部标注，界面只显示构件本身的名称
  const value = entity.domainTerm?.displayNameZh?.trim().replace(/（[^）]*演示[^）]*）/g, "").trim();
  if (value && /[㐀-鿿]/u.test(value)) return value;
  const names: Record<string, string> = {
    column: "柱",
    columnBase: "柱下承托构件",
    bracketSeat: "承托座",
    bracketArm: "承托臂",
    bearingBlock: "檩下承块",
    panTile: "凹面瓦件",
    coverTile: "盖瓦件",
    ridgeTile: "屋脊构件",
    roofBoard: "屋面板",
    rafter: "椽",
    flyRafter: "檐端续接椽",
    wall: "墙体",
  };
  return names[entity.componentType] ?? `${entity.componentType}`;
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

function sourceMeshes(input: DemoConversionInput): Map<string, SourceMesh> {
  const bundle = input.sourceFiles.find((file) => file.fileName.endsWith("source-meshes.ndjson.gz"));
  return bundle ? parseSourceMeshBundle(bundle.bytes) : new Map();
}

type EntityBounds = readonly [readonly [number, number, number], readonly [number, number, number]];

// 接触轴 = 两构件包围盒区间重叠量最小的轴（相邻接触面所在方向）。
// 质心差主轴在大小悬殊的构件对上会选错（如角柱础对整块台基）。
function contactAxis(from: EntityBounds, to: EntityBounds): { axis: "x" | "y" | "z"; index: 0 | 1 | 2; sign: 1 | -1 } {
  let index: 0 | 1 | 2 = 2;
  let smallest = Infinity;
  for (const candidate of [0, 1, 2] as const) {
    const overlap = Math.min(from[1][candidate], to[1][candidate]) - Math.max(from[0][candidate], to[0][candidate]);
    if (overlap < smallest) { smallest = overlap; index = candidate; }
  }
  const fromCenter = (from[0][index] + from[1][index]) / 2;
  const toCenter = (to[0][index] + to[1][index]) / 2;
  return { axis: (["x", "y", "z"] as const)[index], index, sign: toCenter >= fromCenter ? 1 : -1 };
}

interface TranslationOutput {
  readonly objects: ProjectDrivenGeometrySpec["objects"];
  readonly interfaces: ProjectDrivenGeometrySpec["interfaces"];
  readonly unknowns: ProjectDrivenGeometrySpec["unknowns"];
  readonly partCount: number;
  readonly interfaceCount: number;
  readonly solidKindCounts: Record<string, number>;
  readonly approximationCounts: Record<string, number>;
}

function translateManifest(input: DemoConversionInput, evidenceId: string, fixtureId: string): TranslationOutput {
  if (!input.manifest.entities.length) throw new Error("DEMO_MANIFEST_EMPTY");
  const meshes = sourceMeshes(input);
  const unknowns: ProjectDrivenGeometrySpec["unknowns"][number][] = [];
  const objects: ProjectDrivenGeometrySpec["objects"][number][] = [];
  const familyUnknowns = new Map<string, { id: string; code: string; description: string; affected: string[] }>();
  const solidKindCounts: Record<string, number> = {};
  const approximationCounts: Record<string, number> = {};
  const objectGroups = new Map<string, { id: string; bounds: EntityBounds }[]>();
  let partCount = 0;

  for (const entity of input.manifest.entities) {
    const facts = new Map<string, number>();
    for (const fact of entity.dimensionFacts ?? []) {
      const numeric = Number(fact.value);
      if (!facts.has(fact.category) && Number.isFinite(numeric)) facts.set(fact.category, numeric);
    }
    const translation = translateEntity(entity.componentType, facts, entity.bounds, meshes.get(entity.entityId));
    const entityUnknownIds = (entity.unknowns ?? []).map((item) => deterministicUuid(`unknown:${entity.entityId}:${unknownKey(item)}`));
    for (const [index, item] of (entity.unknowns ?? []).entries()) {
      unknowns.push({
        id: entityUnknownIds[index]!, subjectRef: entity.entityId,
        reasonCode: `LEGACY_DEMO_${unknownKey(item).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`.slice(0, 120),
        description: `待确认项：${unknownLabel(item)}`,
        requiredEvidence: ["项目自身证据或专业人员复核记录"], affectedRefs: [entity.entityId], evidenceRefs: [evidenceId],
        blocksProxyOutcome: false, blocksFormalEligibility: true,
      });
    }
    const translationUnknownIds: string[] = [];
    for (const tag of translation.approximations) {
      const reason = APPROXIMATION_REASONS[tag];
      approximationCounts[tag] = (approximationCounts[tag] ?? 0) + 1;
      if (!reason) continue;
      const familyKey = `${tag}:${entity.componentType}`;
      let family = familyUnknowns.get(familyKey);
      if (!family) {
        family = {
          id: deterministicUuid(`unknown:translation:${familyKey}`),
          code: reason.code,
          description: `${entity.componentType}：${reason.description}`,
          affected: [],
        };
        familyUnknowns.set(familyKey, family);
      }
      family.affected.push(entity.entityId);
      translationUnknownIds.push(family.id);
    }
    const parameters = (entity.dimensionFacts ?? []).map((fact) => {
      const kind = parameterType(fact.category);
      const base = {
        id: deterministicUuid(`parameter:${entity.entityId}:${fact.dimensionId ?? fact.category}`), name: fact.category,
        basis: "demo" as const, factRefs: [`demo:v3-dimension:${fact.dimensionId ?? fact.category}`], evidenceRefs: [evidenceId],
      };
      if (kind === "count") return { ...base, valueType: "count" as const, value: Math.max(0, Math.round(Number(fact.value))), unit: "1" as const };
      if (kind === "angle") return { ...base, valueType: "angle" as const, exactValue: exact(fact.value), unit: "deg" as const };
      if (kind === "ratio") return { ...base, valueType: "ratio" as const, exactValue: exact(fact.value), unit: "1" as const };
      return { ...base, valueType: "length" as const, exactValue: exact(fact.value), unit: "mm" as const };
    });
    const shared = {
      componentType: entity.componentType, displayNameZh: readableName(entity),
      materialCode: entity.materialFact?.materialCode ?? "demo-material-unknown",
      producer: { producerType: "demo" as const, fixtureId },
      factRefs: [`demo:v3-entity:${entity.entityId}`], evidenceRefs: [evidenceId],
    };
    objects.push({
      ...shared, id: entity.entityId, stableKey: entity.key, parentId: null,
      solid: translation.primary, parameters,
      unknownRefs: [...new Set([...translationUnknownIds, ...entityUnknownIds])],
    });
    const group: { id: string; bounds: EntityBounds }[] = [{ id: entity.entityId, bounds: solidBounds(translation.primary) }];
    solidKindCounts[translation.primary.kind] = (solidKindCounts[translation.primary.kind] ?? 0) + 1;
    translation.parts.forEach((part, index) => {
      partCount += 1;
      solidKindCounts[part.kind] = (solidKindCounts[part.kind] ?? 0) + 1;
      const partId = deterministicUuid(`part:${entity.entityId}:${index + 1}`);
      objects.push({
        ...shared, id: partId,
        stableKey: `${entity.key}#p${index + 1}`, parentId: entity.entityId,
        solid: part, parameters: [], unknownRefs: [],
      });
      group.push({ id: partId, bounds: solidBounds(part) });
    });
    objectGroups.set(entity.entityId, group);
  }

  for (const family of familyUnknowns.values()) {
    unknowns.push({
      id: family.id, subjectRef: family.affected[0]!,
      reasonCode: family.code, description: family.description,
      requiredEvidence: ["经独立复核的构件级曲面与构造重建记录"],
      affectedRefs: family.affected.slice(0, 1000), evidenceRefs: [evidenceId],
      blocksProxyOutcome: false, blocksFormalEligibility: true,
    });
  }

  const objectIds = new Set(objects.map((item) => item.id));
  const boundsById = new Map(input.manifest.entities.map((entity) => [entity.entityId, entity.bounds]));
  // 分解出分件的实体：接口端点取该实体分件组中与对方最近的对象
  const separation = (left: EntityBounds, right: EntityBounds): number => {
    let total = 0;
    for (const axis of [0, 1, 2] as const) {
      const gap = Math.max(left[0][axis] - right[1][axis], right[0][axis] - left[1][axis], 0);
      total += gap * gap;
    }
    return total;
  };
  const nearestObject = (entityId: string, partner: EntityBounds): { id: string; bounds: EntityBounds } => {
    const group = objectGroups.get(entityId)!;
    let best = group[0]!;
    for (const candidate of group) if (separation(candidate.bounds, partner) < separation(best.bounds, partner)) best = candidate;
    return best;
  };
  const typeByEntity = new Map(input.manifest.entities.map((entity) => [entity.entityId, entity.componentType]));
  const interfaces: ProjectDrivenGeometrySpec["interfaces"][number][] = [];
  const droppedByGroup = new Map<string, number>();
  for (const item of input.manifest.interfaces ?? []) {
    if (!objectIds.has(item.fromEntityId) || !objectIds.has(item.toEntityId) || item.fromEntityId === item.toEntityId) continue;
    if (!STRUCTURAL_INTERFACE_ROLES.has(item.role)) {
      const group = TILE_INTERFACE_ROLES.has(item.role) ? "tile" : "localContact";
      droppedByGroup.set(group, (droppedByGroup.get(group) ?? 0) + 1);
      continue;
    }
    const fromObject = nearestObject(item.fromEntityId, boundsById.get(item.toEntityId)!);
    const toObject = nearestObject(item.toEntityId, fromObject.bounds);
    const { axis, index, sign } = contactAxis(fromObject.bounds, toObject.bounds);
    const direction: [number, number, number] = [0, 0, 0];
    direction[index] = sign;
    const approximated = APPROXIMATED_TYPES.has(typeByEntity.get(item.fromEntityId)!) || APPROXIMATED_TYPES.has(typeByEntity.get(item.toEntityId)!);
    const gapAllowance = approximated ? 90 : 80;
    interfaces.push({
      id: deterministicUuid(`interface:${item.interfaceId}`),
      fromObjectId: fromObject.id, toObjectId: toObject.id,
      interfaceType: item.interfaceKind === "bearing" ? "bearing" : item.interfaceKind === "containment" ? "containment" : "contact",
      fromSurface: sign > 0 ? `${axis}Max` : `${axis}Min`,
      toSurface: sign > 0 ? `${axis}Min` : `${axis}Max`,
      direction,
      maximumGapMm: Math.min(100, gapAllowance + (item.expectedGapMm ?? 0)),
      maximumUnexpectedOverlapMm3: (item.maximumUnexpectedOverlapMm3 ?? 0) + (approximated ? 5e7 : 1e6),
      minimumDeclaredOverlapMm3: null,
      factRefs: [`demo:v3-interface:${item.interfaceId}`, `demo:v3-interface-role:${item.role}`],
      evidenceRefs: [evidenceId],
    });
  }
  if (droppedByGroup.size) {
    const tileCount = droppedByGroup.get("tile") ?? 0;
    const localCount = droppedByGroup.get("localContact") ?? 0;
    unknowns.push({
      id: deterministicUuid("unknown:interfaces:not-carried"),
      subjectRef: "demo:v3-interfaces",
      reasonCode: "DEMO_INTERFACES_NOT_CARRIED",
      description: `原 v3 接口共 ${(input.manifest.interfaces ?? []).length} 项，本次携带完整竖向承重链 ${interfaces.length} 项。未携带：瓦件接口 ${tileCount} 项（横向断面展平后几何见证失效）；长构件局部接触接口 ${localCount} 项（当前接口检查语义仅支持构件极值面，多点接触表达留待后续版本）。原始接口关系保留在 v3 manifest 证据资产中。`,
      requiredEvidence: ["支持局部接触面语义的接口检查实现", "瓦件曲面精确重建记录"],
      affectedRefs: ["demo:v3-interface-group:tile", "demo:v3-interface-group:local-contact"],
      evidenceRefs: [evidenceId],
      blocksProxyOutcome: false, blocksFormalEligibility: true,
    });
  }
  return {
    objects, interfaces, unknowns, partCount,
    interfaceCount: interfaces.length, solidKindCounts, approximationCounts,
  };
}

function projectGeometrySpec(
  input: DemoConversionInput, projectId: string, buildingId: string, revisionId: string, evidenceId: string,
): { spec: ProjectDrivenGeometrySpec; translation: TranslationOutput } {
  const translation = translateManifest(input, evidenceId, input.fixtureId);
  const specBase: ProjectDrivenGeometrySpec = {
    schemaVersion: "2.0", id: deterministicUuid(`geometry-spec:${input.manifest.geometrySignature}`),
    projectId, projectRevisionId: revisionId, buildingId, inputHash: "0".repeat(64),
    coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects: translation.objects, interfaces: translation.interfaces, unknowns: translation.unknowns, createdAt: input.createdAt,
  };
  return { spec: ProjectDrivenGeometrySpecSchema.parse({ ...specBase, inputHash: recordHash(specBase) }), translation };
}

export function buildDemoProjectPackage(input: DemoConversionInput): DemoConversionResult {
  const sourceSeed = `${input.fixtureId}:${input.manifest.geometrySignature}`;
  const projectId = deterministicUuid(`project:${sourceSeed}`);
  const buildingId = deterministicUuid(`building:${sourceSeed}`);
  const actorId = deterministicUuid(`actor:${sourceSeed}`);
  const sourceRevisionId = deterministicUuid(`revision:${sourceSeed}`);
  // 必须与 evidences 表中 manifest 文件的证据 ID 一致，否则图纸视图的证据引用会失配
  const manifestFileName = input.sourceFiles.find((file) => file.fileName.endsWith("geometry-manifest.json"))?.fileName
    ?? input.sourceFiles[0]?.fileName ?? "geometry-manifest.json";
  const manifestEvidenceId = deterministicUuid(`evidence:${sourceSeed}:${manifestFileName}`);
  const { spec: geometrySpec, translation } = projectGeometrySpec(input, projectId, buildingId, sourceRevisionId, manifestEvidenceId);
  const representative = representativeKeys(input.manifest.entities);
  const byType = new Map<string, string[]>();
  for (const entity of input.manifest.entities) byType.set(entity.componentType, [...(byType.get(entity.componentType) ?? []), entity.key]);
  const supportKeys = ["column", "columnBase", "bracketSeat", "bracketArm", "bearingBlock", "purlin", "eaveBeam"]
    .flatMap((type) => (byType.get(type) ?? []).slice(0, 4)).slice(0, 30);
  const taskId = deterministicUuid(`task:${sourceSeed}`);
  const taskDefinition = {
    id: taskId, name: "古建局部构造样板制作", scope: ["逐构件核对构造关系", "按成果目录生成成组图纸"],
    regulationRefs: ["成果须注明来源；未经责任人员签发不得作为正式测绘成果使用"], deliverables: ["三维模型（IFC 与 GLB）", "成组图纸（DXF、SVG、PDF）", "检查报告"],
    responsibilities: [{ role: "projectLead" as const, actorId }], automationPolicyRef: "internal:demo-proxy-automation-v1",
    artifactRequirements: {
      titleZh: "古建局部构造样板成组图纸", revisionLabel: "D1",
      geometryTargetRoles: ["column", "roofBoard", "panTile"].filter((type) => byType.has(type)),
      sheets: [
        { key: "sheet-a2", drawingNumber: "D-01", displayLabelZh: "总体与立面", pageMm: [594, 420] },
        { key: "sheet-a3", drawingNumber: "D-02", displayLabelZh: "剖面与承托组合", pageMm: [420, 297] },
      ],
      views: [
        { key: "floor", displayLabelZh: "底层平面图", drawingRef: "D-01-1", kind: "floorPlan", scaleDenominator: 50, sheetKey: "sheet-a2", viewportRectMm: [20, 200, 260, 175], direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "roof", displayLabelZh: "屋顶平面图", drawingRef: "D-01-2", kind: "roofPlan", scaleDenominator: 50, sheetKey: "sheet-a2", viewportRectMm: [314, 200, 260, 175], direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "south", displayLabelZh: "南立面图", drawingRef: "D-01-3", kind: "elevation", scaleDenominator: 50, sheetKey: "sheet-a2", viewportRectMm: [20, 20, 260, 175], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "axon", displayLabelZh: "轴测图", drawingRef: "D-01-4", kind: "axonometric", scaleDenominator: 100, sheetKey: "sheet-a2", viewportRectMm: [314, 20, 260, 175], direction: [0.5773502691896258, 0.5773502691896258, -0.5773502691896258], right: [0.7071067811865476, -0.7071067811865476, 0], up: [0.4082482904638631, 0.4082482904638631, 0.8164965809277261], targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "transverse", displayLabelZh: "横剖面图", drawingRef: "D-02-1", kind: "transverseSection", scaleDenominator: 75, sheetKey: "sheet-a3", viewportRectMm: [15, 130, 185, 125], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], sectionPlane: { normal: [1, 0, 0], offsetMm: 0 }, targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "longitudinal", displayLabelZh: "纵剖面图", drawingRef: "D-02-2", kind: "longitudinalSection", scaleDenominator: 75, sheetKey: "sheet-a3", viewportRectMm: [220, 130, 185, 125], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], sectionPlane: { normal: [0, 1, 0], offsetMm: 0 }, targetStableKeys: representative, sourceEvidenceRefs: [] },
        { key: "support-detail", displayLabelZh: "檐下承托组合详图", drawingRef: "D-02-3", kind: "detail", scaleDenominator: 20, sheetKey: "sheet-a3", viewportRectMm: [15, 20, 390, 105], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], sectionPlane: { normal: [1, 0, 0], offsetMm: 1800 }, cropBoundsMm: [-3500, 3500, 3600, 5600], targetStableKeys: supportKeys.length ? supportKeys : representative.slice(0, 20), sourceEvidenceRefs: [manifestEvidenceId] },
      ],
    }, confirmedAt: input.createdAt,
  };

  const sourceDeclaration = strToU8(`${canonicalJson({
    schemaVersion: "third-project-demo-source-1", producerType: "demo", formalEligibility: false,
    originalGeometryRevisionId: input.manifest.geometryRevisionId,
    originalGeometrySignature: input.manifest.geometrySignature,
    conversionMode: "component-parametric-translation",
    conversionSummary: {
      entityCount: input.manifest.entities.length,
      objectCount: translation.objects.length,
      partCount: translation.partCount,
      carriedInterfaceCount: translation.interfaceCount,
      originalInterfaceCount: (input.manifest.interfaces ?? []).length,
      solidKindCounts: translation.solidKindCounts,
      approximationCounts: translation.approximationCounts,
    },
    limitations: ["非实测", "非真实中国古建", "近似构件与未携带接口见结构化未知项", "不可用于正式交付或施工"],
    sourceFiles: input.sourceFiles.map((file) => ({ fileName: file.fileName, sha256: sha256Hex(file.bytes), byteLength: file.bytes.byteLength })),
  })}\n`);
  const sources = [...input.sourceFiles, { fileName: "demo-source-declaration.json", mimeType: "application/json", bytes: sourceDeclaration, evidenceType: "document" as const, title: "构件数据来源与转换说明" }];
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
    evidenceId: evidences[index]!.id, parser: "demo-package-converter", parserVersion: "2.0.0",
    status: "metadataOnly" as const, extractedText: null,
    warnings: ["团队 demo 来源；构件级参数化转换的近似项与未携带接口见 GeometrySpec 结构化未知项。"], createdAt: input.createdAt,
  }));
  // 几何成果资产与版本。资产走 artifacts/geometry 路径与证据分开，
  // 导入后由仓储按 assetId 取内容，三维视图直接读 glb。
  const geometryRevisionId = deterministicUuid(`geometry-revision:${sourceSeed}`);
  const geometryAssets = (input.geometry?.assets ?? []).map((asset) => {
    const id = deterministicUuid(`geometry-asset:${sourceSeed}:${asset.kind}`);
    return {
      id, projectId, fileName: asset.fileName, mimeType: asset.mimeType, byteLength: asset.bytes.byteLength,
      sha256: sha256Hex(asset.bytes), contentStatus: "available" as const, createdAt: input.createdAt,
      path: `artifacts/geometry/${id}/${asset.fileName.replace(/[^\p{L}\p{N}._-]+/gu, "_")}`,
      bytes: asset.bytes, kind: asset.kind,
    };
  });
  const geometryRevisions = input.geometry
    ? [GeometryRevisionSchema.parse({
      id: geometryRevisionId, projectId, projectRevisionId: sourceRevisionId, geometrySpecId: geometrySpec.id,
      inputHash: input.geometry.inputHash,
      entityClosureHash: input.geometry.entityClosureHash,
      interfaceClosureHash: input.geometry.interfaceClosureHash,
      geometrySignature: input.geometry.geometrySignature,
      assets: geometryAssets.map((asset) => ({
        assetId: asset.id, kind: asset.kind, sha256: asset.sha256,
        mimeType: asset.mimeType, byteLength: asset.byteLength,
      })),
      status: "generated-not-qualified", l1Eligible: false, formalEligibility: false,
      blockers: [...input.geometry.blockers],
      createdAt: input.createdAt,
    })]
    : [];

  const snapshot = ProjectSnapshotSchema.parse({
    schemaVersion: "3.0",
    project: { id: projectId, name: input.projectName, status: "active", locationText: null, createdAt: input.createdAt },
    buildings: [{ id: buildingId, projectId, name: input.buildingName, periodText: null, addressText: null, status: "uncertain" }],
    taskDefinitions: [taskDefinition], evidences, parseRecords, entities: [], relations: [], observations: [], measurements: [], facts: [], candidates: [],
    issues: [{
      id: deterministicUuid(`issue:${sourceSeed}`), projectId, issueType: "professionalUncertainty", subjectRefs: [geometrySpec.id],
      description: "三维数据已按构件拆分。部分构件为近似形状，构件之间的连接、年代和类型尚未确认，需要专业人员逐项核对。",
      sourceRef: manifestEvidenceId, status: "open", impactRefs: [geometrySpec.id], blocksProxyOutcome: false, blocksFormalEligibility: true,
      producer: { producerType: "demo", fixtureId: input.fixtureId }, createdAt: input.createdAt, resolvedAt: null,
    }],
    dependencyEdges: [], geometrySpecs: [geometrySpec], geometryRevisions, adoptedRecordRefs: [`demo:${input.fixtureId}`],
  });
  const revisionBase = {
    id: sourceRevisionId, projectId, parentId: null, snapshotHash: recordHash(snapshot),
    changedRefs: [projectId, buildingId, taskId, geometrySpec.id, ...assets.map((asset) => asset.id), ...geometryAssets.map((asset) => asset.id)], committedAt: input.createdAt,
  };
  const sourceRevision = ProjectRevisionSchema.parse({
    ...revisionBase, closureHash: recordHash({ parentId: null, snapshotHash: revisionBase.snapshotHash }), recordHash: recordHash(revisionBase),
  });
  const writeSet = [
    { kind: "record" as const, storeName: "projects", id: projectId, hash: recordHash(snapshot.project) },
    { kind: "record" as const, storeName: "revisions", id: sourceRevisionId, hash: sourceRevision.recordHash },
    ...assets.map((asset) => ({ kind: "asset" as const, storeName: "assets", id: asset.id, hash: asset.sha256 })),
    ...geometryAssets.map((asset) => ({ kind: "asset" as const, storeName: "assets", id: asset.id, hash: asset.sha256 })),
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
    assets: [
      ...assets.map(({ bytes: _bytes, evidenceType: _evidenceType, title: _title, ...asset }) => asset),
      ...geometryAssets.map(({ bytes: _bytes, kind: _kind, ...asset }) => asset),
    ],
  };
  const projectBytes = strToU8(`${canonicalJson(projectData)}\n`);
  const auditBytes = strToU8(`${canonicalJson(auditEvent)}\n`);
  const files = [
    { path: "project.json", bytes: projectBytes, mimeType: "application/json" },
    { path: "audit/events.ndjson", bytes: auditBytes, mimeType: "application/x-ndjson" },
    ...assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, mimeType: asset.mimeType })),
    ...geometryAssets.map((asset) => ({ path: asset.path, bytes: asset.bytes, mimeType: asset.mimeType })),
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
    sourceAssetSha256: assets.map((asset) => asset.sha256),
    objectCount: geometrySpec.objects.length,
    entityCount: input.manifest.entities.length,
    partCount: translation.partCount,
    interfaceCount: translation.interfaceCount,
    unknownCount: geometrySpec.unknowns.length,
    solidKindCounts: translation.solidKindCounts,
    approximationCounts: translation.approximationCounts,
    originalGeometrySignature: input.manifest.geometrySignature,
    geometryRevisionId: input.geometry ? geometryRevisionId : null,
    geometryAssetCount: geometryAssets.length,
    geometrySpec,
  };
}
