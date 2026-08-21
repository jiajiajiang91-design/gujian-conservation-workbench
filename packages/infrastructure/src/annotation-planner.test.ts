import type { ProjectHead } from "@gujian/application";
import { resolveAnnotationRules } from "@gujian/domain";
import type { ProjectDrivenGeometrySpec } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { planViewAnnotations } from "./annotation-planner.js";

// 标注规划的三条硬要求：
// 一、位置没有出处的构件不得定轴，否则是把生成器的排布显示成实测定位；
// 二、每条标注都能追到具体构件或事实；
// 三、模型标高与项目已记录尺寸对不上时并列两个数，不由制图侧选一个。

type GeometryObject = ProjectDrivenGeometrySpec["objects"][number];

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(counter += 1).padStart(12, "0")}`;

function object(input: {
  componentType: string;
  centre: [number, number, number];
  size: [number, number, number];
  positionBasis?: GeometryObject["positionBasis"];
  basis?: "measured" | "rule" | "human" | "demo";
}): GeometryObject {
  return {
    id: uuid(),
    stableKey: `${input.componentType}:${counter}`,
    parentId: null,
    componentType: input.componentType,
    displayNameZh: `${input.componentType} ${counter}`,
    materialCode: "木作",
    ...(input.positionBasis ? { positionBasis: input.positionBasis } : {}),
    solid: {
      kind: "box" as const,
      sizeX: String(input.size[0]), sizeY: String(input.size[1]), sizeZ: String(input.size[2]),
      centerMm: input.centre,
    },
    parameters: [{
      id: uuid(), name: "sizeMm", basis: input.basis ?? "measured",
      factRefs: [], evidenceRefs: [], valueType: "length" as const,
      exactValue: String(input.size[0]), unit: "mm" as const,
    }],
    producer: { producerType: "demo" as const, fixtureId: "test" },
    factRefs: [], evidenceRefs: [], unknownRefs: [],
  };
}

function spec(objects: GeometryObject[]): ProjectDrivenGeometrySpec {
  return {
    schemaVersion: "2.0", id: uuid(), projectId: uuid(), projectRevisionId: uuid(), buildingId: uuid(),
    inputHash: "0".repeat(64),
    coordinateSystem: { name: "测试", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects, interfaces: [], unknowns: [], createdAt: "2026-08-20T00:00:00.000Z",
  };
}

function head(facts: { name: string; valueMm: number; dataStatus: "available" | "uncertain" }[]): ProjectHead {
  return {
    snapshot: {
      facts: facts.map((item) => ({
        field: `documentedDimension.${item.name}`,
        value: { name: item.name, value: item.valueMm, unit: "mm" },
        dataStatus: item.dataStatus,
      })),
    },
  } as unknown as ProjectHead;
}

const planView = {
  key: "plan", kind: "floorPlan", scaleDenominator: 100,
  right: [1, 0, 0], up: [0, 1, 0], sourceEntityIds: [] as string[],
};
const elevationView = {
  key: "elevation", kind: "elevation", scaleDenominator: 50,
  right: [1, 0, 0], up: [0, 0, 1], sourceEntityIds: [] as string[],
};

describe("标注规划", () => {
  it("位置没有出处的构件不定轴", () => {
    // 两道墙有出处，四根桩没有。桩按等距排布，若参与定轴会多出四条轴线。
    const walls = [
      object({ componentType: "exteriorWall", centre: [0, 5000, 1500], size: [200, 10000, 3000], positionBasis: "measured" }),
      object({ componentType: "exteriorWall", centre: [7000, 5000, 1500], size: [200, 10000, 3000], positionBasis: "measured" }),
    ];
    const piers = [1000, 3000, 5000, 6000].map((x) =>
      object({ componentType: "foundationPier", centre: [x, 5000, -300], size: [200, 200, 400] }));
    const plan = planViewAnnotations({
      head: head([]), spec: spec([...walls, ...piers]), view: planView, allViews: [],
    });
    expect(plan.axes.map((item) => item.positionMm)).toEqual([0, 7000]);
  });

  it("轴线带出处说明，量取与实测分开写", () => {
    const walls = [
      object({ componentType: "exteriorWall", centre: [0, 5000, 1500], size: [200, 10000, 3000], positionBasis: "human", basis: "human" }),
      object({ componentType: "exteriorWall", centre: [7000, 5000, 1500], size: [200, 10000, 3000], positionBasis: "human", basis: "human" }),
    ];
    const plan = planViewAnnotations({ head: head([]), spec: spec(walls), view: planView, allViews: [] });
    expect(plan.axes[0]!.basisZh).toBe("图上量取墙心线");
  });

  it("每条标注都追得到具体构件", () => {
    const walls = [
      object({ componentType: "exteriorWall", centre: [0, 5000, 1500], size: [200, 10000, 3000], positionBasis: "measured" }),
      object({ componentType: "exteriorWall", centre: [7000, 5000, 1500], size: [200, 10000, 3000], positionBasis: "measured" }),
    ];
    const plan = planViewAnnotations({ head: head([]), spec: spec(walls), view: elevationView, allViews: [] });
    for (const axis of plan.axes) expect(axis.sourceEntityIds.length).toBeGreaterThan(0);
    for (const level of plan.levels) expect(level.sourceEntityIds.length).toBeGreaterThan(0);
    for (const label of plan.labels) expect(label.sourceEntityIds.length).toBeGreaterThan(0);
  });

  it("有写明的标高就用写明值", () => {
    const walls = [
      object({ componentType: "exteriorWall", centre: [0, 5000, 2230], size: [200, 10000, 4460], positionBasis: "measured" }),
      object({ componentType: "exteriorWall", centre: [7000, 5000, 2230], size: [200, 10000, 4460], positionBasis: "measured" }),
    ];
    const plan = planViewAnnotations({
      head: head([{ name: "eaveElevationMm", valueMm: 4400, dataStatus: "available" }]),
      spec: spec(walls), view: elevationView, allViews: [],
    });
    const eave = plan.levels.find((item) => item.label === "檐口");
    expect(eave?.elevationMm).toBe(4400);
    expect(eave?.basisZh).toBe("图纸标注");
    expect(plan.levelConflicts).toEqual([]);
  });

  it("模型标高与已记录尺寸差得过大时并列两个数，不选一个", () => {
    const walls = [
      object({ componentType: "exteriorWall", centre: [0, 5000, 2075], size: [200, 10000, 4150], positionBasis: "demo", basis: "demo" }),
      object({ componentType: "exteriorWall", centre: [7000, 5000, 2075], size: [200, 10000, 4150], positionBasis: "demo", basis: "demo" }),
    ];
    const plan = planViewAnnotations({
      head: head([{ name: "eaveHeightMm", valueMm: 5200, dataStatus: "uncertain" }]),
      spec: spec(walls), view: elevationView, allViews: [],
    });
    expect(plan.levels.find((item) => item.label === "檐口")?.elevationMm).toBe(4150);
    expect(plan.levelConflicts).toEqual([
      { labelZh: "檐口", geometryMm: 4150, documentedMm: 5200, documentedNameZh: "eaveHeightMm" },
    ]);
  });

  it("超过条数上限的按种类计丢弃数，不静默截断", () => {
    const objects = Array.from({ length: 20 }, (_unused, index) =>
      object({ componentType: `type-${index}`, centre: [index * 500, 0, 500], size: [200, 200, 1000] }));
    const plan = planViewAnnotations({ head: head([]), spec: spec(objects), view: planView, allViews: [] });
    const cap = resolveAnnotationRules("floorPlan", 100).find((rule) => rule.kind === "componentLabel")!.maxCount;
    expect(plan.labels).toHaveLength(cap);
    expect(plan.droppedByKind.componentLabel).toBe(20 - cap);
  });
});
