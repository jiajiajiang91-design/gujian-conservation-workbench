import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ASSISTANT_ACTION_DELIVERY, executableActionNames } from "@gujian/domain";
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

  it("交付登记表与目录一一对应，无孤项无缺项", () => {
    expect(Object.keys(ASSISTANT_ACTION_DELIVERY).sort())
      .toEqual(ACTION_DEFINITIONS.map((a) => a.name).sort());
  });

  // 通用约定 5：目录只投影已实现动作。让模型选中一个必然失败的动作，
  // 等于把前端的缺口转嫁成对话里的失败，而不是在目录层如实缺席。
  it("模型可见目录只投影 executable 的动作", () => {
    expect(modelFacingCatalog().map((a) => a.name).sort()).toEqual(executableActionNames());
    // 具体哪个动作未交付随实现变化，这里只断言投影范围等于登记表，
    // 不写死某个动作名：写死会在它接入后变成一条永远为真的空断言。
    const definedOnly = Object.entries(ASSISTANT_ACTION_DELIVERY)
      .filter(([, item]) => item.state === "definedOnly").map(([name]) => name);
    for (const name of definedOnly) {
      expect(modelFacingCatalog().map((a) => a.name)).not.toContain(name);
    }
  });

  it("模型侧目录只含名称、描述、参数三字段", () => {
    const catalog = modelFacingCatalog();
    expect(catalog).toHaveLength(executableActionNames().length);
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

// 界面文档表 10 的实现状态列必须与登记表逐条一致。
// 之前表 10 没有这一列，只读表的人看到 14 个动作全部交付，而其中一个
// 前端只有桩。文档能单方面宣称已交付，是这次虚报的直接成因。
describe("界面文档表 10 与交付登记表一致", () => {
  const path = fileURLToPath(new URL(
    "../../../../文档/01_产品/03_界面与交互形态.md",
    import.meta.url,
  ));
  const markdown = readFileSync(path, "utf8");

  it("表 10 每行的实现状态取自登记表，且覆盖全部动作", () => {
    const header = "| 动作 | 实现状态 | 触发方式 | 前置条件 | 确认级别 | 留痕 |";
    const start = markdown.indexOf(header);
    expect(start, "表 10 的表头变了，实现状态列可能被删掉").toBeGreaterThan(-1);
    // 取到第一条非表格行为止：后面还有表 11、表 12，用 filter 会一路吃过去
    const body: string[] = [];
    for (const line of markdown.slice(start).split(/\r?\n/).slice(2)) {
      if (!line.startsWith("| ")) break;
      body.push(line);
    }
    const rows = body.map((line) => line.split("|").map((cell) => cell.trim()));
    const states = rows.map((cells) => cells[2]);
    expect(rows.length).toBe(Object.keys(ASSISTANT_ACTION_DELIVERY).length);
    expect(new Set(states)).toEqual(new Set(Object.values(ASSISTANT_ACTION_DELIVERY).map((item) => item.state)));
    const counts = (values: string[]) => values.filter((value) => value === "definedOnly").length;
    expect(counts(states as string[]))
      .toBe(counts(Object.values(ASSISTANT_ACTION_DELIVERY).map((item) => item.state)));
  });
});
