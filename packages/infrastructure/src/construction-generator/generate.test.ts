import { ProjectDrivenGeometrySpecSchema } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { generateConstruction } from "./generate.js";
import type { BuildingForm, ModularSystem, SourcedLength } from "./types.js";

// 生成器的三条硬要求：分部齐全、尺寸只来自输入、同一输入重复生成结果一致。

const QING: ModularSystem = {
  ruleSetId: "qing-gongcheng-zuofa",
  labelZh: "清式斗口制",
  moduleMm: 60,
  moduleNameZh: "斗口",
  sourceText: "清工程做法则例斗口制",
};

const SONG: ModularSystem = {
  ruleSetId: "song-yingzao-fashi",
  labelZh: "宋材份制",
  moduleMm: 16.5,
  moduleNameZh: "分",
  sourceText: "营造法式材份制",
};

function length(valueMm: number, basis: SourcedLength["basis"] = "rule"): SourcedLength {
  return { valueMm, basis, factRefs: [`fact:${basis}:${valueMm}`], evidenceRefs: ["evidence:form"] };
}

// 高都玉皇庙主殿的照片估算与规则推算尺寸
function gaoduForm(overrides: Partial<BuildingForm> = {}): BuildingForm {
  return {
    modular: QING,
    bayWidthsMm: [length(3000, "demo"), length(3600, "demo"), length(3000, "demo")],
    stepSpansMm: [length(1600), length(1600), length(1600)],
    liftHeightsMm: [length(800), length(1040), length(1200)],
    terraceHeight: length(500, "demo"),
    terraceProjection: length(1200, "demo"),
    stairTreadCount: 3,
    stairWidth: length(2000, "demo"),
    columnBaseHeight: length(250, "demo"),
    columnHeight: length(3400, "demo"),
    columnSize: length(380, "demo"),
    columnSection: "square",
    architraveHeight: length(700, "demo"),
    architraveThickness: length(240),
    beamSectionsMm: [
      { width: length(380, "demo"), height: length(480, "demo") },
      { width: length(320, "demo"), height: length(420, "demo") },
      { width: length(260, "demo"), height: length(360, "demo") },
    ],
    bracketLayerHeight: length(900, "demo"),
    bracketSetsPerBay: 4,
    purlinDiameter: length(220),
    rafterDiameter: length(90),
    rafterSpacing: length(300),
    roofBoardThickness: length(25),
    eaveProjection: length(1200, "demo"),
    tileCourseWidth: length(200),
    tileThickness: length(18),
    ridgeHeight: length(600, "demo"),
    enclosure: { front: "open", sides: "walled", back: "walled" },
    gable: null,
    flyRafter: null,
    materials: {
      terrace: "stone", stair: "stone", columnBase: "stone", column: "stone",
      architrave: "timber", beam: "timber", kingPost: "timber",
      bracket: "timber", purlin: "timber", rafter: "timber",
      roofBoard: "timber", tile: "ceramic", ridge: "ceramic", wall: "brick",
      gable: "timber", flyRafter: "timber",
    },
    ...overrides,
  };
}

function generate(form: BuildingForm = gaoduForm()) {
  return generateConstruction({
    form,
    producer: { producerType: "demo", fixtureId: "test-form" },
    formEvidenceRefs: ["evidence:photo-record"],
    keyPrefix: "test",
  });
}

describe("形制驱动的构件生成", () => {
  it("质量基准 3.1 的各部位都有构件", () => {
    const result = generate();
    for (const type of [
      "terrace", "step", "columnBase", "column", "eaveBeam", "beam", "kingPost",
      "bracketSeat", "bracketArm", "bearingBlock",
      "purlin", "rafter", "roofBoard", "panTile", "coverTile", "ridgeTile", "wall",
    ]) {
      expect(result.partCounts[type], `缺构件类型 ${type}`).toBeGreaterThan(0);
    }
  });

  it("构件规模与团队构造样板可比，不是简化体块", () => {
    const result = generate();
    expect(result.objects.length).toBeGreaterThan(400);
  });

  it("产出通过几何契约校验", () => {
    const result = generate();
    const parsed = ProjectDrivenGeometrySpecSchema.safeParse({
      schemaVersion: "2.0",
      id: "3b241101-e2bb-4255-8caf-4136c566a962",
      projectId: "2fa4684c-f640-5c45-99cd-407305343f3f",
      projectRevisionId: "d2511b25-9b51-562d-bb39-a05305712053",
      buildingId: "9f8e7d6c-5b4a-4392-8170-fedcba987654",
      inputHash: "a".repeat(64),
      coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
      tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
      objects: result.objects,
      interfaces: result.interfaces,
      unknowns: result.unknowns,
      createdAt: "2026-08-19T00:00:00Z",
    });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });

  it("每个构件的来源如实反映输入，不被生成器改写", () => {
    const result = generate();
    const column = result.objects.find((item) => item.stableKey === "column:0:0")!;
    expect(column.producer).toEqual({ producerType: "demo", fixtureId: "test-form" });
    // 高都的柱高是照片估算，参数的 basis 必须是 demo 而不是 rule
    expect(column.parameters.find((item) => item.name === "height")?.basis).toBe("demo");
    // 步架由规则推算
    const purlin = result.objects.find((item) => item.componentType === "purlin")!;
    expect(purlin.parameters.find((item) => item.name === "diameter")?.basis).toBe("rule");
  });

  it("同一输入重复生成得到同样的标识与同样的构件", () => {
    const first = generate();
    const second = generate();
    expect(second.objects.map((item) => item.id)).toEqual(first.objects.map((item) => item.id));
    expect(second.objects.map((item) => item.stableKey)).toEqual(first.objects.map((item) => item.stableKey));
    expect(second.interfaces.map((item) => item.id)).toEqual(first.interfaces.map((item) => item.id));
  });

  it("敞开面记为形制判断而不是悄悄少一面墙", () => {
    const result = generate();
    expect(result.objects.some((item) => item.stableKey === "wall:front")).toBe(false);
    const declared = result.unknowns.find((item) => item.reasonCode === "ENCLOSURE_DECLARED_OPEN");
    expect(declared?.description).toContain("敞开");
    expect(declared?.blocksFormalEligibility).toBe(true);
    expect(declared?.blocksProxyOutcome).toBe(false);
  });

  it("未声明斗栱层高时不生成承托构件并记未知项", () => {
    const result = generate(gaoduForm({ bracketLayerHeight: null }));
    expect(result.partCounts.bracketSeat ?? 0).toBe(0);
    expect(result.unknowns.some((item) => item.reasonCode === "BRACKET_LAYER_NOT_DECLARED")).toBe(true);
  });

  it("举高与步架数量对不上直接报错，不静默补齐", () => {
    expect(() => generate(gaoduForm({ liftHeightsMm: [] }))).toThrow(/LIFT_STEP_COUNT_MISMATCH/);
  });

  // 生成器不是清式专用：换一套模数体系同样出得来，构件分部不变。
  it("换成宋材份制同样生成，且承托尺寸随模数变化", () => {
    const qing = generate();
    const song = generate(gaoduForm({ modular: SONG }));
    expect(Object.keys(song.partCounts).sort()).toEqual(Object.keys(qing.partCounts).sort());
    const seatOf = (result: ReturnType<typeof generate>) =>
      result.objects.find((item) => item.componentType === "bracketSeat")!.solid;
    const qingSeat = seatOf(qing);
    const songSeat = seatOf(song);
    expect(qingSeat.kind).toBe("box");
    expect(songSeat.kind).toBe("box");
    if (qingSeat.kind === "box" && songSeat.kind === "box") {
      expect(Number(songSeat.sizeX)).toBeLessThan(Number(qingSeat.sizeX));
    }
  });
});

// 圆柱按弦高细分，三角形数与半径成反比，而消隐成本与三角形数直接相关。
// 小半径长构件用圆柱会让出图跑不完：实测三百六十条筒瓦做成圆柱时
// 占全模型三角形的九成四，一张立面图跑不出来；改断面挤出后总量降七倍多。
describe("小半径重复构件不用圆柱", () => {
  it("筒瓦用断面挤出而不是圆柱", () => {
    const result = generate();
    const covers = result.objects.filter((item) => item.componentType === "coverTile");
    expect(covers.length).toBeGreaterThan(100);
    for (const cover of covers) expect(cover.solid.kind, cover.stableKey).toBe("extrudedProfile");
  });

  it("断面点数固定且很少，不随构件尺寸变化", () => {
    const small = generate(gaoduForm({ tileCourseWidth: length(120) }));
    const large = generate(gaoduForm({ tileCourseWidth: length(400) }));
    const points = (result: ReturnType<typeof generate>) => {
      const cover = result.objects.find((item) => item.componentType === "coverTile")!;
      return cover.solid.kind === "extrudedProfile" ? cover.solid.profileMm.length : -1;
    };
    expect(points(small)).toBe(points(large));
    expect(points(small)).toBeGreaterThan(2);
    expect(points(small)).toBeLessThanOrEqual(8);
  });

  // 重复几百次的构件里不该再出现圆柱。檩只有几根，成本可接受，单列。
  it("重复过百的构件类型里没有圆柱", () => {
    const result = generate();
    const counts = new Map<string, number>();
    for (const object of result.objects) {
      counts.set(object.componentType, (counts.get(object.componentType) ?? 0) + 1);
    }
    const offenders = result.objects
      .filter((object) => object.solid.kind === "cylinder" && (counts.get(object.componentType) ?? 0) > 100)
      .map((object) => object.componentType);
    expect([...new Set(offenders)]).toEqual([]);
  });
});

// 质量基准 3.1 要求柱、梁、枋、檩、椽、望板成为独立可追踪构件，
// 3.5 要求一榀"屋面—瓦作—檩椽—梁枋—承托—柱—柱础—台基"构造链完整。
// 缺梁架时剖面里檩是悬空的，这类缺陷图上一眼可见。
describe("梁架与构造链", () => {
  it("逐缝按步架数分层，命名与架数对应", () => {
    const result = generate();
    const beams = result.objects.filter((item) => item.componentType === "beam");
    const axes = 4;
    expect(beams.length).toBe(axes * 3);
    const names = new Set(beams.map((item) => item.displayNameZh.split(" ")[0]));
    expect([...names]).toEqual(expect.arrayContaining(["三架梁", "五架梁", "七架梁"]));
    expect(names.size).toBe(3);
  });

  it("瓜柱把上下两层梁连起来，脊檩有脊瓜柱承托", () => {
    const result = generate();
    const posts = result.objects.filter((item) => item.componentType === "kingPost");
    // 两层瓜柱各前后一根，加脊瓜柱一根，共五根，逐缝
    expect(posts.length).toBe(4 * 5);
    expect(posts.some((item) => item.displayNameZh.startsWith("脊瓜柱"))).toBe(true);
  });

  it("梁落在柱头科上，不是悬空", () => {
    const result = generate();
    const beam = result.objects.find((item) => item.stableKey === "beam:0:0")!;
    const seat = result.objects.find((item) => item.stableKey === "bracket-column:0:0:block");
    expect(seat, "缺柱头科").toBeDefined();
    const bearing = result.interfaces.find(
      (item) => item.fromObjectId === beam.id && item.toObjectId === seat!.id,
    );
    expect(bearing?.interfaceType).toBe("bearing");
  });

  it("举高与梁高对不上时报错，不生成穿模的瓜柱", () => {
    expect(() => generate(gaoduForm({
      liftHeightsMm: [length(100), length(100), length(100)],
    }))).toThrow(/CLEARANCE_INSUFFICIENT/);
  });
});

// 屋面沿举架斜铺。水平摆放的椽与望板在立面上是悬空的横条，
// 不是屋面，图上一眼可见。
describe("屋面沿举架斜置", () => {
  const slopeOf = (solid: { kind: string; profileMm?: readonly (readonly [number, number])[] }) => {
    if (solid.kind !== "extrudedProfile" || !solid.profileMm) return null;
    const [first, second] = solid.profileMm;
    if (!first || !second) return null;
    return (second[1] - first[1]) / (second[0] - first[0]);
  };

  it("椽、望板、瓦都是斜置断面而不是水平盒子", () => {
    const result = generate();
    for (const type of ["rafter", "roofBoard", "panTile", "coverTile"]) {
      const item = result.objects.find((object) => object.componentType === type)!;
      expect(item.solid.kind, type).toBe("extrudedProfile");
      const slope = slopeOf(item.solid as never);
      expect(slope, type).not.toBeNull();
      expect(Math.abs(slope!), `${type} 坡度为零`).toBeGreaterThan(0.1);
    }
  });

  it("逐步架坡度不同，反映举架而不是单一斜面", () => {
    const result = generate();
    const boards = result.objects
      .filter((item) => item.componentType === "roofBoard")
      .map((item) => Math.abs(slopeOf(item.solid as never) ?? 0));
    const distinct = new Set(boards.map((value) => value.toFixed(3)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("屋面各层自下而上不穿插：椽在檩背之上，望板在椽之上", () => {
    const result = generate();
    const zStart = (key: string) => {
      const solid = result.objects.find((item) => item.stableKey === key)!.solid as never as {
        profileMm: [number, number][];
      };
      return solid.profileMm[0]![1];
    };
    expect(zStart("roof-board:0")).toBeGreaterThan(zStart("rafter:0:0"));
    expect(zStart("pan-tile:0:0")).toBeGreaterThan(zStart("roof-board:0"));
  });
});

// 质量基准 2.3 要求演示项目之间构件深度一致。高都缺的类型不能默认省略：
// 判得出就按形制生成，判不出就记未知项写清需要什么资料。
describe("山面与檐口做法", () => {
  const gable = {
    roofFormZh: "悬山",
    bargeBoardThickness: length(40, "demo"),
    bargeBoardWidth: length(300, "demo"),
    overhang: length(400, "demo"),
  };
  const flyRafter = {
    sectionSize: length(70, "demo"),
    projection: length(500, "demo"),
    eaveClosureHeight: length(120, "demo"),
  };

  it("屋顶形式判不出时不生成山面，记未知项并写清需要什么资料", () => {
    const result = generate();
    expect(result.partCounts.gableBoard ?? 0).toBe(0);
    const unknown = result.unknowns.find((item) => item.reasonCode === "ROOF_FORM_NOT_DETERMINED");
    expect(unknown?.requiredEvidence.length).toBeGreaterThan(0);
    expect(unknown?.blocksFormalEligibility).toBe(true);
  });

  it("檐口做法判不出时不生成飞椽，同样记未知项", () => {
    const result = generate();
    expect(result.partCounts.flyRafter ?? 0).toBe(0);
    expect(result.unknowns.some((item) => item.reasonCode === "FLY_RAFTER_NOT_DETERMINED")).toBe(true);
  });

  // 博风沿前后两坡各三段，两山共十二段；山面脊饰两山各一件
  it("声明了屋顶形式就生成博风板与山面脊饰，两山各一组", () => {
    const result = generate(gaoduForm({ gable }));
    expect(result.partCounts.gableBoard).toBe(12);
    expect(result.partCounts.gableRidgeCap).toBe(2);
    expect(result.unknowns.some((item) => item.reasonCode === "ROOF_FORM_NOT_DETERMINED")).toBe(false);
  });

  it("声明了飞椽就生成飞椽与檐口封闭", () => {
    const result = generate(gaoduForm({ flyRafter }));
    expect(result.partCounts.flyRafter).toBeGreaterThan(10);
    expect(result.partCounts.eaveClosure).toBe(1);
    expect(result.unknowns.some((item) => item.reasonCode === "FLY_RAFTER_NOT_DETERMINED")).toBe(false);
  });

  it("补出来的构件同样通过几何契约校验", () => {
    const result = generate(gaoduForm({ gable, flyRafter }));
    const parsed = ProjectDrivenGeometrySpecSchema.safeParse({
      schemaVersion: "2.0",
      id: "3b241101-e2bb-4255-8caf-4136c566a962",
      projectId: "2fa4684c-f640-5c45-99cd-407305343f3f",
      projectRevisionId: "d2511b25-9b51-562d-bb39-a05305712053",
      buildingId: "9f8e7d6c-5b4a-4392-8170-fedcba987654",
      inputHash: "a".repeat(64),
      coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
      tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
      objects: result.objects,
      interfaces: result.interfaces,
      unknowns: result.unknowns,
      createdAt: "2026-08-19T00:00:00Z",
    });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });
});

// 质量基准 2.3：演示项目之间构件深度一致。缺的类型不能默认省略，
// 判不出就记未知项并写清需要什么资料。
describe("资料判不出的部位记未知项", () => {
  const reasons = (result: ReturnType<typeof generate>) =>
    result.unknowns.map((item) => item.reasonCode);

  it("有墙的面是否开门窗判不出时记未知项", () => {
    const result = generate();
    expect(reasons(result)).toContain("WALL_OPENINGS_NOT_DETERMINED");
    const unknown = result.unknowns.find((item) => item.reasonCode === "WALL_OPENINGS_NOT_DETERMINED")!;
    expect(unknown.requiredEvidence.length).toBeGreaterThan(0);
    expect(unknown.affectedRefs.length).toBeGreaterThan(0);
  });

  it("四面全敞时不记门窗未知项，没有墙就没有开口问题", () => {
    const result = generate(gaoduForm({ enclosure: { front: "open", sides: "open", back: "open" } }));
    expect(reasons(result)).not.toContain("WALL_OPENINGS_NOT_DETERMINED");
  });

  it("基础分层在地面以下，恒记未知项", () => {
    expect(reasons(generate())).toContain("FOUNDATION_LAYERS_NOT_DETERMINED");
  });

  it("每条未知项都阻断正式资格但不阻断代理成果", () => {
    for (const unknown of generate().unknowns) {
      expect(unknown.blocksFormalEligibility, unknown.reasonCode).toBe(true);
      expect(unknown.blocksProxyOutcome, unknown.reasonCode).toBe(false);
    }
  });
});
