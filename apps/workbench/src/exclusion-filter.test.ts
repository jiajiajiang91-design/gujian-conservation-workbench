import { describe, expect, it } from "vitest";

import { dropExcluded } from "./model-run-client";

// 排除记录参与后续识别（框选修正规格第四节口径三）。
// 只作用于构件识别：另两个任务的产出是文字要点与尺寸，没有构件可对应，
// 硬套一层过滤只会让人以为过滤生效了。

const recognition = {
  kind: "componentRecognition" as const,
  summary: "认出三个构件",
  components: [
    { nameZh: "雀替", categoryZh: null, evidenceRef: "e1", region: { x: .1, y: .1, width: .1, height: .1 }, certainty: "certain" as const, noteZh: null },
    { nameZh: "额枋", categoryZh: null, evidenceRef: "e1", region: { x: .3, y: .1, width: .1, height: .1 }, certainty: "certain" as const, noteZh: null },
    { nameZh: "柱", categoryZh: null, evidenceRef: "e1", region: { x: .5, y: .1, width: .1, height: .1 }, certainty: "certain" as const, noteZh: null },
  ],
  missingInformation: [],
};

describe("排除记录过滤", () => {
  it("已排除的构件不再进候选，并写明过滤了几条", () => {
    const filtered = dropExcluded(recognition, [{ subjectDescriptionZh: "额枋" }]);
    expect(filtered?.kind).toBe("componentRecognition");
    if (filtered?.kind !== "componentRecognition") return;
    expect(filtered.components.map((item) => item.nameZh)).toEqual(["雀替", "柱"]);
    expect(filtered.missingInformation.join()).toContain("过滤掉 1 条");
  });

  it("没有排除记录时原样返回", () => {
    expect(dropExcluded(recognition, [])).toBe(recognition);
  });

  it("不作用于资料要点整理", () => {
    const summary = { kind: "evidenceSummary" as const, summary: "要点", findings: ["额枋"], missingInformation: [] };
    expect(dropExcluded(summary, [{ subjectDescriptionZh: "额枋" }])).toBe(summary);
  });
});
