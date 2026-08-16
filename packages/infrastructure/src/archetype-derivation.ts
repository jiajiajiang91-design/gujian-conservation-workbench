import {
  parseFangNet,
  parsePillarNet,
  type ArchetypeSpec,
  type FactEnvelope,
} from "@gujian/domain";

import { evaluateRuleSet, loadRuleData, type RuleEvaluationOutcome } from "./rule-engine.js";
import { HERITAGE_BASELINE_RULE_DATA } from "./rules/heritage-baseline-v1.js";

// 应然值派生（架构 v1.4 §5.7）：从形制参数与规则集推导应然尺寸与布局摘要，
// 与实测事实逐项对照。派生结果来源为 rule，展示与留痕经 RuleRun；
// 应然值不覆盖实测，无实测项如实显示"无实测记录"。

export interface ExpectedDimension {
  readonly dimension: string;
  readonly valueMm: number | null;
  readonly status: "computed" | "unknown";
  readonly toleranceText: string | null;
  readonly sourceText: string;
}

export interface DimensionComparison extends ExpectedDimension {
  readonly measuredMm: number | null;
  readonly deltaMm: number | null;
  readonly withinTolerance: boolean | null;
}

export interface ArchetypeDerivation {
  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
  readonly expected: readonly ExpectedDimension[];
  readonly layout: {
    readonly pillarCount: number;
    readonly fangCount: number;
    readonly bayTotals: readonly { direction: "x" | "y"; totalMm: number; bayCount: number }[];
  };
}

const RULE_DATA = loadRuleData(HERITAGE_BASELINE_RULE_DATA);

function toExpected(outcome: RuleEvaluationOutcome): ExpectedDimension {
  return {
    dimension: outcome.dimension,
    valueMm: outcome.valueMm,
    status: outcome.status,
    toleranceText: outcome.toleranceText,
    sourceText: outcome.sourceText,
  };
}

export function deriveArchetypeExpectations(spec: ArchetypeSpec): ArchetypeDerivation {
  const ruleSet = RULE_DATA.data.ruleSets.find((set) => set.ruleSetId === spec.liftRatioSetRef)
    ?? RULE_DATA.data.ruleSets[0]!;
  const bayTotals = spec.bayDimensions.map((bay) => ({
    direction: bay.direction,
    totalMm: bay.valuesMm.reduce((sum, value) => sum + Number(value), 0),
    bayCount: bay.valuesMm.length,
  }));
  const depthTotal = bayTotals.find((bay) => bay.direction === "y")?.totalMm ?? bayTotals[0]!.totalMm;
  const params: Record<string, number> = {
    totalDepthMm: depthTotal,
    stepCount: spec.stepCount,
  };
  for (const [name, value] of Object.entries(spec.baseParams)) params[name] = Number(value);
  const evaluation = evaluateRuleSet(ruleSet, params);
  const bayExpectations: ExpectedDimension[] = bayTotals.map((bay) => ({
    dimension: bay.direction === "x" ? "通面阔" : "通进深",
    valueMm: bay.totalMm,
    status: "computed",
    toleranceText: null,
    sourceText: `形制模板逐间尺寸合计（${bay.bayCount} 间）`,
  }));
  return {
    ruleSetId: ruleSet.ruleSetId,
    ruleSetVersion: RULE_DATA.ruleSetVersion,
    expected: [...bayExpectations, ...evaluation.results.map(toExpected)],
    layout: {
      pillarCount: parsePillarNet(spec.pillarNet).length,
      fangCount: spec.fangNet ? parseFangNet(spec.fangNet).length : 0,
      bayTotals,
    },
  };
}

// 与实测事实对照：按维度名匹配已确认可用的数值事实；
// 无匹配实测项时 measuredMm 为 null，不用应然值补齐。
export function compareWithMeasuredFacts(
  derivation: ArchetypeDerivation,
  facts: readonly FactEnvelope[],
): DimensionComparison[] {
  const measured = new Map<string, number>();
  for (const fact of facts) {
    if (fact.reviewStatus !== "confirmed" || fact.dataStatus !== "available") continue;
    if (typeof fact.value !== "number" || !Number.isFinite(fact.value)) continue;
    measured.set(fact.field, fact.value);
  }
  return derivation.expected.map((item) => {
    const measuredMm = measured.get(`archetype.measured.${item.dimension}`) ?? null;
    if (item.valueMm === null || measuredMm === null) {
      return { ...item, measuredMm, deltaMm: null, withinTolerance: null };
    }
    const deltaMm = Math.round((measuredMm - item.valueMm) * 1000) / 1000;
    let withinTolerance: boolean | null = null;
    if (item.toleranceText) {
      const ratioMatch = /比例 ([\d.]+)/.exec(item.toleranceText);
      const absoluteMatch = /^±([\d.]+)mm$/.exec(item.toleranceText);
      const band = ratioMatch ? Number(ratioMatch[1]) * item.valueMm : absoluteMatch ? Number(absoluteMatch[1]) : null;
      withinTolerance = band === null ? null : Math.abs(deltaMm) <= band;
    }
    return { ...item, measuredMm, deltaMm, withinTolerance };
  });
}
