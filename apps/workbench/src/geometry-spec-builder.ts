import type { ProjectHead } from "@gujian/application";
import {
  ProjectDrivenGeometrySpecSchema,
  type FactEnvelope,
  type ProjectDrivenGeometrySpec,
  type ProjectGeometryObject,
} from "@gujian/domain";
import { recordHash } from "@gujian/infrastructure";

export const REQUIRED_GEOMETRY_FACTS = [
  "geometry.overallWidthMm",
  "geometry.overallDepthMm",
  "geometry.baseHeightMm",
  "geometry.wallHeightMm",
  "geometry.ridgeHeightMm",
] as const;

function numberFact(head: ProjectHead, field: string): FactEnvelope | null {
  const matches = head.snapshot.facts.filter((item) => item.field === field && item.reviewStatus === "confirmed" && item.dataStatus === "available");
  const fact = matches.at(-1) ?? null;
  return fact && typeof fact.value === "number" && Number.isFinite(fact.value) && fact.value > 0 ? fact : null;
}

export function geometryPrerequisites(head: ProjectHead): { ready: boolean; missing: string[]; facts: Map<string, FactEnvelope> } {
  const facts = new Map<string, FactEnvelope>();
  const missing: string[] = [];
  for (const field of REQUIRED_GEOMETRY_FACTS) {
    const fact = numberFact(head, field);
    if (fact) facts.set(field, fact);
    else missing.push(field);
  }
  const ridge = facts.get("geometry.ridgeHeightMm")?.value as number | undefined;
  const wall = facts.get("geometry.wallHeightMm")?.value as number | undefined;
  const base = facts.get("geometry.baseHeightMm")?.value as number | undefined;
  if (ridge !== undefined && wall !== undefined && base !== undefined && ridge <= wall + base) missing.push("geometry.ridgeHeightMm>base+wall");
  return { ready: missing.length === 0, missing, facts };
}

function priorIds(head: ProjectHead): Map<string, string> {
  const latest = head.snapshot.geometrySpecs.at(-1);
  return new Map(latest?.objects.map((item) => [item.stableKey, item.id]) ?? []);
}

export function buildProjectGeometrySpec(head: ProjectHead, ruleRunId: string): ProjectDrivenGeometrySpec {
  const prerequisite = geometryPrerequisites(head);
  if (!prerequisite.ready) throw new Error(`GEOMETRY_FACTS_MISSING:${prerequisite.missing.join(",")}`);
  const value = (field: string) => prerequisite.facts.get(field)!.value as number;
  const width = value("geometry.overallWidthMm");
  const depth = value("geometry.overallDepthMm");
  const baseHeight = value("geometry.baseHeightMm");
  const wallHeight = value("geometry.wallHeightMm");
  const ridgeHeight = value("geometry.ridgeHeightMm");
  const wallTop = baseHeight + wallHeight;
  const overhang = Math.max(400, Math.min(width, depth) * 0.08);
  const wallThickness = Math.max(160, Math.min(width, depth) * 0.025);
  const sourceFacts = [...prerequisite.facts.values()];
  const factRefs = sourceFacts.map((item) => item.id);
  const evidenceRefs = [...new Set(sourceFacts.flatMap((item) => item.evidenceRefs))];
  const previous = priorIds(head);
  const id = (stableKey: string) => previous.get(stableKey) ?? crypto.randomUUID();
  const producer = { producerType: "rule" as const, ruleRunId };
  const object = (stableKey: string, componentType: string, displayNameZh: string, materialCode: string, solid: ProjectGeometryObject["solid"]): ProjectGeometryObject => ({
    id: id(stableKey), stableKey, parentId: null, componentType, displayNameZh, materialCode, solid,
    parameters: [], producer, factRefs, evidenceRefs, unknownRefs: [],
  });
  const objects: ProjectGeometryObject[] = [
    object("base", "base", "台基层代理几何", "stone-proxy", { kind: "box", sizeX: String(width + 600), sizeY: String(depth + 600), sizeZ: String(baseHeight), centerMm: [0, 0, baseHeight / 2] }),
    object("floor", "floor", "室内地坪代理几何", "timber-proxy", { kind: "box", sizeX: String(width), sizeY: String(depth), sizeZ: "120", centerMm: [0, 0, baseHeight + 60] }),
    object("wall:south", "wall", "南墙代理几何", "wall-proxy", { kind: "box", sizeX: String(width), sizeY: String(wallThickness), sizeZ: String(wallHeight - 120), centerMm: [0, -depth / 2 + wallThickness / 2, baseHeight + 120 + (wallHeight - 120) / 2] }),
    object("wall:north", "wall", "北墙代理几何", "wall-proxy", { kind: "box", sizeX: String(width), sizeY: String(wallThickness), sizeZ: String(wallHeight - 120), centerMm: [0, depth / 2 - wallThickness / 2, baseHeight + 120 + (wallHeight - 120) / 2] }),
    object("wall:west", "wall", "西墙代理几何", "wall-proxy", { kind: "box", sizeX: String(wallThickness), sizeY: String(depth - wallThickness * 2), sizeZ: String(wallHeight - 120), centerMm: [-width / 2 + wallThickness / 2, 0, baseHeight + 120 + (wallHeight - 120) / 2] }),
    object("wall:east", "wall", "东墙代理几何", "wall-proxy", { kind: "box", sizeX: String(wallThickness), sizeY: String(depth - wallThickness * 2), sizeZ: String(wallHeight - 120), centerMm: [width / 2 - wallThickness / 2, 0, baseHeight + 120 + (wallHeight - 120) / 2] }),
    object("roof:west", "roof", "西坡屋面代理几何", "roof-proxy", { kind: "extrudedProfile", profileMm: [[-width / 2 - overhang, wallTop], [0, ridgeHeight], [0, ridgeHeight - 120], [-width / 2 - overhang, wallTop - 120]], depth: String(depth + overhang * 2), axis: "y", originMm: [0, (depth + overhang * 2) / 2, 0] }),
    object("roof:east", "roof", "东坡屋面代理几何", "roof-proxy", { kind: "extrudedProfile", profileMm: [[0, ridgeHeight], [width / 2 + overhang, wallTop], [width / 2 + overhang, wallTop - 120], [0, ridgeHeight - 120]], depth: String(depth + overhang * 2), axis: "y", originMm: [0, (depth + overhang * 2) / 2, 0] }),
  ];
  const byKey = new Map(objects.map((item) => [item.stableKey, item]));
  const interfaces = ["south", "north", "west", "east"].map((side) => ({
    id: crypto.randomUUID(), fromObjectId: byKey.get("floor")!.id, toObjectId: byKey.get(`wall:${side}`)!.id,
    interfaceType: "bearing" as const, fromSurface: "zMax", toSurface: "zMin", direction: [0, 0, 1] as [number, number, number],
    maximumGapMm: 0.01, maximumUnexpectedOverlapMm3: 0, minimumDeclaredOverlapMm3: null, factRefs, evidenceRefs,
  }));
  const unknowns = [{
    id: crypto.randomUUID(), subjectRef: byKey.get("roof:west")!.id, reasonCode: "PROXY_CONSTRUCTION_DETAIL_UNRESOLVED",
    description: "屋面构造层、连接节点和隐蔽构造没有完整证据，当前只表达有证据的外部控制尺寸。",
    requiredEvidence: ["构造详图", "隐蔽构造调查", "专业复核"], affectedRefs: [byKey.get("roof:west")!.id, byKey.get("roof:east")!.id],
    evidenceRefs, blocksProxyOutcome: false, blocksFormalEligibility: true,
  }];
  objects[objects.length - 2]!.unknownRefs = [unknowns[0]!.id];
  objects[objects.length - 1]!.unknownRefs = [unknowns[0]!.id];
  const spec: ProjectDrivenGeometrySpec = {
    schemaVersion: "2.0", id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: head.revisionId,
    buildingId: head.snapshot.buildings[0]!.id, inputHash: "0".repeat(64),
    coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 }, objects, interfaces, unknowns,
    createdAt: new Date().toISOString(),
  };
  return ProjectDrivenGeometrySpecSchema.parse({ ...spec, inputHash: recordHash({ ...spec, inputHash: "0".repeat(64) }) });
}
