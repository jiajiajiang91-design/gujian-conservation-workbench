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
    expect(filtered.missingInformation.join()).toContain("按排除记录的名称过滤掉 1 条");
  });

  it("没有排除记录时原样返回", () => {
    expect(dropExcluded(recognition, [])).toBe(recognition);
  });

  it("不作用于资料要点整理", () => {
    const summary = { kind: "evidenceSummary" as const, summary: "要点", findings: ["额枋"], missingInformation: [] };
    expect(dropExcluded(summary, [{ subjectDescriptionZh: "额枋" }])).toBe(summary);
  });
});

// 只按名称不够。实测三轮里模型返回的构件数是 29、38、20，同一个门廊出现
// 2 次、1 次、0 次，命名与数量每轮都变。名称对不上，排除后不再出现这个
// 承诺就落空，而落空与否靠运气。位置稳定：排除的是图上那一块。
describe("按图上位置排除", () => {
  const entities = [
    { id: "ent-1", imageRegion: { evidenceRef: "e1", x: .28, y: .08, width: .14, height: .14 } },
  ];
  const exclusions = [{ subjectDescriptionZh: "早先叫别的名字", originRef: "ent-1" }];

  it("落在被排除位置上的构件被挡下，即使名称不同", () => {
    const filtered = dropExcluded(recognition, exclusions, entities);
    if (filtered?.kind !== "componentRecognition") throw new Error("kind");
    expect(filtered.components.map((item) => item.nameZh)).toEqual(["雀替", "柱"]);
    expect(filtered.missingInformation.join()).toContain("按排除记录的图上位置过滤掉 1 条");
    // 按位置挡下的要说明是同一块地方，否则读的人不知道为什么少了一条
    expect(filtered.missingInformation.join()).toContain("落在同一块被排除的位置上");
  });

  it("不同资料上的同一坐标不算命中", () => {
    const otherEvidence = [{ id: "ent-1", imageRegion: { evidenceRef: "e2", x: .28, y: .08, width: .14, height: .14 } }];
    expect(dropExcluded(recognition, exclusions, otherEvidence)).toBe(recognition);
  });

  it("排除记录没有指向构件时只按名称判，不误伤", () => {
    expect(dropExcluded(recognition, [{ subjectDescriptionZh: "不存在的名字", originRef: null }], entities)).toBe(recognition);
  });

  it("名称与位置同时命中时分开计数，不重复扣减", () => {
    const both = dropExcluded(recognition, [
      { subjectDescriptionZh: "雀替", originRef: null },
      { subjectDescriptionZh: "早先叫别的名字", originRef: "ent-1" },
    ], entities);
    if (both?.kind !== "componentRecognition") throw new Error("kind");
    expect(both.components.map((item) => item.nameZh)).toEqual(["柱"]);
    expect(both.missingInformation.join()).toContain("按排除记录的名称过滤掉 1 条");
    expect(both.missingInformation.join()).toContain("按排除记录的图上位置过滤掉 1 条");
  });
});
