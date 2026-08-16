import type { AssistantMessage } from "./messages";

// 四类助手消息的渲染：进度可折叠、结果带卡片、停靠提问突出、风险不可折叠。
const KIND_CLASS: Record<string, string> = {
  progress: "assistant-msg assistant-msg-progress",
  result: "assistant-msg assistant-msg-result",
  "dock-question": "assistant-msg assistant-msg-dock",
  risk: "assistant-msg assistant-msg-risk",
  plain: "assistant-msg",
};

export function MessageList({ messages }: { messages: readonly AssistantMessage[] }) {
  return (
    <div className="assistant-message-list" role="log">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`${KIND_CLASS[message.kind] ?? "assistant-msg"} assistant-msg-${message.who}`}
          role={message.kind === "risk" ? "alert" : undefined}
        >
          {message.kind === "dock-question" && <span className="assistant-msg-tag">需要你决定</span>}
          {message.kind === "risk" && <span className="assistant-msg-tag">风险提示</span>}
          <p>{message.text}</p>
        </div>
      ))}
    </div>
  );
}
