import { ASSISTANT_ACTION_DELIVERY, stubClientOps } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { STUB_CLIENT_OP_TEXT, runClientOp } from "./client-op-adapter.js";

// 动作交付状态必须与前端执行体的实际情况一致。
// 登记表说 executable 而前端只有桩，就是把没做完的东西报成已交付；
// 登记表说 definedOnly 而前端其实做了，就是白白不投影给模型。
// 这两种漂移过去都发生过，靠文档叙述发现不了，只能靠这条测试。

const declaredStubs = stubClientOps();

describe("动作交付状态与前端执行体一致", () => {
  it("桩的清单与登记表逐条对应，不多不少", () => {
    expect(Object.keys(STUB_CLIENT_OP_TEXT).sort()).toEqual(declaredStubs);
  });

  it("每个桩都写明了缺什么", () => {
    for (const [name, item] of Object.entries(ASSISTANT_ACTION_DELIVERY)) {
      if (item.state === "definedOnly") expect(item.gapZh, `${name} 缺 gapZh`).toBeTruthy();
      else expect(item.gapZh, `${name} 已交付却写了 gapZh`).toBeUndefined();
    }
  });

  it("标为 executable 的动作没有一个落在桩清单里", () => {
    for (const [name, item] of Object.entries(ASSISTANT_ACTION_DELIVERY)) {
      if (item.state !== "executable" || item.clientOp === null) continue;
      expect(declaredStubs, `${name} 报成已交付但只有桩`).not.toContain(item.clientOp);
    }
  });

  it("桩派发后如实提示未执行，不假装成功", async () => {
    // 桩分支只读 clientOp，不碰其余依赖，给出 getHead 即可进入 switch
    const deps = { getHead: () => null } as unknown as Parameters<typeof runClientOp>[0];
    for (const clientOp of declaredStubs) {
      const result = await runClientOp(deps, { clientOp, actionName: "marquee_correction", args: {} });
      expect(result.tone).toBe("risk");
      expect(result.text).toContain("未执行");
    }
  });
});
