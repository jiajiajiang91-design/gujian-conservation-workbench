import { z } from "zod";

// 图面标注体系。哪类视图必须有哪几种标注，以及按出图比例的条数上限。
//
// 这份表是数据，不是分支。制图侧只执行矩阵里解析好的规则，
// 不含任何视图种类或比例的判断；改标注口径改这里，不改管线代码。
//
// 依据：GB/T 50001-2017《房屋建筑制图统一标准》关于轴线、尺寸、标高与
// 符号的要求；CH/T 6005-2018《古建筑测绘规范》关于单体测绘成果的图面内容。
// 补齐范围与优先级见 文档/05_验证证据/12_图纸差距与一致性核对/README.md 第四节。
//
// 条数上限的由来与 4.3 的图面细节层级同理：标注文字按 3 mm 字高出图，
// 一张 1:100 的立面上排二十条构件引线必然叠字。放不下的按规则丢弃并计数，
// 不允许压线，丢弃数进检查记录。

export const ANNOTATION_TEXT_HEIGHT_MM = 3.0;

export const DrawingAnnotationKindSchema = z.enum([
  // 图面基础：图名、图形总尺寸、资格声明、演示观察候选
  "viewTitle",
  "overallDimension",
  "qualification",
  "conditionCandidate",
  // A 轴网与尺寸链
  "axisGrid",
  "axisDimensionChain",
  // B 标高与符号
  "levelMark",
  "sectionMark",
  "detailIndex",
  "northArrow",
  // C 构件标注
  "componentLabel",
]);

export type DrawingAnnotationKind = z.infer<typeof DrawingAnnotationKindSchema>;

export const DrawingAnnotationRuleSchema = z.object({
  kind: DrawingAnnotationKindSchema,
  // required 表示该类视图缺这种标注即为图面不完整，检查记录报缺项；
  // optional 表示有数据就出，没有不算缺。
  requirement: z.enum(["required", "optional"]),
  // 本视图这种标注的条数上限。超出的按规则丢弃并计数。
  maxCount: z.number().int().nonnegative(),
}).strict();

export type DrawingAnnotationRule = z.infer<typeof DrawingAnnotationRuleSchema>;

// 轴线取自哪些构件，按优先级分组：有柱网的项目取柱心线，
// 没有柱网的退到承重墙心线。同一组内的构件一起参与聚类。
//
// 一条硬规则不在这里而在生成器与规划器：只有 positionBasis 已声明的构件
// 才能定轴。位置由生成器为几何完整性自行排布的构件（例如按等距摆的木桩）
// 不声明 positionBasis，因此永远不会变成轴线。把这类位置画成轴线，
// 等于把生成器的排布显示成实测定位。
export const AXIS_SOURCE_PRIORITY: readonly (readonly string[])[] = [
  ["column", "interiorPost", "kingPost"],
  ["exteriorWall", "partition", "wall", "gableWall"],
];

// 标高取自哪些构件的哪个面。与轴线来源一样是策略不是分支：
// 新增构件类型时在这里归族，不在规划器里加判断。
//
// multiple 为真的族逐条列出全部标高（首层楼面与二层楼面是两条），
// 其余族只取该族的极值。取不到的族不出标高，不按常见做法补一个。
export interface LevelSource {
  readonly componentTypes: readonly string[];
  readonly face: "top" | "bottom";
  readonly labelZh: string;
  readonly multiple?: boolean;
  // 这条标高对应项目里哪些已记录尺寸。名称含其中任一片段的事实即为同一条。
  // 有对应事实时标高取事实值；差得太多则记为冲突，两个数都要看得见。
  readonly factNameHints?: readonly string[];
}

export const LEVEL_SOURCES: readonly LevelSource[] = [
  { componentTypes: ["foundationPier", "foundationLayer", "groundLayer", "columnBase", "terrace"], face: "bottom", labelZh: "室外地坪" },
  { componentTypes: ["terrace"], face: "top", labelZh: "台基顶" },
  { componentTypes: ["floorStructure"], face: "top", labelZh: "楼面", multiple: true, factNameHints: ["floorElevation", "secondFloorElevation"] },
  { componentTypes: ["exteriorWall", "wall", "column"], face: "top", labelZh: "檐口", factNameHints: ["eaveElevation", "eaveHeight"] },
  { componentTypes: ["roofPlane", "ridge", "ridgeTile", "gableRidgeCap"], face: "top", labelZh: "屋脊", factNameHints: ["ridgeElevation", "ridgeHeight"] },
  { componentTypes: ["monitorRoof"], face: "top", labelZh: "气窗顶" },
];

// 构件引线标注按比例分档的条数上限
const COMPONENT_LABEL_BANDS: readonly { readonly maxScaleDenominator: number; readonly maxCount: number }[] = [
  { maxScaleDenominator: 20, maxCount: 24 },
  { maxScaleDenominator: 50, maxCount: 12 },
  { maxScaleDenominator: 100, maxCount: 6 },
  { maxScaleDenominator: Number.POSITIVE_INFINITY, maxCount: 0 },
];

function componentLabelCap(scaleDenominator: number): number {
  return COMPONENT_LABEL_BANDS.find((band) => scaleDenominator <= band.maxScaleDenominator)!.maxCount;
}

// 每类视图必备与可选的标注种类。
//
// 轴测图只出图名：轴测是示意用的整体关系图，标尺寸会给出无法按图复核的
// 长度，反而误导。详图不出轴网：详图画的是局部构造，轴号在总图上。
const BY_VIEW_KIND: Readonly<Record<string, readonly { kind: DrawingAnnotationKind; requirement: "required" | "optional" }[]>> = {
  floorPlan: [
    { kind: "viewTitle", requirement: "required" },
    { kind: "overallDimension", requirement: "required" },
    { kind: "qualification", requirement: "required" },
    { kind: "axisGrid", requirement: "required" },
    { kind: "axisDimensionChain", requirement: "required" },
    { kind: "northArrow", requirement: "required" },
    { kind: "sectionMark", requirement: "required" },
    { kind: "detailIndex", requirement: "optional" },
    { kind: "componentLabel", requirement: "optional" },
  ],
  roofPlan: [
    { kind: "viewTitle", requirement: "required" },
    { kind: "overallDimension", requirement: "required" },
    { kind: "qualification", requirement: "required" },
    { kind: "axisGrid", requirement: "optional" },
    { kind: "northArrow", requirement: "required" },
    { kind: "componentLabel", requirement: "optional" },
  ],
  elevation: [
    { kind: "viewTitle", requirement: "required" },
    { kind: "overallDimension", requirement: "required" },
    { kind: "qualification", requirement: "required" },
    { kind: "axisGrid", requirement: "required" },
    { kind: "levelMark", requirement: "required" },
    { kind: "componentLabel", requirement: "optional" },
  ],
  transverseSection: [
    { kind: "viewTitle", requirement: "required" },
    { kind: "overallDimension", requirement: "required" },
    { kind: "qualification", requirement: "required" },
    { kind: "axisGrid", requirement: "required" },
    { kind: "axisDimensionChain", requirement: "required" },
    { kind: "levelMark", requirement: "required" },
    { kind: "detailIndex", requirement: "optional" },
    { kind: "componentLabel", requirement: "optional" },
  ],
  longitudinalSection: [
    { kind: "viewTitle", requirement: "required" },
    { kind: "overallDimension", requirement: "required" },
    { kind: "qualification", requirement: "required" },
    { kind: "axisGrid", requirement: "required" },
    { kind: "axisDimensionChain", requirement: "required" },
    { kind: "levelMark", requirement: "required" },
    { kind: "detailIndex", requirement: "optional" },
    { kind: "componentLabel", requirement: "optional" },
  ],
  detail: [
    { kind: "viewTitle", requirement: "required" },
    { kind: "overallDimension", requirement: "required" },
    { kind: "qualification", requirement: "required" },
    { kind: "componentLabel", requirement: "required" },
  ],
  axonometric: [
    { kind: "viewTitle", requirement: "required" },
    { kind: "qualification", requirement: "required" },
  ],
};

// 与视图规模无关的固定上限。轴号超过这个数在总图上必然叠字，
// 超出部分丢弃并计数，不静默压线。
const FIXED_CAPS: Readonly<Partial<Record<DrawingAnnotationKind, number>>> = {
  viewTitle: 1,
  overallDimension: 1,
  qualification: 1,
  conditionCandidate: 4,
  axisGrid: 40,
  axisDimensionChain: 40,
  levelMark: 8,
  sectionMark: 4,
  detailIndex: 6,
  northArrow: 1,
};

export function resolveAnnotationRules(viewKind: string, scaleDenominator: number): DrawingAnnotationRule[] {
  const entries = BY_VIEW_KIND[viewKind];
  if (!entries) throw new Error(`ANNOTATION_POLICY_VIEW_KIND_UNKNOWN:${viewKind}`);
  return entries.map((entry) => ({
    kind: entry.kind,
    requirement: entry.requirement,
    maxCount: entry.kind === "componentLabel"
      ? componentLabelCap(scaleDenominator)
      : FIXED_CAPS[entry.kind] ?? 0,
  }));
}

export function requiredAnnotationKinds(viewKind: string, scaleDenominator: number): DrawingAnnotationKind[] {
  return resolveAnnotationRules(viewKind, scaleDenominator)
    .filter((rule) => rule.requirement === "required" && rule.maxCount > 0)
    .map((rule) => rule.kind);
}
