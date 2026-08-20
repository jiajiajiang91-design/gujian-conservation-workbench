import { describe, expect, it, vi } from "vitest";

import { runClientOp } from "./client-op-adapter.js";

// 框选修正的五类说明方式。重点不在能跑通，在于命中判定与命不中时的行为：
// 位置对应不到构件时必须提问，不能猜一个，也不能静默失败。

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

function head(entities: unknown[]) {
  return {
    projectId: "44444444-4444-4444-8444-444444444444",
    revisionId: "55555555-5555-4555-8555-555555555555",
    snapshot: {
      buildings: [{ id: "66666666-6666-4666-8666-666666666666" }],
      evidences: [{ id: EVIDENCE_ID, title: "正立面照片" }],
      entities,
      facts: [],
      measurements: [],
    },
  } as never;
}

function region(x: number, y: number, width = 0.1, height = 0.1) {
  return { evidenceRef: EVIDENCE_ID, x, y, width, height };
}

function deps(current: ReturnType<typeof head>, overrides: Record<string, unknown> = {}) {
  return {
    getHead: () => current,
    measurements: () => [],
    presentProposal: vi.fn(),
    executors: {
      commitMarqueeEntity: vi.fn(async () => ({ kind: "committed", messageZh: "已新增构件记录：雀替" })),
      commitExclusion: vi.fn(async () => ({ kind: "committed", messageZh: "已记入排除记录：雀替" })),
    },
    ...overrides,
  } as never;
}

const selection = { evidenceId: EVIDENCE_ID, rectNormalized: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } };

function call(current: ReturnType<typeof head>, args: Record<string, unknown>, dependencies = deps(current)) {
  return runClientOp(dependencies, {
    clientOp: "ui:marquee-correction",
    actionName: "marquee_correction",
    args: { selection, ...args },
  });
}

describe("框选修正", () => {
  it("没有框选位置时提示先框，不执行", async () => {
    const current = head([]);
    const result = await runClientOp(deps(current), {
      clientOp: "ui:marquee-correction", actionName: "marquee_correction",
      args: { changeType: "新增", instruction: "这里漏了一个雀替" },
    });
    expect(result.tone).toBe("risk");
    expect(result.text).toContain("先框出位置");
  });

  it("新增不需要先命中构件，直接入库", async () => {
    const current = head([]);
    const dependencies = deps(current);
    const result = await call(current, { changeType: "新增", instruction: "这里漏了一个雀替", label: "雀替" }, dependencies);
    expect(result.tone).toBe("result");
    const executors = (dependencies as unknown as { executors: { commitMarqueeEntity: ReturnType<typeof vi.fn> } }).executors;
    expect(executors.commitMarqueeEntity).toHaveBeenCalledOnce();
    const passed = executors.commitMarqueeEntity.mock.calls[0]![1] as { name: string; entityType: string };
    expect(passed.name).toBe("雀替");
    // 类别没说就写待确认，不按名称猜类型
    expect(passed.entityType).toBe("待确认");
  });

  it("项目里没有带图上位置的构件时，删除类提问而不是猜", async () => {
    const current = head([{ id: ENTITY_ID, name: "柱 1", entityType: "柱" }]);
    const result = await call(current, { changeType: "删除", instruction: "这个多识别了，去掉" });
    expect(result.tone).toBe("risk");
    expect(result.text).toContain("请说明是哪个构件");
  });

  it("框到唯一构件时删除进排除记录", async () => {
    const current = head([{ id: ENTITY_ID, name: "雀替", entityType: "待确认", imageRegion: region(0.22, 0.22) }]);
    const dependencies = deps(current);
    const result = await call(current, { changeType: "删除", instruction: "多识别了一个，去掉" }, dependencies);
    expect(result.tone).toBe("result");
    const executors = (dependencies as unknown as { executors: { commitExclusion: ReturnType<typeof vi.fn> } }).executors;
    expect(executors.commitExclusion).toHaveBeenCalledOnce();
    const passed = executors.commitExclusion.mock.calls[0]![1] as { originRef: string; reasonZh: string };
    expect(passed.originRef).toBe(ENTITY_ID);
    expect(passed.reasonZh).toContain("多识别了一个");
  });

  it("框到多个构件时列出来让用户指认，不取第一个", async () => {
    const current = head([
      { id: ENTITY_ID, name: "雀替", entityType: "待确认", imageRegion: region(0.22, 0.22) },
      { id: OTHER_ID, name: "额枋", entityType: "待确认", imageRegion: region(0.25, 0.25) },
    ]);
    const result = await call(current, { changeType: "删除", instruction: "去掉" });
    expect(result.tone).toBe("risk");
    expect(result.text).toContain("雀替、额枋");
    expect(result.text).toContain("请说明是哪一个");
  });

  it("类别修改与标记不可见走逐条确认，不直接改数据", async () => {
    const current = head([{ id: ENTITY_ID, name: "雀替", entityType: "待确认", imageRegion: region(0.22, 0.22) }]);
    for (const changeType of ["类别修改", "标记不可见"]) {
      const dependencies = deps(current);
      const result = await call(current, { changeType, instruction: "这块被树挡住了", label: "额枋" }, dependencies);
      expect(result.tone).toBe("result");
      expect(result.text).toContain("逐条确认");
      expect((dependencies as unknown as { presentProposal: ReturnType<typeof vi.fn> }).presentProposal).toHaveBeenCalledOnce();
    }
  });
});
