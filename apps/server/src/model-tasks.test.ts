import { describe, expect, it } from "vitest";

import { MODEL_TASKS, findModelTask } from "./model-tasks.js";

// 技术架构 7.2：任务注册表按 taskType 固定系统提示、输入种类、输出结构与预算。
// 提示写死在网关里时，加第二个任务会牵动第一个，因此这里锁住注册表本身的性质。

describe("模型任务注册表", () => {
  it("首期任务类型里的资料整理与测量转写都在册", () => {
    expect(findModelTask("evidence-summary")?.inputKinds).toEqual(["text"]);
    // 测量转写两种输入都收：读的是资料里写明的尺寸，来源是文字还是图纸不改变任务性质
    expect(findModelTask("measurement-transcription")?.inputKinds).toEqual(["text", "image"]);
  });

  it("不认识的任务类型返回空，不静默套用别的提示", () => {
    expect(findModelTask("unknown-task")).toBeNull();
    expect(findModelTask("")).toBeNull();
  });

  it("taskType 唯一", () => {
    const types = MODEL_TASKS.map((task) => task.taskType);
    expect(new Set(types).size).toBe(types.length);
  });

  it("每条都有预算，不存在无上限的任务", () => {
    for (const task of MODEL_TASKS) {
      expect(task.maxItems, task.taskType).toBeGreaterThan(0);
      expect(task.maxInputBytes, task.taskType).toBeGreaterThan(0);
    }
  });

  // 系统提示只定义角色、任务目标和责任边界（技术架构 7.2）。
  // 确定性业务规则不进提示，进程序检查。
  it("每条提示都写明不补写缺失测量的责任边界", () => {
    for (const task of MODEL_TASKS) {
      expect(task.systemPrompt, task.taskType).toContain("不补写缺失的测量");
    }
  });

  it("测量转写的提示交代 OCR 噪声的判读方式", () => {
    expect(findModelTask("measurement-transcription")!.systemPrompt).toContain("OCR");
  });

  it("测量转写的提示禁止按比例量取与经验推算", () => {
    const prompt = findModelTask("measurement-transcription")!.systemPrompt;
    expect(prompt).toContain("不按比例量取");
    expect(prompt).toContain("uncertain");
  });

  // 三张 HABS 实测图各约 1 MiB，转 base64 后约 4 MiB
  it("图像任务的预算容得下三张实测图", () => {
    const task = findModelTask("measurement-transcription")!;
    expect(task.maxItems).toBeGreaterThanOrEqual(3);
    expect(task.maxInputBytes).toBeGreaterThan(4 * 1024 * 1024);
  });
});
