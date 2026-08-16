import { readSseStream } from "./sse.js";
import type { WorkspaceSnapshot } from "./workspace-snapshot.js";

// 助手回合客户端：对应服务端阶段 3 将挂载的三条路由。
// 会话与令牌模式照三个作业 client 的既有约定（GET /api/session 取 csrf 与能力令牌）。
export interface AssistantTurnEvent {
  type: "progress" | "action" | "ask" | "answer" | "failed";
  [key: string]: unknown;
}

export class AssistantClient {
  readonly #baseUrl: string;
  #active = false;

  constructor(baseUrl = "") {
    this.#baseUrl = baseUrl;
  }

  async #session(): Promise<{ csrfToken: string; assistantCapabilityToken: string }> {
    const response = await fetch(`${this.#baseUrl}/api/session`, { credentials: "include" });
    if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
    const body = (await response.json()) as { csrfToken?: string; assistantCapabilityToken?: string };
    if (!body.csrfToken || !body.assistantCapabilityToken) throw new Error("SESSION_TOKEN_MISSING");
    return { csrfToken: body.csrfToken, assistantCapabilityToken: body.assistantCapabilityToken };
  }

  async sendTurn(input: {
    text: string;
    snapshot: WorkspaceSnapshot;
    onEvent: (event: AssistantTurnEvent) => void;
  }): Promise<void> {
    if (this.#active) throw new Error("ASSISTANT_TURN_ALREADY_ACTIVE");
    this.#active = true;
    try {
      const session = await this.#session();
      const response = await fetch(`${this.#baseUrl}/api/assistant/turn`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
          "x-capability-token": session.assistantCapabilityToken,
        },
        body: JSON.stringify({
          turnId: crypto.randomUUID(),
          text: input.text,
          snapshot: input.snapshot,
        }),
      });
      if (!response.ok) throw new Error(`ASSISTANT_TURN_HTTP_${response.status}`);
      await readSseStream(response, (event) => input.onEvent(event as AssistantTurnEvent));
    } finally {
      this.#active = false;
    }
  }

  // 确认或拒绝一个 confirm 级动作。decision 为封闭集合，页面关闭等异常
  // 由服务端按通道不可用兜底（孤儿询问扫描）。
  async confirm(input: {
    confirmToken: string;
    decision: "allow_once" | "deny" | "user_withdrawn";
    onEvent: (event: AssistantTurnEvent) => void;
  }): Promise<void> {
    const session = await this.#session();
    const response = await fetch(`${this.#baseUrl}/api/assistant/confirm`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ confirmToken: input.confirmToken, decision: input.decision }),
    });
    if (!response.ok) throw new Error(`ASSISTANT_CONFIRM_HTTP_${response.status}`);
    await readSseStream(response, (event) => input.onEvent(event as AssistantTurnEvent));
  }
}
