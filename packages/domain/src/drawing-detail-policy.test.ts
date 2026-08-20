import { describe, expect, it } from "vitest";

import {
  DETAIL_MINIMUM_ON_PAPER_SPACING_MM,
  DrawingDetailRuleSchema,
  resolveDetailRules,
} from "./drawing-detail-policy.js";

// 质量基准 4.3 图面细节层级。这份表是数据不是分支：制图侧只执行解析结果，
// 不认识构件名也不判断比例。测试锁的是四档取舍与三条不变量。

const treatmentOf = (scale: number, familyZh: string) =>
  resolveDetailRules(scale).find((rule) => rule.familyZh === familyZh)?.treatment ?? "full";

describe("图面细节层级", () => {
  it("1:20 及更大不做任何简化", () => {
    expect(resolveDetailRules(20)).toEqual([]);
    expect(resolveDetailRules(10)).toEqual([]);
  });

  it("1:50 瓦面只画垄分界，斗栱与椽保持逐构件", () => {
    expect(treatmentOf(50, "瓦面")).toBe("groupOutline");
    expect(treatmentOf(50, "斗栱")).toBe("full");
    expect(treatmentOf(50, "椽")).toBe("full");
  });

  it("1:100 斗栱与椽也转外轮廓，分缝线去掉", () => {
    expect(treatmentOf(100, "斗栱")).toBe("groupOutline");
    expect(treatmentOf(100, "椽")).toBe("groupOutline");
    expect(treatmentOf(100, "构件分缝")).toBe("noJointLines");
  });

  it("1:200 与 1:150 瓦面与椽改图例，斗栱只留位置示意块", () => {
    for (const scale of [150, 200]) {
      expect(treatmentOf(scale, "瓦面")).toBe("omit");
      expect(treatmentOf(scale, "椽")).toBe("omit");
      expect(treatmentOf(scale, "斗栱")).toBe("groupOutline");
    }
  });

  // 构件分缝的取舍只作用在分缝线上。取 omit 会把柱、墙、台基整个从图上删掉，
  // 而 4.3 说的是不画分缝，不是不画构件。
  it("构件分缝这一族永远不取 omit", () => {
    for (const scale of [10, 20, 50, 100, 150, 200, 500]) {
      expect(treatmentOf(scale, "构件分缝"), `1:${scale}`).not.toBe("omit");
    }
  });

  it("比例越小取舍越粗，同一族不会在更小比例上反而画得更细", () => {
    const rank = { full: 0, noJointLines: 1, groupOutline: 2, omit: 3 } as const;
    for (const familyZh of ["瓦面", "斗栱", "椽", "构件分缝"]) {
      const levels = [20, 50, 100, 200].map((scale) => rank[treatmentOf(scale, familyZh)]);
      for (let index = 1; index < levels.length; index += 1) {
        expect(levels[index]!, `${familyZh} 在 1:${[20, 50, 100, 200][index]}`).toBeGreaterThanOrEqual(levels[index - 1]!);
      }
    }
  });

  it("每条规则都带可辨间距基线并通过 schema 校验", () => {
    for (const scale of [50, 100, 200]) {
      for (const rule of resolveDetailRules(scale)) {
        expect(DrawingDetailRuleSchema.parse(rule)).toEqual(rule);
        expect(rule.minimumOnPaperSpacingMm).toBe(DETAIL_MINIMUM_ON_PAPER_SPACING_MM);
        expect(rule.componentTypes.length).toBeGreaterThan(0);
      }
    }
  });

  it("一个构件类型只归一个族，否则制图侧取到的规则取决于顺序", () => {
    const seen = new Map<string, string>();
    for (const rule of resolveDetailRules(200)) {
      for (const componentType of rule.componentTypes) {
        expect(seen.get(componentType), `${componentType} 同时属于 ${seen.get(componentType)} 与 ${rule.familyZh}`).toBeUndefined();
        seen.set(componentType, rule.familyZh);
      }
    }
  });
});
