import { describe, expect, it } from "vitest";

import { translateEntity, type SourceMesh } from "./demo-component-translation.js";

type Vertex = [number, number, number];

function boxMesh(min: Vertex, max: Vertex): SourceMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const vertices: Vertex[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7],
  ];
  return { vertices, faces };
}

// 五边形轮廓沿 x 挤出的棱柱：轮廓点位于 YZ 平面
function pentagonPrismMesh(x0: number, x1: number): SourceMesh {
  const profile: [number, number][] = [[0, 0], [400, 0], [400, 200], [200, 320], [0, 200]];
  const cap = (x: number): Vertex[] => profile.map(([y, z]) => [x, y, z] as Vertex);
  const vertices = [...cap(x0), ...cap(x1)];
  const fan = (offset: number, flip: boolean): [number, number, number][] =>
    [1, 2, 3].map((index) => (flip
      ? [offset, offset + index + 1, offset + index]
      : [offset, offset + index, offset + index + 1]) as [number, number, number]);
  const sides: [number, number, number][] = [];
  for (let index = 0; index < 5; index += 1) {
    const next = (index + 1) % 5;
    sides.push([index, next, 5 + next], [index, 5 + next, 5 + index]);
  }
  return { vertices, faces: [...fan(0, true), ...fan(5, false), ...sides] };
}

// 沿 y 方向弯曲的条带（模拟瓦件），横向 x 有多个站点
function curvedStripMesh(): SourceMesh {
  const vertices: Vertex[] = [];
  const faces: [number, number, number][] = [];
  const xStations = [0, 130, 260];
  const yStations = [0, 200, 400, 600];
  const rise = (x: number) => (x === 130 ? 0 : 18);
  for (const x of xStations) for (const y of yStations) {
    const zBase = 3000 - y * 0.6 + rise(x);
    vertices.push([x, y, zBase], [x, y, zBase + 18]);
  }
  for (let index = 0; index + 3 < vertices.length; index += 2) faces.push(
    [index, index + 1, index + 2], [index + 1, index + 3, index + 2],
  );
  return { vertices, faces };
}

const facts = new Map<string, number>();

describe("demo component translation", () => {
  it("识别整体长方体并按包围盒还原", () => {
    const mesh = boxMesh([0, 0, 0], [300, 480, 4500]);
    const result = translateEntity("eaveBeam", facts, [[0, 0, 0], [300, 480, 4500]], mesh);
    expect(result.primary.kind).toBe("box");
    expect(result.approximations).toEqual(["exactBox"]);
  });

  it("从棱柱网格端面精确提取截面轮廓", () => {
    const mesh = pentagonPrismMesh(860, 940);
    const result = translateEntity("rafter", facts, [[860, 0, 0], [940, 400, 320]], mesh);
    expect(result.primary.kind).toBe("extrudedProfile");
    if (result.primary.kind !== "extrudedProfile") return;
    expect(result.primary.axis).toBe("x");
    expect(result.primary.depth).toBe("80");
    expect(result.primary.originMm).toEqual([860, 0, 0]);
    expect(result.primary.profileMm).toHaveLength(5);
    expect(result.primary.profileMm).toContainEqual([200, 320]);
    expect(result.approximations).toEqual(["exactPrism"]);
  });

  it("瓦件按中线纵向剖面条带展平并记录近似", () => {
    const mesh = curvedStripMesh();
    const result = translateEntity("panTile", facts, [[0, 0, 2622], [260, 600, 3036]], mesh);
    expect(result.primary.kind).toBe("extrudedProfile");
    if (result.primary.kind !== "extrudedProfile") return;
    expect(result.primary.axis).toBe("x");
    expect(result.primary.depth).toBe("260");
    expect(result.approximations).toEqual(["stripCrossSectionFlattened"]);
  });

  it("合并多块构件按连通分量拆分为分件", () => {
    const base = boxMesh([0, 0, 0], [520, 420, 100]);
    const corner = boxMesh([0, 0, 100], [160, 110, 180]);
    const merged: SourceMesh = {
      vertices: [...base.vertices, ...corner.vertices],
      faces: [...base.faces, ...corner.faces.map((face) => face.map((index) => index + base.vertices.length) as [number, number, number])],
    };
    const result = translateEntity("bracketSeat", facts, [[0, 0, 0], [520, 420, 180]], merged);
    expect(result.parts).toHaveLength(1);
    expect(result.primary.kind).toBe("box");
    expect(result.approximations).toContain("decomposedParts");
  });

  it("柱按上下径平均转换为圆柱", () => {
    const columnFacts = new Map([["bottomDiameter", 380], ["topDiameter", 340], ["height", 2880]]);
    const result = translateEntity("column", columnFacts, [[-190, -190, 840], [190, 190, 3720]], undefined);
    expect(result.primary.kind).toBe("cylinder");
    if (result.primary.kind !== "cylinder") return;
    expect(result.primary.radius).toBe("180");
    expect(result.primary.axis).toBe("z");
    expect(result.approximations).toEqual(["cylinderAveragedTaper"]);
  });

  it("无网格实体退化为包围盒并记录兜底", () => {
    const result = translateEntity("roofBoard", facts, [[0, 0, 0], [100, 100, 40]], undefined);
    expect(result.primary.kind).toBe("box");
    expect(result.approximations).toEqual(["boundsEnvelopeFallback"]);
  });
});
