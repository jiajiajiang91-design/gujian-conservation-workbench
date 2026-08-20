import { describe, expect, it } from "vitest";

import { DEMO_MATRIX_STEPS, evaluateDemoMatrix } from "./demo-matrix.js";

// 08 演示项目定义表 3：任一格演不出内容即为演示不成立。
// 这份测试锁的是判定规则本身；对真实演示包逐格核对由 tools/check-demo-matrix.mjs 做，
// 它要读几十兆的包，不适合放进单元测试。

describe("演示七步核对", () => {
  it("覆盖表 3 的七步，顺序与文档一致", () => {
    expect(DEMO_MATRIX_STEPS.map((step) => step.viewZh)).toEqual([
      "任务卡", "资料清单", "实测基准", "构件清单", "三维模型", "图纸与检查", "交付包",
    ]);
  });

  it("数据齐全时七格全满", () => {
    const cells = evaluateDemoMatrix({
      snapshot: {
        taskDefinitions: [{ id: "t" }],
        evidences: [{ id: "e" }],
        facts: [{ id: "f" }],
        measurements: [],
        geometrySpecs: [{ objects: [{ id: "o1" }, { id: "o2" }] }],
        entities: [], exclusionRecords: [],
        geometryRevisions: [{ id: "g" }],
      },
      artifacts: [{ id: "a" }],
      checkRuns: [{ id: "c" }],
      deliveries: [{ id: "d" }],
    });
    expect(cells.filter((cell) => !cell.filled)).toEqual([]);
  });

  it("只有几何没有图纸时，图纸与交付两格判空", () => {
    const cells = evaluateDemoMatrix({
      snapshot: {
        taskDefinitions: [{ id: "t" }], evidences: [{ id: "e" }], facts: [{ id: "f" }],
        geometrySpecs: [{ objects: [{ id: "o" }] }], geometryRevisions: [{ id: "g" }],
      },
      artifacts: [], checkRuns: [], deliveries: [],
    });
    expect(cells.filter((cell) => !cell.filled).map((cell) => cell.viewZh)).toEqual(["图纸与检查", "交付包"]);
  });

  // 构件既可能来自几何规格，也可能来自识别出的对象，两条路任一有内容即算数
  it("构件只在对象表里时构件清单也算有内容", () => {
    const cells = evaluateDemoMatrix({
      snapshot: { taskDefinitions: [{ id: "t" }], entities: [{ id: "x" }], geometrySpecs: [] },
    });
    expect(cells.find((cell) => cell.viewZh === "构件清单")?.filled).toBe(true);
  });

  it("空包七格全空，不会误判为有内容", () => {
    const cells = evaluateDemoMatrix({});
    expect(cells.every((cell) => !cell.filled)).toBe(true);
  });
});
