import { describe, expect, it } from "vitest";

import { ALL_SWITCHABLE_VIEW_NAMES } from "@gujian/domain";

import { dispatchUserText, keywordFallback, VIEW_JUMP, type ModelDispatchRunner } from "./dispatch.js";

const toolCall = (name: string, args: unknown) => ({
  kind: "tool_call" as const,
  name,
  argumentsJson: JSON.stringify(args),
  raw: `raw:${name}`,
});

describe("三级降级分发", () => {
  it("模型一次命中", async () => {
    const decision = await dispatchUserText("看看构件清单", {
      modelAvailable: true,
      runModel: async () => toolCall("switch_view", { view: "构件清单" }),
    });
    expect(decision.kind).toBe("action");
    if (decision.kind === "action") {
      expect(decision.action.name).toBe("switch_view");
      expect(decision.source).toBe("model");
    }
    expect(decision.trace.attempts.map((a) => a.resultCode)).toEqual(["OK"]);
  });

  it("参数错误回模型重试一次，重试携带问题清单", async () => {
    const calls: Array<string[] | null> = [];
    const runModel: ModelDispatchRunner = async ({ retryIssues }) => {
      calls.push(retryIssues);
      return calls.length === 1
        ? toolCall("switch_view", { view: "不存在的视图" })
        : toolCall("switch_view", { view: "任务卡" });
    };
    const decision = await dispatchUserText("切到任务", { modelAvailable: true, runModel });
    expect(decision.kind).toBe("action");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeNull();
    expect(calls[1]?.[0]).toContain("view");
    expect(decision.trace.attempts.map((a) => a.resultCode)).toEqual(["INVALID_ARGS", "OK"]);
  });

  it("两次失败落关键词", async () => {
    const decision = await dispatchUserText("继续", {
      modelAvailable: true,
      runModel: async () => toolCall("advance_workflow", { force: true }),
    });
    expect(decision.kind).toBe("action");
    if (decision.kind === "action") {
      expect(decision.action.name).toBe("advance_workflow");
      expect(decision.source).toBe("keyword");
    }
  });

  it("清单外动作重试后落关键词", async () => {
    const decision = await dispatchUserText("帮我删库", {
      modelAvailable: true,
      runModel: async () => toolCall("delete_everything", {}),
    });
    expect(decision.trace.attempts.filter((a) => a.resultCode === "UNKNOWN_ACTION")).toHaveLength(2);
    if (decision.kind === "action") expect(decision.action.name).toBe("answer_question");
  });

  it("模型异常直接落关键词，不中断", async () => {
    const decision = await dispatchUserText("出图", {
      modelAvailable: true,
      runModel: async () => { throw new Error("KIMI_TIMEOUT"); },
    });
    expect(decision.kind).toBe("action");
    if (decision.kind === "action") expect(decision.action.name).toBe("generate_drawings");
  });

  it("模型不可用直接走关键词", async () => {
    const decision = await dispatchUserText("看看图纸", {
      modelAvailable: false,
      runModel: async () => { throw new Error("should not be called"); },
    });
    if (decision.kind === "action") {
      expect(decision.action.name).toBe("switch_view");
      expect(decision.args).toEqual({ view: "图纸与检查" });
    }
  });

  it("模型文本回复原样透传", async () => {
    const decision = await dispatchUserText("泥道栱是什么", {
      modelAvailable: true,
      runModel: async () => ({ kind: "text", content: "泥道栱是……", raw: "raw" }),
    });
    expect(decision).toMatchObject({ kind: "answer", source: "model" });
  });
});

describe("关键词退路表", () => {
  const cases: Array<[string, string]> = [
    ["继续往下走", "advance_workflow"],
    ["开始画图吧", "generate_drawings"],
    ["生成三维模型", "generate_geometry"],
    ["帮我组包交付", "export_deliverable"],
    ["检查一下数据", "run_data_check"],
    ["现在进度怎么样", "query_job_progress"],
    ["重新识别一遍", "rerun_recognition"],
    ["解析任务书", "parse_task_brief"],
    ["帮我盘点资料", "parse_task_brief"],
    ["切到实测基准", "switch_view"],
    ["这个雀替的尺寸合理吗", "answer_question"],
  ];
  for (const [text, expected] of cases) {
    it(`${text} 落到 ${expected}`, () => {
      expect(keywordFallback(text).name).toBe(expected);
    });
  }
});

describe("切视图与作业动作的边界", () => {
  it("每个可切换视图都有关键词退路", () => {
    const covered = VIEW_JUMP.map(([, view]) => view);
    expect([...covered].sort()).toEqual([...ALL_SWITCHABLE_VIEW_NAMES].sort());
  });

  const viewCases: Array<[string, string]> = [
    ["看三维模型", "三维模型"],
    ["打开问题队列", "问题队列"],
    ["看一下待办", "问题队列"],
    ["去看模型用量和费用", "模型运行与费用"],
    ["打开图纸样式", "图纸样式"],
    ["看图纸", "图纸与检查"],
    ["回到项目列表", "项目列表"],
    ["返回项目列表", "项目列表"],
    ["打开项目清单", "项目列表"],
  ];
  for (const [text, view] of viewCases) {
    it(`${text} 切到${view}`, () => {
      expect(keywordFallback(text)).toEqual({ name: "switch_view", args: { view } });
    });
  }

  it("看三维模型不触发生成三维这类高成本作业", () => {
    expect(keywordFallback("看三维模型").name).not.toBe("generate_geometry");
  });

  const jobCases: Array<[string, string]> = [
    ["生成三维模型", "generate_geometry"],
    ["重新建模", "generate_geometry"],
    ["检查一下数据", "run_data_check"],
    ["帮我组包交付", "export_deliverable"],
    ["帮我盘点资料", "parse_task_brief"],
  ];
  for (const [text, action] of jobCases) {
    it(`${text} 仍落到 ${action}`, () => {
      expect(keywordFallback(text).name).toBe(action);
    });
  }
});
