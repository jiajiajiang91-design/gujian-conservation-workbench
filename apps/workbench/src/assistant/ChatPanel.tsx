import { useCallback, useRef, useState } from "react";

import { ActionCard, type ActionCardData } from "./ActionCard";
import type { AssistantClient, AssistantTurnEvent } from "./assistant-client";
import { ConfirmBar } from "./ConfirmBar";
import { MessageList } from "./MessageList";
import { newMessage, type AssistantMessage } from "./messages";
import type { UiIntent } from "./action-executors";
import type { WorkspaceSnapshot } from "./workspace-snapshot";

// 助手对话面板。阶段 3 挂载进 App.tsx；此前不被任何文件引用。
// 依赖全部经 props 注入：回合客户端、快照供给、界面意图回调。
export interface ChatPanelProps {
  client: AssistantClient;
  buildSnapshot: () => WorkspaceSnapshot;
  onUiIntent: (intent: UiIntent) => void;
}

interface PendingConfirm {
  confirmToken: string;
  card: ActionCardData;
}

export function ChatPanel({ client, buildSnapshot, onUiIntent }: ChatPanelProps) {
  const [messages, setMessages] = useState<readonly AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const uiIntentRef = useRef(onUiIntent);
  uiIntentRef.current = onUiIntent;

  const append = useCallback((message: AssistantMessage) => {
    setMessages((existing) => [...existing, message]);
  }, []);

  const handleEvent = useCallback((event: AssistantTurnEvent) => {
    switch (event.type) {
      case "progress":
        append(newMessage({ who: "assistant", kind: "progress", text: String(event.text ?? "") }));
        break;
      case "answer":
        append(newMessage({ who: "assistant", kind: "plain", text: String(event.text ?? "") }));
        break;
      case "action": {
        append(newMessage({
          who: "assistant",
          kind: "result",
          text: String(event.text ?? ""),
          ...(typeof event.actionName === "string" ? { actionName: event.actionName } : {}),
        }));
        const intent = event.uiIntent as UiIntent | undefined;
        if (intent) uiIntentRef.current(intent);
        break;
      }
      case "ask": {
        const card = event.card as ActionCardData | undefined;
        const confirmToken = typeof event.confirmToken === "string" ? event.confirmToken : null;
        append(newMessage({
          who: "assistant",
          kind: "dock-question",
          text: String(event.text ?? "该动作需要你确认后才会执行"),
        }));
        if (card && confirmToken) setPendingConfirm({ confirmToken, card });
        break;
      }
      case "failed":
        append(newMessage({ who: "assistant", kind: "risk", text: String(event.text ?? "执行失败") }));
        break;
      default:
        break;
    }
  }, [append]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    append(newMessage({ who: "user", kind: "plain", text }));
    try {
      await client.sendTurn({ text, snapshot: buildSnapshot(), onEvent: handleEvent });
    } catch (error) {
      append(newMessage({
        who: "assistant",
        kind: "risk",
        text: `本轮请求失败：${error instanceof Error ? error.message : "未知错误"}`,
      }));
    } finally {
      setBusy(false);
    }
  }, [append, buildSnapshot, busy, client, handleEvent, input]);

  const decide = useCallback(async (decision: "allow_once" | "deny" | "user_withdrawn") => {
    if (!pendingConfirm) return;
    const confirmToken = pendingConfirm.confirmToken;
    setPendingConfirm(null);
    setBusy(true);
    try {
      await client.confirm({ confirmToken, decision, onEvent: handleEvent });
    } catch (error) {
      append(newMessage({
        who: "assistant",
        kind: "risk",
        text: `确认提交失败，本次按未执行处理：${error instanceof Error ? error.message : "未知错误"}`,
      }));
    } finally {
      setBusy(false);
    }
  }, [append, client, handleEvent, pendingConfirm]);

  return (
    <section className="assistant-chat-panel">
      <MessageList messages={messages} />
      {pendingConfirm && (
        <div className="assistant-pending-confirm">
          <ActionCard data={pendingConfirm.card} />
          <ConfirmBar disabled={busy} onDecision={(decision) => void decide(decision)} />
        </div>
      )}
      <div className="assistant-input-row">
        <textarea
          value={input}
          placeholder="对助手说要做什么，例如：把 P48 的长度改成 620，或：生成图纸"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" disabled={busy || !input.trim()} onClick={() => void send()}>
          发送
        </button>
      </div>
    </section>
  );
}
