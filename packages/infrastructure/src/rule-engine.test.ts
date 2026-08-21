import { describe, expect, it } from "vitest";
import { RuleDataFileSchema, type RuleSpecFile } from "@gujian/domain";

import {
  RuleCycleError,
  RuleFormulaError,
  evaluateOptionSets,
  evaluateRuleSet,
  formulaIdentifiers,
  loadRuleData,
} from "./rule-engine.js";
import { HERITAGE_BASELINE_RULE_DATA } from "./rules/heritage-baseline-v1.js";

function ruleSet(rules: RuleSpecFile["rules"]): RuleSpecFile {
  return { schemaVersion: "rule-spec-1", ruleSetId: "test-set", sourceText: "测试规则集", version: "0.0.1", rules };
}

const baseRule = {
  subjectConceptRef: "concept:test",
  tolerance: null,
  sourceText: "测试出处",
  deviation: null,
  applicability: null,
} as const;

describe("规则数据文件", () => {
  it("基线数据通过全表校验且版本绑定内容哈希", () => {
    const loaded = loadRuleData(HERITAGE_BASELINE_RULE_DATA);
    expect(loaded.data.ruleSets).toHaveLength(2);
    expect(loaded.ruleSetVersion).toMatch(/^heritage-baseline-1\.1\.0@[0-9a-f]{16}$/);
    expect(loadRuleData(HERITAGE_BASELINE_RULE_DATA).ruleSetVersion).toBe(loaded.ruleSetVersion);
  });

  it("每条公式的标识符都能在基准参数或同集规则中解析", () => {
    for (const set of HERITAGE_BASELINE_RULE_DATA.ruleSets) {
      const ruleIds = new Set<string>(set.rules.map((rule) => rule.ruleId));
      for (const rule of set.rules) {
        for (const identifier of formulaIdentifiers(rule.formula)) {
          const resolvable = (rule.baseParams as readonly string[]).includes(identifier) || ruleIds.has(identifier);
          expect(resolvable, `${set.ruleSetId}/${rule.ruleId} 引用了未声明的 ${identifier}`).toBe(true);
        }
      }
    }
  });

  it("非法数据被拒绝", () => {
    expect(() => RuleDataFileSchema.parse({ schemaVersion: "rule-data-1" })).toThrow();
  });
});

describe("公式求值", () => {
  it("求值基准参数公式（含 11*D 样例）", () => {
    const set = ruleSet([{ ...baseRule, ruleId: "columnHeight", dimension: "柱高", formula: "11*D", baseParams: ["D"] }]);
    const [result] = evaluateRuleSet(set, { D: 300 }).results;
    expect(result).toMatchObject({ status: "computed", valueMm: 3300 });
  });

  it("跨规则引用按依赖顺序求值", () => {
    const set = ruleSet([
      { ...baseRule, ruleId: "derived", dimension: "派生", formula: "base + 5", baseParams: [] },
      { ...baseRule, ruleId: "base", dimension: "基准", formula: "totalMm / 2", baseParams: ["totalMm"] },
    ]);
    const evaluation = evaluateRuleSet(set, { totalMm: 6000 });
    expect(evaluation.results.find((r) => r.ruleId === "base")?.valueMm).toBe(3000);
    expect(evaluation.results.find((r) => r.ruleId === "derived")?.valueMm).toBe(3005);
  });

  it("循环依赖拒绝并报出路径", () => {
    const set = ruleSet([
      { ...baseRule, ruleId: "a", dimension: "甲", formula: "b + 1", baseParams: [] },
      { ...baseRule, ruleId: "b", dimension: "乙", formula: "a + 1", baseParams: [] },
    ]);
    expect(() => evaluateRuleSet(set, {})).toThrow(RuleCycleError);
  });

  it("按实计与缺失参数映射为未知，不写默认值", () => {
    const set = ruleSet([
      { ...baseRule, ruleId: "measured", dimension: "按实计项", formula: "byMeasurement", baseParams: [] },
      { ...baseRule, ruleId: "needsParam", dimension: "缺参数项", formula: "missingParam * 2", baseParams: ["missingParam"] },
    ]);
    const evaluation = evaluateRuleSet(set, {});
    expect(evaluation.results[0]).toMatchObject({ status: "unknown", unknownReason: "byMeasurement", valueMm: null });
    expect(evaluation.results[1]).toMatchObject({ status: "unknown", unknownReason: "missingParam" });
    expect(evaluation.results[1]?.missingParams).toContain("missingParam");
  });

  it("非法字符与结构错误抛公式错误", () => {
    const bad = ruleSet([{ ...baseRule, ruleId: "bad", dimension: "坏", formula: "1 ; 2", baseParams: [] }]);
    expect(() => evaluateRuleSet(bad, {})).toThrow(RuleFormulaError);
  });
});

describe("多规范并存方案", () => {
  it("两套举架系数对同一输入输出不同方案且各带出处", () => {
    const options = evaluateOptionSets(HERITAGE_BASELINE_RULE_DATA, { totalDepthMm: 6000, stepCount: 3 });
    expect(options).toHaveLength(2);
    const liang = options.find((o) => o.ruleSetId === "liang-drawings")!;
    const qing = options.find((o) => o.ruleSetId === "qing-gongcheng-zuofa")!;
    const liftSecond = (evaluation: typeof liang) => evaluation.results.find((r) => r.ruleId === "lift2")!;
    expect(liftSecond(liang).valueMm).toBe(700);
    expect(liftSecond(qing).valueMm).toBe(650);
    expect(liftSecond(liang).sourceText).toContain("梁思成");
    expect(liftSecond(qing).sourceText).toContain("清工程做法");
    expect(qing.results.find((r) => r.ruleId === "eaveColumnHeight")).toMatchObject({ status: "unknown", unknownReason: "byMeasurement" });
  });
});
