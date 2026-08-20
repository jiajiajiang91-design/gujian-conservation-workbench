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
      markEntityHidden: vi.fn(async () => ({ kind: "committed", messageZh: "已标记为不可见并记下原因：雀替" })),
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

  // 实测里模型省了 label，缺名时旧写法拿整句说明的前 40 字当构件名，
  // 构件表于是出现一行写着一整句话的记录。缺名要问，不猜也不凑。
  it("新增缺构件名时提问，不拿整句说明当名字", async () => {
    const current = head([]);
    const dependencies = deps(current);
    const result = await call(current, { changeType: "新增", instruction: "这里漏了一个雀替，和右边那个对称的" }, dependencies);
    expect(result.tone).toBe("risk");
    expect(result.text).toContain("构件名称");
    const executors = (dependencies as unknown as { executors: { commitMarqueeEntity: ReturnType<typeof vi.fn> } }).executors;
    expect(executors.commitMarqueeEntity).not.toHaveBeenCalled();
  });

  // 写入型动作要告诉挂载方项目变了。少了这个标记，执行体写完库、助手回报
  // 已新增，而构件表要退出项目再进来才看得到那条记录。
  it("新增与删除标记为已写入，提问类不标记", async () => {
    const 新增 = await call(head([]), { changeType: "新增", instruction: "这里漏了一个雀替", label: "雀替" });
    expect(新增.mutated).toBe(true);

    const 无名 = await call(head([]), { changeType: "新增", instruction: "这里漏了一个雀替" });
    expect(无名.mutated).toBeUndefined();

    const 命不中 = await call(head([{ id: ENTITY_ID, name: "柱 1", entityType: "柱" }]), { changeType: "删除", instruction: "去掉" });
    expect(命不中.mutated).toBeUndefined();
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

  it("类别修改与位置调整走逐条确认，不直接改数据", async () => {
    const current = head([{ id: ENTITY_ID, name: "雀替", entityType: "待确认", imageRegion: region(0.22, 0.22) }]);
    for (const changeType of ["类别修改", "位置调整"]) {
      const dependencies = deps(current);
      const result = await call(current, { changeType, instruction: "这块被树挡住了", label: "额枋" }, dependencies);
      expect(result.tone).toBe("result");
      expect(result.text).toContain("逐条确认");
      expect((dependencies as unknown as { presentProposal: ReturnType<typeof vi.fn> }).presentProposal).toHaveBeenCalledOnce();
    }
  });

  // 按 2026-08-20 的处置，新增与遮挡标记直接执行并留痕，不走逐条确认：
  // 用户已经在图上圈了位置又说明了看不见什么，再要一次确认拿不到新信息。
  it("遮挡标记直接执行，原因写进记录", async () => {
    const current = head([{ id: ENTITY_ID, name: "雀替", entityType: "待确认", imageRegion: region(0.22, 0.22) }]);
    const dependencies = deps(current);
    const result = await call(current, { changeType: "标记不可见", instruction: "这块被树挡住了" }, dependencies);
    expect(result.tone).toBe("result");
    expect(result.mutated).toBe(true);
    const executors = (dependencies as unknown as { executors: { markEntityHidden: ReturnType<typeof vi.fn> } }).executors;
    expect(executors.markEntityHidden).toHaveBeenCalledOnce();
    expect(executors.markEntityHidden.mock.calls[0]![1]).toMatchObject({ entityId: ENTITY_ID });
    expect(String(executors.markEntityHidden.mock.calls[0]![1].reasonZh)).toContain("这块被树挡住了");
    expect((dependencies as unknown as { presentProposal: ReturnType<typeof vi.fn> }).presentProposal).not.toHaveBeenCalled();
  });
});
