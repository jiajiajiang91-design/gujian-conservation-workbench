import type { RuleDataFile, RuleSpec } from "@gujian/domain";

// 规则数据文件：单一对象字面量，专业人员逐条审阅，不含任何逻辑。
// 加载入口 rule-engine.ts 的 loadRuleData 在运行时做 Zod 校验并计算内容哈希。
// 公式中的标识符先取基准参数，再取同规则集内其他规则的 ruleId 结果。
//
// 出处口径：本文件所有数值均为转引，来源见 文档/06_研究底稿/02_开源技术借鉴.md
// 第 4.1 与 4.2 节对 ssffd/jiangshu 与 yxk925/ACA-Builder 的整理。该节同时
// 记明 jiangshu 只覆盖清式无斗栱小式、数值不可照搬，因此本规则集只用于生成
// 规范选择停靠的并列方案，未验证对本项目任一样本的适用性。
//
// 每套规则集是一份完整的形制依据，差别在举架系数来源。构件比例规则两套相同，
// 因为选规则集选的是整套依据，不是只选举架那一项（archetype-derivation.ts
// 按 liftRatioSetRef 只取一套求值）。

// 有可引用数值出处的构件比例规则。没有出处的维度一律 byMeasurement，
// 不填默认数字：编造比例比留空更难被发现，也更难被专业人员纠正。
const CITED_COMPONENT_RULES: readonly RuleSpec[] = [
  {
    ruleId: "eaveColumnDiameter",
    subjectConceptRef: "eave-column",
    dimension: "檐柱径",
    formula: "eaveColumnHeightMm / 11",
    baseParams: ["eaveColumnHeightMm"],
    tolerance: { kind: "ratio", value: "0.05" },
    sourceText: "由檐柱高 = 11 倍柱径反推（jiangshu formulas.json 檐柱 height: 11*D）",
    deviation: null,
    applicability: { scale: "minor" },
  },
  {
    ruleId: "eaveStepSpan",
    subjectConceptRef: "roof-frame",
    dimension: "大式檐步架",
    formula: "eaveColumnDiameter * 4",
    baseParams: [],
    tolerance: { kind: "ratio", value: "0.25" },
    sourceText: "大式檐步架 = 4 倍檐柱径（jiangshu JiangSuan v1.0 举架算法）",
    deviation: { valueText: "5 倍檐柱径", reasonZh: "同一算法记 4 或 5 两个取值，取小值，大值作为并列方案备查" },
    applicability: { scale: "major" },
  },
  {
    ruleId: "goldColumnHeight",
    subjectConceptRef: "gold-column",
    dimension: "金柱高",
    formula: "eaveColumnHeightMm + 5 * corridorStepSpanMm",
    baseParams: ["eaveColumnHeightMm", "corridorStepSpanMm"],
    tolerance: { kind: "ratio", value: "0.05" },
    sourceText: "金柱高 = 檐柱高 + 5 倍廊步架（jiangshu formulas.json 跨构件引用式）",
    deviation: null,
    applicability: null,
  },
  {
    ruleId: "singleStepBeamWidth",
    subjectConceptRef: "single-step-beam",
    dimension: "单步梁宽",
    formula: "doubleStepBeamWidthMm * 4 / 5",
    baseParams: ["doubleStepBeamWidthMm"],
    tolerance: { kind: "ratio", value: "0.05" },
    sourceText: "单步梁宽 = 4/5 双步梁宽（jiangshu formulas.json）",
    deviation: null,
    applicability: null,
  },
  {
    ruleId: "middleSillHeight",
    subjectConceptRef: "door-frame",
    dimension: "中槛高",
    formula: "eaveColumnDiameter * 0.5",
    baseParams: [],
    tolerance: { kind: "ratio", value: "0.3" },
    sourceText: "中槛高 = 0.5 柱径（ACA-Builder const.py 取值）",
    deviation: { valueText: "0.64 柱径", reasonZh: "汤崇平书 p20 定为 0.64，同一常数存在并列文献取值，容差按两值差额放宽" },
    applicability: null,
  },
  {
    ruleId: "doorFrameWidth",
    subjectConceptRef: "door-frame",
    dimension: "抱框宽",
    formula: "eaveColumnDiameter * 2 / 3",
    baseParams: [],
    tolerance: { kind: "ratio", value: "0.2" },
    sourceText: "抱框宽 = 2/3 柱径（梁思成与马炳坚取值，转引自 ACA-Builder const.py）",
    deviation: { valueText: "0.64 或 0.56 柱径", reasonZh: "汤崇平给 0.64，姜振鹏给 0.56，三家不一致，取梁马值并记录另两个" },
    applicability: null,
  },
];

// 没有可引用出处的维度。标按实计后求值器映射为未知项，界面显示为待补测，
// 不会得到一个看起来可信的数字。补出处后逐条改为公式即可，不必改代码。
const BY_MEASUREMENT_RULES: readonly RuleSpec[] = [
  ["terraceHeight", "terrace", "台基高", "台基高比例未见可引用文献取值，按实计"],
  ["terraceProjection", "terrace", "台基挑出", "台基挑出比例未见可引用文献取值，按实计"],
  ["columnBaseHeight", "column-base", "柱础高", "柱础高比例未见可引用文献取值，按实计"],
  ["bracketModule", "bracket-set", "斗口", "斗口为大式模数根，须由斗栱实测或形制定级确定，不由其他尺寸反推"],
  ["purlinDiameter", "purlin", "檩径", "檩径比例未见可引用文献取值，按实计"],
  ["rafterDiameter", "rafter", "椽径", "椽径比例未见可引用文献取值，按实计"],
  ["rafterSpacing", "rafter", "椽档", "椽档比例未见可引用文献取值，按实计"],
  ["tileCourseWidth", "pan-tile", "瓦垄宽", "瓦垄宽随瓦件规格，须按实测瓦件定，不由开间反推"],
  ["eaveProjection", "eave", "檐出", "檐出比例随斗栱出跳与椽长，未见可直接引用的单一取值，按实计"],
].map(([ruleId, subjectConceptRef, dimension, sourceText]) => ({
  ruleId: ruleId!,
  subjectConceptRef: subjectConceptRef!,
  dimension: dimension!,
  formula: "byMeasurement",
  baseParams: [],
  tolerance: null,
  sourceText: sourceText!,
  deviation: null,
  applicability: null,
} satisfies RuleSpec));

// 举架系数序列。逐架系数按文献给的档数写足，实际用到几架由形制参数的步架数
// 决定，多出的档不参与推导（见 archetype-derivation.ts 的按段数裁剪）。
function liftRules(ratios: readonly number[], sourceLabel: string): RuleSpec[] {
  const names = ["檐步", "金步", "上金步", "脊步", "第五步", "第六步"];
  return ratios.map((ratio, index) => ({
    ruleId: `lift${index + 1}`,
    subjectConceptRef: "roof-frame",
    dimension: `${names[index] ?? `第${index + 1}步`}举高`,
    formula: `stepSpan * ${ratio}`,
    baseParams: [],
    tolerance: { kind: "ratio", value: "0.05" },
    sourceText: `${ratio * 10} 举（${sourceLabel}第 ${index + 1} 架）`,
    deviation: null,
    applicability: null,
  } satisfies RuleSpec));
}

const STEP_SPAN_RULE: RuleSpec = {
  ruleId: "stepSpan",
  subjectConceptRef: "roof-frame",
  dimension: "均分步架",
  formula: "totalDepthMm / 2 / stepCount",
  baseParams: ["totalDepthMm", "stepCount"],
  tolerance: null,
  sourceText: "步架 =（通进深 / 2）/ 步架数（jiangshu JiangSuan v1.0 举架算法）",
  deviation: null,
  applicability: null,
};

const EAVE_COLUMN_HEIGHT_RULE: RuleSpec = {
  ruleId: "eaveColumnHeight",
  subjectConceptRef: "eave-column",
  dimension: "檐柱高",
  formula: "byMeasurement",
  baseParams: [],
  tolerance: null,
  sourceText: "檐柱高按实计（jiangshu formulas.json 的按实计模式）",
  deviation: null,
  applicability: null,
};

function ruleSet(ruleSetId: string, sourceText: string, ratios: readonly number[], sourceLabel: string) {
  return {
    schemaVersion: "rule-spec-1" as const,
    ruleSetId,
    sourceText,
    version: "1.1.0",
    rules: [
      STEP_SPAN_RULE,
      ...liftRules(ratios, sourceLabel),
      EAVE_COLUMN_HEIGHT_RULE,
      ...CITED_COMPONENT_RULES,
      ...BY_MEASUREMENT_RULES,
    ],
  };
}

export const HERITAGE_BASELINE_RULE_DATA = {
  schemaVersion: "rule-data-1",
  dataSetId: "heritage-baseline",
  version: "1.1.0",
  programParams: {
    // 尺寸链核对容差：总尺寸与分段之和的允许偏差（workflow 尺寸链规则消费）
    dimensionChainToleranceMm: "1",
  },
  modificationCheck: {
    magnitudeBand: { minRatio: 0.5, maxRatio: 2 },
    anchorPart: "檐柱高",
    mustExceedAnchor: ["檐口高"],
    mustStayBelowAnchor: ["台基"],
    estimateMarkPattern: "（估）|\\(估\\)",
    measurementMatchToleranceMm: 1,
  },
  ruleSets: [
    ruleSet(
      "liang-drawings",
      "梁思成图纸中采用的举架系数（转引自 ACA-Builder const.py LIFT_RATIO_DEFAULT 注释）",
      [0.5, 0.7, 0.8, 0.9],
      "梁思成图纸系数组",
    ),
    ruleSet(
      "qing-gongcheng-zuofa",
      "清工程做法则例推荐的举架系数（转引自 ACA-Builder const.py LIFT_RATIO_SMALL 注释）",
      [0.5, 0.65, 0.75, 0.9],
      "清工程做法则例系数组",
    ),
  ],
} satisfies RuleDataFile;
