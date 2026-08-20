import { describe, expect, it } from "vitest";

import { generateTimberFrame } from "./generate.js";
import type { PlanRect, SourcedDimension, TimberFrameForm } from "./types.js";

// 这条生成器的硬要求：图纸标注与图上量取分开标、图纸没给的部位记未知项、
// 同一输入重复生成结果一致。它不做形制推算，因此不该出现任何输入里没有的尺寸。

function drawn(valueMm: number): SourcedDimension {
  return { valueMm, source: "drawn", methodZh: "图纸标注", evidenceRefs: ["evidence:sheet"], factRefs: ["fact:sheet"] };
}

function scaled(valueMm: number): SourcedDimension {
  return { valueMm, source: "scaled", methodZh: "图上量取", evidenceRefs: ["evidence:sheet"], factRefs: [] };
}

function rect(key: string, level: PlanRect["level"], box: [number, number, number, number]): PlanRect {
  return { key, displayNameZh: key, level, fromXMm: box[0], toXMm: box[1], fromYMm: box[2], toYMm: box[3] };
}

function form(overrides: Partial<TimberFrameForm> = {}): TimberFrameForm {
  return {
    width: drawn(7315),
    depth: drawn(18466),
    wallThickness: scaled(140),
    eaveElevation: scaled(4460),
    ridgeElevation: drawn(5944),
    secondFloorElevation: scaled(4130),
    floorAboveGrade: scaled(640),
    floorStructureDepth: scaled(200),
    roofThickness: scaled(60),
    eaveOverhang: scaled(280),
    gableOverhang: scaled(280),
    girderDepth: scaled(200),
    pierSize: scaled(200),
    pierSpacing: scaled(2400),
    monitors: [{
      key: "monitor/west",
      fromX: scaled(2083), toX: scaled(5054), startY: scaled(1067), endY: scaled(3708), rise: scaled(790),
    }],
    canopies: [{
      key: "canopy/walk", displayNameZh: "覆盖步道顶棚",
      fromX: scaled(-2489), toX: scaled(9677), fromY: scaled(-2286), toY: scaled(0),
      elevation: scaled(3610), thickness: scaled(100),
      postXs: [scaled(-2510), scaled(50)], postSize: scaled(150),
    }],
    planScaled: scaled(0),
    partitionThickness: scaled(120),
    partitions: [rect("toilet-east", "first", [1600, 1720, 16000, 18466])],
    secondFloorDecks: [rect("south-rooms", "second", [0, 7315, 16078, 18466])],
    materials: {
      pier: "木作", girder: "木作", floorStructure: "木作", wall: "木作", gableWall: "木作",
      partition: "木作", roofPlane: "金属板", monitorWall: "木作", monitorRoof: "金属板",
      canopy: "木作", canopyPost: "木作",
    },
    ...overrides,
  };
}

const input = { producer: { producerType: "demo" as const, fixtureId: "test" }, evidenceRefs: ["evidence:form"], keyPrefix: "t" };

describe("generateTimberFrame", () => {
  it("图纸标注标为实测，图上量取标为人工，两者不混", () => {
    const result = generateTimberFrame({ form: form(), ...input });
    const ridge = result.objects
      .flatMap((item) => item.parameters)
      .filter((item) => item.name === "ridgeElevationMm");
    expect(ridge.length).toBeGreaterThan(0);
    expect(new Set(ridge.map((item) => item.basis))).toEqual(new Set(["measured"]));
    const eave = result.objects
      .flatMap((item) => item.parameters)
      .filter((item) => item.name === "heightMm");
    expect(new Set(eave.map((item) => item.basis))).toEqual(new Set(["human"]));
  });

  it("构件的每个尺寸参数都能追到输入里的某一条来源", () => {
    const result = generateTimberFrame({ form: form(), ...input });
    const declared = new Set([
      7315, 18466, 140, 4460, 5944, 4130, 640, 200, 60, 280, 120, 2400,
      3610, 100, 150, 790, 2083, 5054, 1067, 3708, 9677, 0,
    ]);
    for (const object of result.objects) {
      for (const parameter of object.parameters) {
        if (parameter.valueType !== "length") continue;
        // 平面矩形的坐标是量取值本身，其余尺寸必须出自声明过的那批数
        const value = Math.abs(Number(parameter.exactValue));
        const fromPlan = ["fromXMm", "toXMm", "fromYMm", "toYMm"].includes(parameter.name);
        if (!fromPlan) expect(declared.has(value), `${object.stableKey}.${parameter.name}=${value}`).toBe(true);
      }
    }
  });

  it("图纸读不出的部位逐条记未知项，并挂到相关构件上", () => {
    const result = generateTimberFrame({ form: form(), ...input });
    const codes = result.unknowns.map((item) => item.reasonCode);
    expect(codes).toContain("FOUNDATION_LAYOUT_NOT_DOCUMENTED");
    expect(codes).toContain("OPENINGS_NOT_DIMENSIONED");
    expect(codes).toContain("ROOF_SLOPE_DERIVED_FROM_SCALED_EAVE");
    for (const unknown of result.unknowns) {
      expect(unknown.requiredEvidence.length).toBeGreaterThan(0);
      expect(unknown.blocksFormalEligibility).toBe(true);
    }
    const referenced = new Set(result.objects.flatMap((item) => item.unknownRefs));
    expect(referenced.size).toBeGreaterThan(0);
  });

  it("同一输入重复生成得到相同的标识与几何", () => {
    const first = generateTimberFrame({ form: form(), ...input });
    const second = generateTimberFrame({ form: form(), ...input });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("二层只在声明的楼板范围铺板，其余不补", () => {
    const result = generateTimberFrame({ form: form(), ...input });
    const decks = result.objects.filter((item) => item.stableKey.startsWith("floor/second/"));
    expect(decks).toHaveLength(1);
    expect(decks[0]!.solid.kind).toBe("box");
  });

  it("屋脊低于檐口时直接报错，不生成倒挂的屋面", () => {
    expect(() => generateTimberFrame({ form: form({ ridgeElevation: drawn(3000) }), ...input }))
      .toThrow("TIMBER_FRAME_RIDGE_NOT_ABOVE_EAVE");
  });
});
