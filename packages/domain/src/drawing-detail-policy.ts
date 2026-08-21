import { z } from "zod";

// 质量基准 4.3 图面细节层级。图面细节按出图比例确定，不把模型的全部几何
// 无差别投影到图纸上。三维模型保持精细，图纸按比例取舍，两者不是同一件事。
//
// 判定基线是打印后的可辨间距：同类重复图元在成图上的间距小于 0.5 mm 时
// 必须合并为简化表示或改用图例，否则打印后糊成实块。
//
// 这份表是数据，不是分支。制图侧只按矩阵里解析好的规则执行，
// 不含任何构件名清单；改比例取舍改这里，不改管线代码。

export const DETAIL_MINIMUM_ON_PAPER_SPACING_MM = 0.5;

export const DrawingDetailTreatmentSchema = z.enum([
  // 逐构件出线
  "full",
  // 同族构件的投影并集只画外边界：相邻瓦件并成一垄，一攒斗栱并成外轮廓
  "groupOutline",
  // 不出线，改由材料区表达
  "omit",
  // 只去掉分缝线，构件轮廓保留
  "noJointLines",
]);

export type DrawingDetailTreatment = z.infer<typeof DrawingDetailTreatmentSchema>;

export const DrawingDetailRuleSchema = z.object({
  familyZh: z.string().min(1).max(40),
  componentTypes: z.array(z.string().min(1).max(80)).min(1),
  treatment: DrawingDetailTreatmentSchema,
  minimumOnPaperSpacingMm: z.number().positive(),
}).strict();

export type DrawingDetailRule = z.infer<typeof DrawingDetailRuleSchema>;

// 构件族到 componentType 的映射。两个演示项目用同一套构件名，
// 新增构件类型时在这里归族，不在制图侧判断。
// 构件分缝这一族的取舍只作用在分缝线（feature 线）上，
// 不能取 omit：那会把柱、墙、台基整个从图上删掉，
// 而 4.3 说的是不画分缝，不是不画构件。
const FAMILIES = {
  瓦面: ["coverTile", "panTile", "ridgeTile", "gableRidgeCap"],
  斗栱: ["bracketSeat", "bracketArm", "bearingBlock"],
  椽: ["rafter", "flyRafter"],
  构件分缝: [
    "roofBoard", "purlin", "beam", "kingPost", "tieBeam", "interiorPost",
    "eaveBeam", "column", "columnBase", "terrace", "step", "wall",
    "doorFrameMember", "doorLeafPanel", "doorLeafRail", "doorLeafStile",
    "latticeBar", "latticeFrameMember", "gableBoard", "eaveClosure",
    "foundationLayer", "groundLayer",
  ],
} as const;

// 质量基准 4.3 的四档。上界含本档：scale 20 落在第一档，50 落在第二档。
const BANDS: readonly {
  readonly maxScaleDenominator: number;
  readonly treatments: Readonly<Record<keyof typeof FAMILIES, DrawingDetailTreatment>>;
}[] = [
  // 1:20 及更大：瓦件断面与搭接、各构件与分件关系、单根与望板、真实断面与榫卯
  { maxScaleDenominator: 20, treatments: { 瓦面: "full", 斗栱: "full", 椽: "full", 构件分缝: "full" } },
  // 1:50：可画垄但单垄只画分界不画瓦件断面、斗栱外轮廓与主要构件、可画单根椽、主要分缝
  { maxScaleDenominator: 50, treatments: { 瓦面: "groupOutline", 斗栱: "full", 椽: "full", 构件分缝: "full" } },
  // 1:100：简化垄线、斗栱外轮廓、椽按檐口示意、主要分缝
  { maxScaleDenominator: 100, treatments: { 瓦面: "groupOutline", 斗栱: "groupOutline", 椽: "groupOutline", 构件分缝: "noJointLines" } },
  // 1:200 与 1:150：材质图例不画垄、位置示意块、不画单根椽、不画分缝
  { maxScaleDenominator: Number.POSITIVE_INFINITY, treatments: { 瓦面: "omit", 斗栱: "groupOutline", 椽: "omit", 构件分缝: "noJointLines" } },
];

// 按出图比例解析该视图的细节规则。制图矩阵携带解析结果，
// 制图侧不再需要知道比例与构件族的对应关系。
export function resolveDetailRules(scaleDenominator: number): DrawingDetailRule[] {
  const band = BANDS.find((item) => scaleDenominator <= item.maxScaleDenominator);
  if (!band) throw new Error(`DRAWING_DETAIL_BAND_NOT_FOUND:${scaleDenominator}`);
  return (Object.keys(FAMILIES) as (keyof typeof FAMILIES)[])
    .map((familyZh) => ({
      familyZh,
      componentTypes: [...FAMILIES[familyZh]],
      treatment: band.treatments[familyZh],
      minimumOnPaperSpacingMm: DETAIL_MINIMUM_ON_PAPER_SPACING_MM,
    }))
    .filter((rule) => rule.treatment !== "full");
}
