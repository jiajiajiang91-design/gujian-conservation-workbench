import { gunzipSync, strFromU8 } from "fflate";

// 把 v3 团队 demo 的源网格逐构件翻译为当前 GeometrySpec 支持的参数化实体。
// 翻译优先级：整体棱柱（截面轮廓精确还原）→ 全轴长方体 → 圆柱族 → 连通分量分解 → 纵向剖面条带 → 包围盒兜底。
// 每一级的近似类型都返回给调用方，由调用方生成结构化未知项。

export interface SourceMesh {
  readonly vertices: readonly (readonly [number, number, number])[];
  readonly faces: readonly (readonly [number, number, number])[];
}

export type TranslatedSolid =
  | { readonly kind: "box"; readonly sizeX: string; readonly sizeY: string; readonly sizeZ: string; readonly centerMm: [number, number, number] }
  | { readonly kind: "cylinder"; readonly radius: string; readonly height: string; readonly axis: "x" | "y" | "z"; readonly centerMm: [number, number, number] }
  | { readonly kind: "extrudedProfile"; readonly profileMm: [number, number][]; readonly depth: string; readonly axis: "x" | "y" | "z"; readonly originMm: [number, number, number] };

export type ApproximationTag =
  | "exactPrism"
  | "exactBox"
  | "cylinderAveragedTaper"
  | "cylinderEnvelope"
  | "stripCrossSectionFlattened"
  | "decomposedParts"
  | "boundsEnvelopeFallback";

export interface EntityTranslation {
  readonly primary: TranslatedSolid;
  readonly parts: readonly TranslatedSolid[];
  readonly approximations: readonly ApproximationTag[];
}

const AXES: readonly ("x" | "y" | "z")[] = ["x", "y", "z"];

export function solidBounds(solid: TranslatedSolid): [[number, number, number], [number, number, number]] {
  if (solid.kind === "box") {
    const half = [Number(solid.sizeX) / 2, Number(solid.sizeY) / 2, Number(solid.sizeZ) / 2] as const;
    return [
      [solid.centerMm[0] - half[0], solid.centerMm[1] - half[1], solid.centerMm[2] - half[2]],
      [solid.centerMm[0] + half[0], solid.centerMm[1] + half[1], solid.centerMm[2] + half[2]],
    ];
  }
  if (solid.kind === "cylinder") {
    const radius = Number(solid.radius);
    const halfHeight = Number(solid.height) / 2;
    const half: [number, number, number] = solid.axis === "x" ? [halfHeight, radius, radius] : solid.axis === "y" ? [radius, halfHeight, radius] : [radius, radius, halfHeight];
    return [
      [solid.centerMm[0] - half[0], solid.centerMm[1] - half[1], solid.centerMm[2] - half[2]],
      [solid.centerMm[0] + half[0], solid.centerMm[1] + half[1], solid.centerMm[2] + half[2]],
    ];
  }
  const runs = solid.profileMm.map(([run]) => run);
  const heights = solid.profileMm.map(([, height]) => height);
  const planeMin: [number, number] = [Math.min(...runs), Math.min(...heights)];
  const planeMax: [number, number] = [Math.max(...runs), Math.max(...heights)];
  const depth = Number(solid.depth);
  const start = solid.originMm[{ x: 0, y: 1, z: 2 }[solid.axis]]!;
  if (solid.axis === "x") return [[start, planeMin[0], planeMin[1]], [start + depth, planeMax[0], planeMax[1]]];
  if (solid.axis === "y") return [[planeMin[0], start, planeMin[1]], [planeMax[0], start + depth, planeMax[1]]];
  return [[planeMin[0], planeMin[1], start], [planeMax[0], planeMax[1], start + depth]];
}
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const CLUSTER_TOLERANCE_MM = 1e-4;
const MAX_PROFILE_POINTS = 1_900;

export function parseSourceMeshBundle(bytes: Uint8Array): Map<string, SourceMesh> {
  const text = strFromU8(gunzipSync(bytes));
  const result = new Map<string, SourceMesh>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { entityId?: string; vertices?: number[][]; faces?: number[][] };
    if (!record.entityId || !Array.isArray(record.vertices) || !Array.isArray(record.faces)) continue;
    result.set(record.entityId, {
      vertices: record.vertices as unknown as SourceMesh["vertices"],
      faces: record.faces as unknown as SourceMesh["faces"],
    });
  }
  return result;
}

function exact(value: number): string {
  if (!Number.isFinite(value)) throw new Error("DEMO_TRANSLATION_VALUE_NOT_FINITE");
  const rounded = Math.round(value * 1e6) / 1e6;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function meshBounds(mesh: SourceMesh): [[number, number, number], [number, number, number]] {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const vertex of mesh.vertices) for (let axis = 0; axis < 3; axis += 1) {
    if (vertex[axis]! < minimum[axis]!) minimum[axis] = vertex[axis]!;
    if (vertex[axis]! > maximum[axis]!) maximum[axis] = vertex[axis]!;
  }
  return [minimum, maximum];
}

function boxFromBounds(bounds: readonly [readonly [number, number, number], readonly [number, number, number]]): TranslatedSolid {
  const [minimum, maximum] = bounds;
  return {
    kind: "box",
    sizeX: exact(Math.max(1e-3, maximum[0] - minimum[0])),
    sizeY: exact(Math.max(1e-3, maximum[1] - minimum[1])),
    sizeZ: exact(Math.max(1e-3, maximum[2] - minimum[2])),
    centerMm: [round6((maximum[0] + minimum[0]) / 2), round6((maximum[1] + minimum[1]) / 2), round6((maximum[2] + minimum[2]) / 2)],
  };
}

function axisClusters(mesh: SourceMesh, axis: "x" | "y" | "z"): number[] {
  const index = AXIS_INDEX[axis];
  const values = [...new Set(mesh.vertices.map((vertex) => vertex[index]!))].sort((left, right) => left - right);
  const clusters: number[] = [];
  for (const value of values) {
    if (!clusters.length || value - clusters[clusters.length - 1]! > CLUSTER_TOLERANCE_MM) clusters.push(value);
  }
  return clusters;
}

function profilePlaneCoords(axis: "x" | "y" | "z", vertex: readonly [number, number, number]): [number, number] {
  // 与 kernel 的 Workplane 对应：x 轴 → YZ 平面 (y,z)；y 轴 → XZ 平面 (x,z)；z 轴 → XY 平面 (x,y)
  if (axis === "x") return [vertex[1], vertex[2]];
  if (axis === "y") return [vertex[0], vertex[2]];
  return [vertex[0], vertex[1]];
}

function extractCapLoop(mesh: SourceMesh, axis: "x" | "y" | "z"): [number, number][] | null {
  const index = AXIS_INDEX[axis];
  const clusters = axisClusters(mesh, axis);
  if (clusters.length !== 2) return null;
  const capValue = clusters[0]!;
  const inCap = new Set<number>();
  mesh.vertices.forEach((vertex, vertexIndex) => {
    if (Math.abs(vertex[index]! - capValue) <= CLUSTER_TOLERANCE_MM) inCap.add(vertexIndex);
  });
  const edgeCount = new Map<string, [number, number]>();
  const bump = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const existing = edgeCount.get(key);
    if (existing) existing[1] += 1; else edgeCount.set(key, [a < b ? a : b, 1]);
  };
  let capTriangles = 0;
  for (const face of mesh.faces) {
    if (!face.every((vertexIndex) => inCap.has(vertexIndex))) continue;
    capTriangles += 1;
    bump(face[0]!, face[1]!); bump(face[1]!, face[2]!); bump(face[2]!, face[0]!);
  }
  if (!capTriangles) return null;
  const adjacency = new Map<number, number[]>();
  for (const [key, [, count]] of edgeCount) {
    if (count !== 1) continue;
    const [a, b] = key.split(":").map(Number) as [number, number];
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  if (!adjacency.size) return null;
  for (const neighbours of adjacency.values()) if (neighbours.length !== 2) return null;
  const start = Math.min(...adjacency.keys());
  const loop: number[] = [start];
  let previous = -1;
  let current = start;
  while (true) {
    const [first, second] = adjacency.get(current)! as [number, number];
    const next = first === previous ? second : first;
    if (next === start) break;
    if (loop.length > adjacency.size) return null;
    loop.push(next);
    previous = current;
    current = next;
  }
  if (loop.length !== adjacency.size || loop.length < 3 || loop.length > MAX_PROFILE_POINTS) return null;
  const profile = dedupeConsecutive(loop.map((vertexIndex) => profilePlaneCoords(axis, mesh.vertices[vertexIndex]!).map(round6) as [number, number]));
  return profile.length >= 3 ? dropCollinear(profile) : null;
}

function dedupeConsecutive(points: [number, number][]): [number, number][] {
  const kept: [number, number][] = [];
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous && Math.abs(previous[0] - point[0]) <= 1e-6 && Math.abs(previous[1] - point[1]) <= 1e-6) continue;
    kept.push(point);
  }
  while (kept.length > 1) {
    const first = kept[0]!;
    const last = kept[kept.length - 1]!;
    if (Math.abs(first[0] - last[0]) <= 1e-6 && Math.abs(first[1] - last[1]) <= 1e-6) kept.pop(); else break;
  }
  return kept;
}

function dropCollinear(points: [number, number][]): [number, number][] {
  if (points.length <= 4) return points;
  const kept: [number, number][] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index + points.length - 1) % points.length]!;
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const cross = (current[0] - previous[0]) * (next[1] - previous[1]) - (current[1] - previous[1]) * (next[0] - previous[0]);
    if (Math.abs(cross) > 1e-6) kept.push(current);
  }
  return kept.length >= 3 ? kept : points;
}

function prismFromMesh(mesh: SourceMesh): TranslatedSolid | null {
  for (const axis of AXES) {
    const clusters = axisClusters(mesh, axis);
    if (clusters.length !== 2) continue;
    const profile = extractCapLoop(mesh, axis);
    if (!profile) continue;
    const depth = clusters[1]! - clusters[0]!;
    if (depth <= 1e-3) continue;
    const origin: [number, number, number] = [0, 0, 0];
    origin[AXIS_INDEX[axis]] = round6(clusters[0]!);
    return { kind: "extrudedProfile", profileMm: profile, depth: exact(depth), axis, originMm: origin };
  }
  return null;
}

function boxFromMesh(mesh: SourceMesh): TranslatedSolid | null {
  if (AXES.some((axis) => axisClusters(mesh, axis).length !== 2)) return null;
  return boxFromBounds(meshBounds(mesh));
}

const STRIP_SEGMENTS = 8;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// 把曲面条带构件（瓦件、曲面板）投影到与挤出轴垂直的平面，
// 用三锚点二次拟合中线并按厚度上下偏移，得到平滑且必然简单的条带轮廓。
function stripFromMesh(mesh: SourceMesh, stationAxis: "x" | "y" | "z", thicknessMm: number): TranslatedSolid | null {
  const stationIndex = AXIS_INDEX[stationAxis];
  const projected = mesh.vertices.map((vertex) => profilePlaneCoords(stationAxis, vertex));
  const runValues = projected.map(([run]) => run!);
  const runMin = Math.min(...runValues);
  const runMax = Math.max(...runValues);
  const span = runMax - runMin;
  if (span <= 1e-3) return null;
  const anchorHeight = (fraction: number): number | null => {
    const target = runMin + span * fraction;
    const window = span / 4;
    const heights = projected.filter(([run]) => Math.abs(run! - target) <= window).map(([, height]) => height!);
    return heights.length ? median(heights) : null;
  };
  const anchorRuns = [0.1, 0.5, 0.9].map((fraction) => runMin + span * fraction);
  const anchorHeights = [0.1, 0.5, 0.9].map((fraction) => anchorHeight(fraction));
  if (anchorHeights.some((height) => height === null)) return null;
  const [r0, r1, r2] = anchorRuns as [number, number, number];
  const [h0, h1, h2] = anchorHeights as [number, number, number];
  const centerline = (run: number): number => {
    // 三点拉格朗日二次插值
    const l0 = ((run - r1) * (run - r2)) / ((r0 - r1) * (r0 - r2));
    const l1 = ((run - r0) * (run - r2)) / ((r1 - r0) * (r1 - r2));
    const l2 = ((run - r0) * (run - r1)) / ((r2 - r0) * (r2 - r1));
    return h0 * l0 + h1 * l1 + h2 * l2;
  };
  const half = Math.max(6, thicknessMm) / 2;
  const bottom: [number, number][] = [];
  const top: [number, number][] = [];
  for (let step = 0; step <= STRIP_SEGMENTS; step += 1) {
    const run = runMin + (span * step) / STRIP_SEGMENTS;
    const height = centerline(run);
    bottom.push([round6(run), round6(height - half)]);
    top.push([round6(run), round6(height + half)]);
  }
  top.reverse();
  const profile = dropCollinear(dedupeConsecutive([...bottom, ...top]));
  if (profile.length < 3 || profile.length > MAX_PROFILE_POINTS) return null;
  const bounds = meshBounds(mesh);
  const depth = bounds[1][stationIndex]! - bounds[0][stationIndex]!;
  if (depth <= 1e-3) return null;
  const origin: [number, number, number] = [0, 0, 0];
  origin[stationIndex] = round6(bounds[0][stationIndex]!);
  return { kind: "extrudedProfile", profileMm: profile, depth: exact(depth), axis: stationAxis, originMm: origin };
}

function connectedComponents(mesh: SourceMesh): SourceMesh[] {
  const parent = mesh.vertices.map((_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[value] !== root) { const next = parent[value]!; parent[value] = root; value = next; }
    return root;
  };
  const union = (a: number, b: number) => { const left = find(a); const right = find(b); if (left !== right) parent[left] = right; };
  for (const face of mesh.faces) { union(face[0]!, face[1]!); union(face[1]!, face[2]!); }
  interface MeshGroup { vertices: [number, number, number][]; faces: [number, number, number][]; remap: Map<number, number> }
  const groups = new Map<number, MeshGroup>();
  mesh.vertices.forEach((vertex, index) => {
    const root = find(index);
    const group: MeshGroup = groups.get(root) ?? { vertices: [], faces: [], remap: new Map() };
    group.remap.set(index, group.vertices.length);
    group.vertices.push([vertex[0], vertex[1], vertex[2]]);
    groups.set(root, group);
  });
  for (const face of mesh.faces) {
    const group = groups.get(find(face[0]!))!;
    group.faces.push([group.remap.get(face[0]!)!, group.remap.get(face[1]!)!, group.remap.get(face[2]!)!] as [number, number, number]);
  }
  return [...groups.values()]
    .map((group) => ({ vertices: group.vertices, faces: group.faces }))
    .sort((left, right) => {
      const volume = (item: SourceMesh) => {
        const [minimum, maximum] = meshBounds(item);
        return (maximum[0] - minimum[0]) * (maximum[1] - minimum[1]) * (maximum[2] - minimum[2]);
      };
      return volume(right) - volume(left);
    });
}

function dimension(facts: ReadonlyMap<string, number>, category: string): number | null {
  const value = facts.get(category);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cylinderFromEntity(
  componentType: string,
  facts: ReadonlyMap<string, number>,
  bounds: readonly [readonly [number, number, number], readonly [number, number, number]],
): { solid: TranslatedSolid; tag: ApproximationTag } | null {
  const [minimum, maximum] = bounds;
  const extent = (axis: 0 | 1 | 2) => maximum[axis]! - minimum[axis]!;
  const center: [number, number, number] = [
    round6((maximum[0]! + minimum[0]!) / 2), round6((maximum[1]! + minimum[1]!) / 2), round6((maximum[2]! + minimum[2]!) / 2),
  ];
  if (componentType === "purlin") {
    const extents: [number, number, number] = [extent(0), extent(1), extent(2)];
    const longest = extents.indexOf(Math.max(...extents)) as 0 | 1 | 2;
    const radius = (dimension(facts, "diameter") ?? Math.min(...extents)) / 2;
    return {
      solid: { kind: "cylinder", radius: exact(radius), height: exact(extents[longest]), axis: (["x", "y", "z"] as const)[longest], centerMm: center },
      tag: "cylinderEnvelope",
    };
  }
  if (componentType === "column") {
    const bottom = dimension(facts, "bottomDiameter") ?? dimension(facts, "lowerDiameter") ?? extent(0);
    const top = dimension(facts, "topDiameter") ?? dimension(facts, "upperDiameter") ?? bottom;
    return {
      solid: { kind: "cylinder", radius: exact((bottom + top) / 4), height: exact(extent(2)), axis: "z", centerMm: center },
      tag: "cylinderAveragedTaper",
    };
  }
  if (componentType === "columnBase") {
    const lower = dimension(facts, "lowerDiameter") ?? extent(0);
    return {
      solid: { kind: "cylinder", radius: exact(lower / 2), height: exact(extent(2)), axis: "z", centerMm: center },
      tag: "cylinderEnvelope",
    };
  }
  return null;
}

const STRIP_TYPES = new Set(["panTile", "coverTile"]);

export function translateEntity(
  componentType: string,
  dimensionFacts: ReadonlyMap<string, number>,
  bounds: readonly [readonly [number, number, number], readonly [number, number, number]],
  mesh: SourceMesh | undefined,
): EntityTranslation {
  const cylinder = cylinderFromEntity(componentType, dimensionFacts, bounds);
  if (cylinder) return { primary: cylinder.solid, parts: [], approximations: [cylinder.tag] };
  if (!mesh || !mesh.vertices.length || !mesh.faces.length) {
    return { primary: boxFromBounds(bounds), parts: [], approximations: ["boundsEnvelopeFallback"] };
  }
  const thickness = dimension(dimensionFacts, "thickness") ?? 18;
  const whole = boxFromMesh(mesh) ?? prismFromMesh(mesh);
  if (whole) return { primary: whole, parts: [], approximations: [whole.kind === "box" ? "exactBox" : "exactPrism"] };
  if (STRIP_TYPES.has(componentType)) {
    const strip = stripFromMesh(mesh, "x", thickness);
    if (strip) return { primary: strip, parts: [], approximations: ["stripCrossSectionFlattened"] };
  }
  const components = connectedComponents(mesh);
  if (components.length > 1) {
    const translated = components.map((component) =>
      boxFromMesh(component)
      ?? prismFromMesh(component)
      ?? stripFromMesh(component, "x", thickness)
      ?? boxFromBounds(meshBounds(component)));
    const fellBack = translated.some((solid, index) =>
      solid.kind === "box" && boxFromMesh(components[index]!) === null);
    return {
      primary: translated[0]!,
      parts: translated.slice(1),
      approximations: fellBack ? ["decomposedParts", "boundsEnvelopeFallback"] : ["decomposedParts"],
    };
  }
  const strip = stripFromMesh(mesh, "x", thickness) ?? stripFromMesh(mesh, "y", thickness);
  if (strip) return { primary: strip, parts: [], approximations: ["stripCrossSectionFlattened"] };
  return { primary: boxFromBounds(bounds), parts: [], approximations: ["boundsEnvelopeFallback"] };
}
