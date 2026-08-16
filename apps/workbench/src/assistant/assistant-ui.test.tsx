import "fake-indexeddb/auto";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "./ChatPanel";
import { ConfirmBar } from "./ConfirmBar";
import type { AssistantClient, AssistantTurnEvent } from "./assistant-client";
import type { WorkspaceSnapshot } from "./workspace-snapshot";

afterEach(cleanup);

const snapshot: WorkspaceSnapshot = {
  projectId: null, currentStage: "evidence", openDockItems: 0, componentCount: 0,
  hasGeometryRevision: false, hasDrawings: false, hasDeliverable: false,
  modelRouteAvailable: false, unparsedEvidenceCount: 0,
};

function clientWithEvents(events: readonly AssistantTurnEvent[]): AssistantClient {
  return {
    sendTurn: async (input: { onEvent: (event: AssistantTurnEvent) => void }) => {
      for (const event of events) input.onEvent(event);
    },
    confirm: vi.fn(async () => undefined),
  } as unknown as AssistantClient;
}

async function sendText(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeDisabled());
}

describe("ChatPanel 事件到消息映射", () => {
  it("action 事件经 onClientOp 执行并追加结果消息", async () => {
    const onClientOp = vi.fn(async () => ({ text: "已切到构件清单", tone: "result" as const }));
    render(<ChatPanel
      client={clientWithEvents([
        { type: "progress", text: "正在理解你的指令" },
        { type: "action", actionName: "switch_view", text: "执行切换视图", clientOp: "ui:switch-view", args: { view: "构件清单" } },
      ])}
      buildSnapshot={() => snapshot}
      onClientOp={onClientOp}
    />);
    await sendText("切到构件清单");
    await waitFor(() => expect(screen.getByText("已切到构件清单")).toBeInTheDocument());
    expect(onClientOp).toHaveBeenCalledWith({ clientOp: "ui:switch-view", actionName: "switch_view", args: { view: "构件清单" } });
  });

  it("ask 事件展示动作卡片并暴露确认令牌", async () => {
    render(<ChatPanel
      client={clientWithEvents([{
        type: "ask", text: "生成三维模型需要你确认后才会执行", confirmToken: "token-1",
        card: { actionName: "generate_geometry", displayNameZh: "生成三维模型", argsSummaryZh: "{}", costlyEstimateZh: "该作业耗时较长", warnings: [] },
      }])}
      buildSnapshot={() => snapshot}
      onClientOp={vi.fn(async () => ({ text: "", tone: "result" as const }))}
    />);
    await sendText("生成三维");
    await waitFor(() => expect(screen.getByText("生成三维模型")).toBeInTheDocument());
    expect(screen.getByText(/耗时较长/)).toBeInTheDocument();
  });

  it("failed 事件按风险消息呈现", async () => {
    render(<ChatPanel
      client={clientWithEvents([{ type: "failed", text: "还没有几何版本，请先生成三维模型" }])}
      buildSnapshot={() => snapshot}
      onClientOp={vi.fn(async () => ({ text: "", tone: "result" as const }))}
    />);
    await sendText("出图");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("还没有几何版本"));
  });
});

describe("ConfirmBar 决定值", () => {
  it("三个按钮分别产生封闭集合的三个决定", () => {
    const onDecision = vi.fn();
    render(<ConfirmBar disabled={false} onDecision={onDecision} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) fireEvent.click(button);
    expect(onDecision.mock.calls.map((call) => call[0]).sort()).toEqual(["allow_once", "deny", "user_withdrawn"]);
  });
});
