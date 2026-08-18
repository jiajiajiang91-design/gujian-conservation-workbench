import { describe, expect, it } from "vitest";

import {
  ACTION_DEFINITIONS,
  modelFacingCatalog,
  validateActionCall,
} from "./action-catalog.js";

describe("动作目录", () => {
  it("共 14 个动作且名称唯一", () => {
    expect(ACTION_DEFINITIONS).toHaveLength(14);
    const names = ACTION_DEFINITIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(14);
  });

  it("模型侧目录只含名称、描述、参数三字段", () => {
    const catalog = modelFacingCatalog();
    expect(catalog).toHaveLength(14);
    for (const entry of catalog) {
      expect(Object.keys(entry).sort()).toEqual(["description", "name", "parameters"]);
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("confirmLevel");
      expect(serialized).not.toContain("preconditionCode");
      expect(serialized).not.toContain("costly");
    }
  });

  it("切换视图覆盖工作区十个视图、模型运行与费用、项目列表", () => {
    // 少一个视图，助手就切不过去，模型侧还会因为 z.enum 拒绝而落到兜底回答。
    const expected = [
      "任务卡", "资料清单", "实测基准", "构件清单", "现状记录",
      "三维模型", "问题队列", "图纸样式", "图纸与检查", "交付包",
      "模型运行与费用", "项目列表",
    ];
    for (const view of expected) {
      expect(validateActionCall("switch_view", { view }).ok).toBe(true);
    }
    const schema = modelFacingCatalog().find((a) => a.name === "switch_view")?.parameters as {
      properties: { view: { enum: string[] } };
    };
    expect(schema.properties.view.enum).toEqual(expected);
  });

  it("高成本动作与确认级别标记正确", () => {
    const costly = ACTION_DEFINITIONS.filter((a) => a.costly).map((a) => a.name);
    expect(costly.sort()).toEqual(["generate_drawings", "generate_geometry"]);
    for (const a of ACTION_DEFINITIONS.filter((x) => x.costly)) {
      expect(a.confirmLevel).toBe("confirm");
    }
  });
});

describe("动作调用校验", () => {
  it("合法调用通过并返回解析后的参数", () => {
    const r = validateActionCall("switch_view", { view: "构件清单" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action.displayNameZh).toBe("切换视图");
      expect(r.args).toEqual({ view: "构件清单" });
    }
  });

  it("清单外动作返回 UNKNOWN_ACTION", () => {
    const r = validateActionCall("delete_project", {});
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_ACTION" });
  });

  it("参数不合规返回 INVALID_ARGS 并带路径级问题", () => {
    const r = validateActionCall("switch_view", { view: "不存在的视图" });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "INVALID_ARGS") {
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues[0]).toContain("view");
    }
  });

  it("多余字段被拒绝，参数契约封闭", () => {
    const r = validateActionCall("advance_workflow", { force: true });
    expect(r).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("修改建议要求主体、类型与载荷齐全", () => {
    const bad = validateActionCall("propose_modification", { subjectRef: "P48" });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    const good = validateActionCall("propose_modification", {
      subjectRef: "P48",
      changeType: "参数修改",
      payload: { diameterMm: 300 },
    });
    expect(good.ok).toBe(true);
  });
});
