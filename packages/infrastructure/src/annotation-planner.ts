import type { ProjectHead } from "@gujian/application";
import {
  resolveAnnotationRules,
  type DrawingAnnotationKind,
  type ProjectDrivenGeometrySpec,
} from "@gujian/domain";
import { AXIS_MINIMUM_ON_PAPER_SPACING_MM, AXIS_SOURCE_PRIORITY, LEVEL_SOURCES } from "@gujian/domain";
import { HERITAGE_CONCEPTS_V1 } from "./vocabulary/heritage-concepts-v1.js";
import { conceptLabel, resolveVocabulary } from "./vocabulary-resolver.js";

// 图面标注的规划：把项目事实与几何派生成一份标注请求，随成果矩阵下发。
//
// 这里只决定标什么、取自哪个构件或事实、在视图二维坐标里的位置，
// 不决定纸面怎么画。制图侧按请求解析成图元，不自己判断该标什么。
//
// 此前每视图固定产出两条标注（图名与图形总宽），与建筑规模无关：712 条
// 结构线的样本与十万条结构线的项目标注数量相同。那不是按尺寸链生成的
// 体系，是每视图套模板。差距清单见
// 文档/05_验证证据/12_图纸差距与一致性核对/README.md 第三节。

type GeometryObject = ProjectDrivenGeometrySpec["objects"][number];

export interface PlannedAxis {
  readonly label: string;
  // 这条轴线在图面上的走向：u 表示位置沿视图横轴、线竖着画；
  // v 表示位置沿视图纵轴、线横着画。平面两族都有，立面剖面只有 u。
  readonly along: "u" | "v";
  // 视图二维坐标里的位置，与投影线同一坐标系
  readonly positionMm: number;
  // 这条轴线是按什么定的，随图面显示
  readonly basisZh: string;
  readonly sourceEntityIds: readonly string[];
}

export interface PlannedLevel {
  readonly label: string;
  readonly elevationMm: number;
  readonly basisZh: string;
  readonly sourceEntityIds: readonly string[];
}

export interface PlannedLabel {
  readonly text: string;
  readonly anchorMm: readonly [number, number];
  readonly sourceEntityIds: readonly string[];
}

export interface PlannedSectionMark {
  readonly label: string;
  // 剖切线在本视图二维坐标里的两端
  readonly fromMm: readonly [number, number];
  readonly toMm: readonly [number, number];
  readonly targetViewKey: string;
}

// 模型算出的标高与项目已记录尺寸对不上。两个数都要看得见，
// 不能由制图侧选一个印在图上。
export interface LevelConflict {
  readonly labelZh: string;
  readonly geometryMm: number;
  readonly documentedMm: number;
  readonly documentedNameZh: string;
}

// 详图索引：总图上标出某个局部另有详图，详图上回引它取自哪张总图。
// 没有索引的详图与总图之间没有对应关系，追不回去（质量基准 4.2）。
export interface PlannedDetailIndex {
  readonly label: string;
  // 索引圈在本视图二维坐标里的位置
  readonly atMm: readonly [number, number];
  readonly targetViewKey: string;
  // parent 表示这是总图上指向详图的索引，back 表示详图上的回引
  readonly direction: "parent" | "back";
}

export interface ViewAnnotationPlan {
  readonly axes: readonly PlannedAxis[];
  readonly levels: readonly PlannedLevel[];
  readonly labels: readonly PlannedLabel[];
  readonly sectionMarks: readonly PlannedSectionMark[];
  readonly detailIndexes: readonly PlannedDetailIndex[];
  readonly levelConflicts: readonly LevelConflict[];
  // 北向角度：平面上北在图面里的方向，缺省表示项目没有声明朝向
  readonly northAngleDeg: number | null;
  // 按策略丢弃的条数，逐种记，不静默截断
  readonly droppedByKind: Readonly<Record<string, number>>;
}

const BASIS_LABEL: Readonly<Record<string, string>> = {
  measured: "实测",
  human: "图上量取",
  rule: "规则推算",
  demo: "照片估算",
};

function centre(object: GeometryObject): [number, number, number] {
  const solid = object.solid;
  if (solid.kind === "extrudedProfile") {
    // 挤出体的中心用轮廓范围与出料方向估算：轮廓在挤出轴对应的平面内
    const first = solid.profileMm.map((point) => point[0]);
    const second = solid.profileMm.map((point) => point[1]);
    const midFirst = (Math.min(...first) + Math.max(...first)) / 2;
    const midSecond = (Math.min(...second) + Math.max(...second)) / 2;
    const depth = Number(solid.depth);
    const [ox, oy, oz] = solid.originMm;
    if (solid.axis === "x") return [ox + depth / 2, oy + midFirst, oz + midSecond];
    if (solid.axis === "y") return [ox + midFirst, oy - depth / 2, oz + midSecond];
    return [ox + midFirst, oy + midSecond, oz + depth / 2];
  }
  return [solid.centerMm[0], solid.centerMm[1], solid.centerMm[2]];
}

function project(point: readonly number[], axis: readonly number[]): number {
  return point[0]! * axis[0]! + point[1]! * axis[1]! + point[2]! * axis[2]!;
}

// 构件在水平面上的包围盒范围，用来判断它沿哪个方向长
function horizontalExtent(object: GeometryObject): { dx: number; dy: number } {
  const solid = object.solid;
  if (solid.kind === "box") return { dx: Number(solid.sizeX), dy: Number(solid.sizeY) };
  if (solid.kind === "cylinder") {
    const diameter = Number(solid.radius) * 2;
    const height = Number(solid.height);
    return {
      dx: solid.axis === "x" ? height : diameter,
      dy: solid.axis === "y" ? height : diameter,
    };
  }
  const first = solid.profileMm.map((point) => point[0]);
  const second = solid.profileMm.map((point) => point[1]);
  const spanFirst = Math.max(...first) - Math.min(...first);
  const spanSecond = Math.max(...second) - Math.min(...second);
  const depth = Number(solid.depth);
  if (solid.axis === "x") return { dx: depth, dy: spanFirst };
  if (solid.axis === "y") return { dx: spanFirst, dy: depth };
  return { dx: spanFirst, dy: spanSecond };
}

// 轴线取候选构件的中心线并聚类。聚类容差取一个构件的常见截面，
// 同一榀上的柱与柱础不该各占一条轴线。
const AXIS_CLUSTER_TOLERANCE_MM = 250;
// 长宽比超过这个数才算沿某个方向长；接近方形的构件（柱）两族都定轴
const AXIS_ELONGATION_RATIO = 2.0;

function clusterPositions(
  entries: readonly { position: number; id: string }[],
): { position: number; ids: string[] }[] {
  const sorted = [...entries].sort((left, right) => left.position - right.position);
  const clusters: { position: number; ids: string[] }[] = [];
  for (const entry of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(entry.position - last.position) <= AXIS_CLUSTER_TOLERANCE_MM) {
      last.ids.push(entry.id);
      last.position = (last.position * (last.ids.length - 1) + entry.position) / last.ids.length;
      continue;
    }
    clusters.push({ position: entry.position, ids: [entry.id] });
  }
  return clusters;
}

// 轴号：定 X 的一族用数字，定 Y 的一族用大写字母（GB/T 50001）。
// 字母跳过 I、O、Z，它们与数字 1、0、2 在图上分不开。
const AXIS_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXY".split("");

function axisLabel(index: number, useLetters: boolean): string {
  if (!useLetters) return String(index + 1);
  const letter = AXIS_LETTERS[index % AXIS_LETTERS.length]!;
  const round = Math.floor(index / AXIS_LETTERS.length);
  return round === 0 ? letter : `${letter}${round + 1}`;
}

const BASIS_STRENGTH: Readonly<Record<string, number>> = { measured: 3, human: 2, rule: 1, demo: 0 };

// 一组构件共同决定的那条线，来源取其中最弱的一条。位置由强来源定、
// 尺寸由弱来源定时，标注只能按弱的说，否则是把量取显示成实测。
function weakestBasis(objects: readonly GeometryObject[]): string {
  let weakest = "measured";
  for (const object of objects) {
    const candidates = [object.positionBasis, ...object.parameters.map((item) => item.basis)];
    for (const candidate of candidates) {
      if (candidate && (BASIS_STRENGTH[candidate] ?? 0) < (BASIS_STRENGTH[weakest] ?? 0)) weakest = candidate;
    }
  }
  return weakest;
}

// 轴网按建筑整体算两族：定 X 的一族与定 Y 的一族。视图按自己的横轴取用
// 对应的一族，因此同一条轴线在平面与剖面上是同一个轴号。
//
// 一条构件只在与它长向垂直的那一族里定轴：沿 Y 通长的墙定的是 X 轴线，
// 取它的中心 X 当轴线位置才有意义；反过来取它的中心 Y，得到的是这道墙的
// 中点，不是任何一条轴。接近方形的构件（柱）两族都进。
function planAxisFamily(
  spec: ProjectDrivenGeometrySpec,
  along: "x" | "y",
  onPaper: "u" | "v",
  scaleDenominator: number,
  maxCount: number,
): { axes: PlannedAxis[]; dropped: number } {
  // 只有声明了位置出处的构件才能定轴。位置由生成器自行排布的构件
  // （例如按等距摆的木桩）没有这个声明，因此永远不会变成轴线。
  const eligible = spec.objects.filter((item) => item.positionBasis !== undefined);
  const byId = new Map(spec.objects.map((item) => [item.id, item]));
  for (const [groupIndex, group] of AXIS_SOURCE_PRIORITY.entries()) {
    const members = eligible.filter((item) => {
      if (!group.includes(item.componentType)) return false;
      const { dx, dy } = horizontalExtent(item);
      const longSpan = along === "x" ? dy : dx;
      const shortSpan = along === "x" ? dx : dy;
      return longSpan * AXIS_ELONGATION_RATIO >= shortSpan;
    });
    if (members.length < 2) continue;
    const clusters = clusterPositions(members.map((item) => {
      const point = centre(item);
      return { position: along === "x" ? point[0] : point[1], id: item.id };
    }));
    if (clusters.length < 2) continue;
    // 可辨间距守卫：轴号圈在成图上挤到一起就读不出是哪一条。
    // 间距不足的整条丢弃并计数，不缩圈也不压线。
    const threshold = AXIS_MINIMUM_ON_PAPER_SPACING_MM * scaleDenominator;
    const legible: typeof clusters = [];
    let crowded = 0;
    for (const cluster of clusters) {
      const previous = legible[legible.length - 1];
      // 首尾两条是建筑外轮廓，无论多挤都保留：丢掉它们等于丢掉总尺寸的依据
      const isEdge = cluster === clusters[0] || cluster === clusters[clusters.length - 1];
      if (previous && !isEdge && cluster.position - previous.position < threshold) {
        crowded += 1;
        continue;
      }
      legible.push(cluster);
    }
    const suffix = groupIndex === 0 ? "柱心线" : "墙心线";
    const axes = legible.slice(0, maxCount).map((cluster, index) => ({
      label: axisLabel(index, along === "y"),
      along: onPaper,
      positionMm: Math.round(cluster.position * 10) / 10,
      basisZh: `${BASIS_LABEL[weakestBasis(cluster.ids.map((id) => byId.get(id)!))] ?? "来源不明"}${suffix}`,
      sourceEntityIds: cluster.ids,
    }));
    return { axes, dropped: crowded + Math.max(0, legible.length - maxCount) };
  }
  return { axes: [], dropped: 0 };
}

// 项目里已写明的标高尺寸。标高标注优先取这里的值：几何算出来的是
// 构造面（屋面构造顶比结构脊高一个构造厚度），图纸写明的才是那条标高。
// 差几十毫米在图上看不出来，但标注写的数与资料对不上，就是两套数。
interface DocumentedElevation {
  readonly valueMm: number;
  readonly labelZh: string;
  readonly dataStatus: string;
}

function documentedElevations(head: ProjectHead): DocumentedElevation[] {
  const out: DocumentedElevation[] = [];
  for (const fact of head.snapshot.facts) {
    if (!fact.field.startsWith("documentedDimension.")) continue;
    const value = fact.value as { name?: string; value?: number; unit?: string } | null;
    if (!value || typeof value.value !== "number" || value.unit !== "mm") continue;
    out.push({ valueMm: value.value, labelZh: value.name ?? fact.field, dataStatus: fact.dataStatus });
  }
  return out;
}

function matchingFacts(documented: readonly DocumentedElevation[], hints: readonly string[] | undefined): DocumentedElevation[] {
  if (!hints?.length) return [];
  return documented.filter((item) => hints.some(
    (hint) => item.labelZh.toLowerCase().includes(hint.toLowerCase()),
  ));
}

// 几何标高与写明标高相差不超过这个值时视为同一条，采用写明值。
// 取一个构造层厚度的量级：再大就不是同一条标高了。
const LEVEL_FACT_SNAP_MM = 120;

const STOREY_PREFIX = ["", "二层", "三层", "四层", "五层"];
const LEVEL_TOLERANCE_MM = 50;

function boundsZ(object: GeometryObject): [number, number] {
  const solid = object.solid;
  if (solid.kind === "box") {
    const half = Number(solid.sizeZ) / 2;
    return [solid.centerMm[2] - half, solid.centerMm[2] + half];
  }
  if (solid.kind === "cylinder") {
    const height = Number(solid.height);
    if (solid.axis !== "z") return [solid.centerMm[2] - Number(solid.radius), solid.centerMm[2] + Number(solid.radius)];
    return [solid.centerMm[2] - height / 2, solid.centerMm[2] + height / 2];
  }
  const second = solid.profileMm.map((point) => point[1]);
  const oz = solid.originMm[2];
  if (solid.axis === "z") return [oz, oz + Number(solid.depth)];
  return [oz + Math.min(...second), oz + Math.max(...second)];
}

function planLevels(
  spec: ProjectDrivenGeometrySpec, documented: readonly DocumentedElevation[], maxCount: number,
): { levels: PlannedLevel[]; dropped: number; conflicts: LevelConflict[] } {
  const found: PlannedLevel[] = [];
  const conflicts: LevelConflict[] = [];
  for (const source of LEVEL_SOURCES) {
    const members = spec.objects.filter((item) => source.componentTypes.includes(item.componentType));
    if (!members.length) continue;
    const faceIndex = source.face === "top" ? 1 : 0;
    const groups = new Map<number, GeometryObject[]>();
    for (const member of members) {
      const value = Math.round(boundsZ(member)[faceIndex] * 10) / 10;
      const key = [...groups.keys()].find((item) => Math.abs(item - value) <= LEVEL_TOLERANCE_MM) ?? value;
      groups.set(key, [...(groups.get(key) ?? []), member]);
    }
    const values = [...groups.entries()].sort((left, right) => left[0] - right[0]);
    const picked = source.multiple ? values : [source.face === "top" ? values[values.length - 1]! : values[0]!];
    for (const [index, entry] of picked.entries()) {
      const [elevation, contributors] = entry;
      if (found.some((item) => Math.abs(item.elevationMm - elevation) < LEVEL_TOLERANCE_MM)) continue;
      const candidates = matchingFacts(documented, source.factNameHints);
      const fact = candidates.find((item) => Math.abs(item.valueMm - elevation) <= LEVEL_FACT_SNAP_MM);
      // 有对应事实但差得超过一个构造层厚度：模型与项目记录的尺寸是两个数。
      // 不静默采用任何一个，图面按模型出，冲突另记，由人核定后再改。
      if (!fact) {
        for (const candidate of candidates) {
          conflicts.push({
            labelZh: source.labelZh,
            geometryMm: elevation,
            documentedMm: candidate.valueMm,
            documentedNameZh: candidate.labelZh,
          });
        }
      }
      found.push({
        label: source.multiple ? `${STOREY_PREFIX[index] ?? `${index + 1}层`}${source.labelZh}` : source.labelZh,
        // 有写明的标高就用写明值，几何值只在没有写明时兜底
        elevationMm: fact ? fact.valueMm : elevation,
        basisZh: fact
          ? (fact.dataStatus === "available" ? "图纸标注" : "图上量取")
          : BASIS_LABEL[weakestBasis(contributors)] ?? "来源不明",
        sourceEntityIds: contributors.map((item) => item.id).slice(0, 8),
      });
    }
  }
  const sorted = found.sort((left, right) => left.elevationMm - right.elevationMm);
  return { levels: sorted.slice(0, maxCount), dropped: Math.max(0, sorted.length - maxCount), conflicts };
}

// 构件标注按视图声明的目标构件出，没有声明时按构件类型各取一个代表。
//
// 名称取词表首选名，不取构件实例名。实例名要在清单里区分同类构件，
// 常带房间名与编号（二层南端楼板 BEDROOM 与 STAIR HALL），二十多字
// 引出来在 1:100 的图上横跨半张平面。图面标的是这是什么构件，
// 是哪一个由引线指着的位置说明。词表里没有的类型退回实例名。
function planLabels(
  spec: ProjectDrivenGeometrySpec,
  targetEntityIds: readonly string[],
  right: readonly number[],
  up: readonly number[],
  maxCount: number,
): { labels: PlannedLabel[]; dropped: number } {
  if (maxCount === 0) return { labels: [], dropped: 0 };
  const byId = new Map(spec.objects.map((item) => [item.id, item]));
  const chosen: GeometryObject[] = targetEntityIds.length
    ? targetEntityIds.map((id) => byId.get(id)).filter((item): item is GeometryObject => item !== undefined)
    : [...new Map(spec.objects.map((item) => [item.componentType, item])).values()];
  const vocabulary = resolveVocabulary();
  const labels = chosen.map((item) => {
    const point = centre(item);
    return {
      text: conceptLabel(vocabulary, item.conceptRef ?? item.componentType) ?? item.displayNameZh,
      anchorMm: [
        Math.round(project(point, right) * 10) / 10,
        Math.round(project(point, up) * 10) / 10,
      ] as [number, number],
      sourceEntityIds: [item.id],
    };
  });
  return { labels: labels.slice(0, maxCount), dropped: Math.max(0, labels.length - maxCount) };
}

export interface AnnotationPlanInput {
  readonly head: ProjectHead;
  readonly spec: ProjectDrivenGeometrySpec;
  readonly view: {
    readonly key: string;
    readonly kind: string;
    readonly scaleDenominator: number;
    readonly right: readonly number[];
    readonly up: readonly number[];
    readonly sourceEntityIds: readonly string[];
  };
  readonly allViews: readonly {
    readonly key: string;
    readonly kind: string;
    readonly displayLabelZh: string;
    readonly drawingRef: string;
    readonly sectionPlane?: { readonly normal: readonly number[]; readonly offsetMm: number };
    readonly cropBoundsMm?: readonly number[];
  }[];
}

export function planViewAnnotations(input: AnnotationPlanInput): ViewAnnotationPlan {
  const { spec, view } = input;
  const rules = new Map(resolveAnnotationRules(view.kind, view.scaleDenominator).map((rule) => [rule.kind, rule]));
  const cap = (kind: DrawingAnnotationKind): number => rules.get(kind)?.maxCount ?? 0;
  const dropped: Record<string, number> = {};
  const note = (kind: string, count: number) => { if (count > 0) dropped[kind] = count; };

  const isPlan = view.kind === "floorPlan" || view.kind === "roofPlan";
  // 视图横轴指向哪一族，就取哪一族的轴线。平面的横轴通常是 X，
  // 纵剖面的横轴是 Y，两者取到的是不同的一族，轴号因此互不冲突。
  const along: "x" | "y" = Math.abs(view.right[0] ?? 0) >= Math.abs(view.right[1] ?? 0) ? "x" : "y";
  const crossAlong: "x" | "y" = along === "x" ? "y" : "x";
  const axisResult = cap("axisGrid") > 0
    ? planAxisFamily(spec, along, "u", view.scaleDenominator, cap("axisGrid"))
    : { axes: [], dropped: 0 };
  // 平面两个方向的轴网都要出，一张只有一族轴号的平面是半套轴网。
  // 立面与剖面只出与画面平行的那一族，另一族在这类视图上退化成一个点。
  const crossResult = isPlan && cap("axisGrid") > 0
    ? planAxisFamily(spec, crossAlong, "v", view.scaleDenominator, cap("axisGrid"))
    : { axes: [], dropped: 0 };
  note("axisGrid", axisResult.dropped + crossResult.dropped);

  const levelResult = cap("levelMark") > 0
    ? planLevels(spec, documentedElevations(input.head), cap("levelMark"))
    : { levels: [], dropped: 0, conflicts: [] };
  note("levelMark", levelResult.dropped);

  const labelResult = planLabels(spec, view.sourceEntityIds, view.right, view.up, cap("componentLabel"));
  note("componentLabel", labelResult.dropped);

  // 剖切符号只出在平面上，指向本套图里以本平面法向之外的平面剖切的视图
  const sectionMarks: PlannedSectionMark[] = [];
  if (isPlan && cap("sectionMark") > 0) {
    const bounds = spec.objects.map((item) => project(centre(item), view.up));
    const low = Math.min(...bounds);
    const high = Math.max(...bounds);
    for (const candidate of input.allViews) {
      if (sectionMarks.length >= cap("sectionMark")) break;
      const plane = candidate.sectionPlane;
      if (!plane || candidate.kind === "floorPlan" || candidate.kind === "roofPlan" || candidate.kind === "detail") continue;
      // 剖切面法向落在本视图横轴上时，剖切线是一条平行于纵轴的直线
      const along = project(plane.normal, view.right);
      if (Math.abs(along) < 0.9) continue;
      const position = plane.offsetMm * along;
      sectionMarks.push({
        label: candidate.drawingRef,
        fromMm: [position, low],
        toMm: [position, high],
        targetViewKey: candidate.key,
      });
    }
  }

  // 详图索引：本视图是详图时出回引，是详图的母图时出正向索引。
  // 详图与母图靠剖切面法向认亲，不要求偏移相等：详图常取在母图的对称位置，
  // 按偏移严格相等匹配会一条也认不上。同法向有多个候选时取偏移最近的。
  const detailIndexes: PlannedDetailIndex[] = [];
  const self = input.allViews.find((item) => item.key === view.key);
  const sameNormal = (
    left: { readonly normal: readonly number[] } | undefined,
    right: { readonly normal: readonly number[] } | undefined,
  ): boolean => {
    if (!left || !right) return false;
    const dot = left.normal.reduce((sum, value, index) => sum + value * (right.normal[index] ?? 0), 0);
    return Math.abs(Math.abs(dot) - 1) < 1e-6;
  };
  if (cap("detailIndex") > 0 && self) {
    if (view.kind === "detail") {
      const parents = input.allViews
        .filter((item) => item.key !== view.key && item.kind !== "detail" && sameNormal(item.sectionPlane, self.sectionPlane))
        .sort((left, right) => Math.abs((left.sectionPlane?.offsetMm ?? 0) - (self.sectionPlane?.offsetMm ?? 0))
          - Math.abs((right.sectionPlane?.offsetMm ?? 0) - (self.sectionPlane?.offsetMm ?? 0)));
      const parent = parents[0];
      if (parent) {
        detailIndexes.push({
          label: parent.drawingRef, atMm: [0, 0], targetViewKey: parent.key, direction: "back",
        });
      }
    } else {
      for (const candidate of input.allViews) {
        if (detailIndexes.length >= cap("detailIndex")) break;
        if (candidate.kind !== "detail" || !candidate.cropBoundsMm) continue;
        if (!sameNormal(candidate.sectionPlane, self.sectionPlane)) continue;
        const [uMin, vMin, uMax, vMax] = candidate.cropBoundsMm;
        detailIndexes.push({
          label: candidate.drawingRef,
          atMm: [(uMin! + uMax!) / 2, (vMin! + vMax!) / 2],
          targetViewKey: candidate.key,
          direction: "parent",
        });
      }
    }
  }

  return {
    axes: [...axisResult.axes, ...crossResult.axes],
    levels: levelResult.levels,
    labels: labelResult.labels,
    sectionMarks,
    detailIndexes,
    levelConflicts: levelResult.conflicts,
    // 项目没有声明朝向就不出北向符号，不按平面上北默认补一个。
    // 三个演示项目的资料都没有给出正北方向。
    northAngleDeg: null,
    droppedByKind: dropped,
  };
}
