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

// 桩清单清空后，上面四条会全部落在空集上通过，不再能发现任何漂移。
// 这条补位：登记表说已交付的动作，必须在 switch 里真有 case。
// 没有 case 就落到兜底分支，那条分支同样回"尚未接入"，与桩没有区别。
describe("已交付动作不落兜底分支", () => {
  it("每个 executable 的 clientOp 在适配器里都有对应 case", async () => {
    // 除 getHead 外的依赖一律触即抛：进了真分支必然碰依赖或提前返回，
    // 落到兜底分支则一个依赖都不碰，直接返回未执行文案，两者由此区分。
    const trip = () => { throw new Error("依赖被触达"); };
    const deps = new Proxy({}, {
      get: (_target, key) => (key === "getHead" ? () => null : new Proxy(trip, { get: () => trip })),
    }) as unknown as Parameters<typeof runClientOp>[0];

    const delivered = Object.entries(ASSISTANT_ACTION_DELIVERY)
      .filter(([, item]) => item.state === "executable" && item.clientOp !== null);
    // 防止这条测试自己变成空过：登记表若被清空，遍历零次也会绿
    expect(delivered.length).toBeGreaterThan(10);

    for (const [name, item] of delivered) {
      let text: string;
      try {
        text = (await runClientOp(deps, { clientOp: item.clientOp, actionName: name, args: {} })).text;
      } catch {
        continue;
      }
      expect(text, `${name} 的 ${item.clientOp} 没有 case，落到兜底分支`).not.toContain("尚未接入");
    }
  });
});
