// 助手消息模型：05 界面与交互形态表 5 的四类消息。停靠提问未回答前该分支不继续，
// 风险提示与提问同级且不可折叠，由渲染层保证。
export type AssistantMessageKind = "progress" | "result" | "dock-question" | "risk";

export interface AssistantMessage {
  id: string;
  who: "user" | "assistant";
  kind: AssistantMessageKind | "plain";
  text: string;
  actionName?: string;
  confirmToken?: string;
  resolved?: boolean;
}

export function newMessage(input: Omit<AssistantMessage, "id">): AssistantMessage {
  return { id: crypto.randomUUID(), ...input };
}
