import { ArchetypeSpecSchema, parseFangNet, parsePillarNet, type ArchetypeSpec, type FactEnvelope } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { compareWithMeasuredFacts, deriveArchetypeExpectations } from "./archetype-derivation.js";
import { recordHash } from "./hash.js";

// 团队演示项目 fixture r2 的形制口径：面阔 4800、进深 3600、7 檩（步架数 3）
function r2Spec(): ArchetypeSpec {
  return ArchetypeSpecSchema.parse({
    id: "3b241101-e2bb-4255-8caf-4136c566a962",
    projectId: "2fa4684c-f640-5c45-99cd-407305343f3f",
    buildingRef: "d2511b25-9b51-562d-bb39-a05305712053",
    baseParams: { D: "380" },
    bayDimensions: [
      { direction: "x", valuesMm: ["4800"] },
      { direction: "y", valuesMm: ["1800", "1800"] },
    ],
    liftRatioSetRef: "qing-gongcheng-zuofa",
    stepCount: 3,
    pillarNet: "0/0,0/1,1/0,1/1",
    fangNet: "0/0#1/0,0/1#1/1,0/0#0/1,1/0#1/1",
    sourceDeclaration: "团队演示 fixture r2 形制口径，仅用于工程链验证",
    producer: { producerType: "demo", fixtureId: "v3-reviewed-team-demo-r2" },
    createdAt: "2026-08-16T00:00:00Z",
  });
}

describe("形制参数派生", () => {
  it("网表解析出柱位与枋连接", () => {
    expect(parsePillarNet("0/0,0/1,1/0,1/1")).toHaveLength(4);
    expect(parseFangNet("0/0#1/0,0/1#1/1")).toEqual([
      { from: { column: 0, row: 0 }, to: { column: 1, row: 0 } },
      { from: { column: 0, row: 1 }, to: { column: 1, row: 1 } },
    ]);
  });

  it("按所选规则集派生应然值：清做法系数组", () => {
    const derivation = deriveArchetypeExpectations(r2Spec());
    expect(derivation.ruleSetId).toBe("qing-gongcheng-zuofa");
    expect(derivation.layout).toMatchObject({ pillarCount: 4, fangCount: 4 });
    const byDimension = new Map(derivation.expected.map((item) => [item.dimension, item]));
    expect(byDimension.get("通面阔")?.valueMm).toBe(4800);
    expect(byDimension.get("通进深")?.valueMm).toBe(3600);
    expect(byDimension.get("均分步架")?.valueMm).toBe(600);
    expect(byDimension.get("金步举高")?.valueMm).toBe(390);
    expect(byDimension.get("檐柱高")).toMatchObject({ status: "unknown", valueMm: null });
    expect(byDimension.get("金步举高")?.sourceText).toContain("清工程做法");
  });

  it("派生确定性：同输入同输出哈希", () => {
    const first = deriveArchetypeExpectations(r2Spec());
    const second = deriveArchetypeExpectations(r2Spec());
    expect(recordHash(second)).toBe(recordHash(first));
  });

  it("实测对照：有实测算差值并判容差，无实测不补齐", () => {
    const derivation = deriveArchetypeExpectations(r2Spec());
    const facts = [
      {
        id: "8f14e45f-ceea-467f-aaa5-e07fc1f90ae7", subjectRef: "building", field: "archetype.measured.金步举高",
        value: 402, producer: { producerType: "human", actorId: "3b241101-e2bb-4255-8caf-4136c566a962", actionRef: { commandId: "3b241101-e2bb-4255-8caf-4136c566a962" } },
        evidenceRefs: [], reviewStatus: "confirmed", dataStatus: "available",
      },
    ] as unknown as FactEnvelope[];
    const comparisons = compareWithMeasuredFacts(derivation, facts);
    const lift = comparisons.find((item) => item.dimension === "金步举高");
    expect(lift).toMatchObject({ measuredMm: 402, deltaMm: 12, withinTolerance: true });
    const span = comparisons.find((item) => item.dimension === "均分步架");
    expect(span).toMatchObject({ measuredMm: null, deltaMm: null, withinTolerance: null });
  });
});

function specWithSteps(stepCount: number): ArchetypeSpec {
  return ArchetypeSpecSchema.parse({ ...r2Spec(), stepCount });
}

// 举架系数按文献档数写足，用到几架由步架数决定。
// 不裁剪会让七檩填 3 仍输出四段举高，凭空多出本建筑没有的步架。
describe("举高按步架数裁剪", () => {
  const liftCount = (derivation: { expected: readonly { dimension: string }[] }) =>
    derivation.expected.filter((item) => item.dimension.endsWith("举高")).length;

  it("步架数少于文献档数时只出对应段", () => {
    const derivation = deriveArchetypeExpectations(specWithSteps(3));
    expect(liftCount(derivation)).toBe(3);
    expect(derivation.expected.some((item) => item.dimension === "脊步举高")).toBe(false);
  });

  it("步架数等于文献档数时四段齐全", () => {
    expect(liftCount(deriveArchetypeExpectations(specWithSteps(4)))).toBe(4);
  });

  it("步架数超出文献档数时缺的段标未知，不外推系数", () => {
    const derivation = deriveArchetypeExpectations(specWithSteps(6));
    expect(liftCount(derivation)).toBe(6);
    const extra = derivation.expected.filter((item) => item.dimension.endsWith("举高") && item.status === "unknown");
    expect(extra).toHaveLength(2);
    expect(extra[0]?.valueMm).toBeNull();
    expect(extra[0]?.sourceText).toContain("按实计");
  });
});

// 没有可引用出处的维度必须留空，编造比例比留空更难被专业人员纠正。
describe("无出处维度按实计", () => {
  it("台基、柱础、椽檩、瓦作、斗口都是未知项而不是数字", () => {
    const derivation = deriveArchetypeExpectations(specWithSteps(4));
    for (const dimension of ["台基高", "柱础高", "檩径", "椽径", "瓦垄宽", "斗口"]) {
      const found = derivation.expected.find((item) => item.dimension === dimension);
      expect(found, dimension).toBeDefined();
      expect(found?.status, dimension).toBe("unknown");
      expect(found?.valueMm, dimension).toBeNull();
    }
  });
});
