import { createHash } from "node:crypto";

import { actionDelivery } from "@gujian/domain";
import { z } from "zod";

import { ActionLedger, type ConfirmationDecision } from "./action-ledger.js";
import type { ActionDefinition } from "./action-catalog.js";
import { modelFacingCatalog } from "./action-catalog.js";
import { ConfirmationTokenStore } from "./capability-tokens.js";
import { dispatchUserText, type ModelDispatchRunner } from "./dispatch.js";
import { evaluatePrecondition } from "./preconditions.js";
import { WorkspaceSnapshotSchema, type WorkspaceSnapshot } from "./snapshot-types.js";

// 助手回合的完整处理逻辑，独立于 index.ts：合并窗口只需在会话闸门后
// 各加一行转发（turn 与 confirm）。作业类动作确认后不在服务端代发，
// 而是下发 clientOp 指令由客户端用既有作业单例触发，服务端不持有项目状态。

export const TurnRequestSchema = z.object({
  turnId: z.uuid(),
  text: z.string().min(1).max(4_000),
  snapshot: WorkspaceSnapshotSchema,
}).strict();

export const ConfirmRequestSchema = z.object({
  confirmToken: z.string().min(8).max(200),
  decision: z.enum(["allow_once", "deny", "user_withdrawn"]),
}).strict();

export type SseEmit = (event: Record<string, unknown>) => void;

interface ToolGateway {
  configured: boolean;
  executeWithTools(input: {
    systemPrompt: string;
    userContent: string;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    signal: AbortSignal;
  }): Promise<
    | { kind: "tool_call"; name: string; argumentsJson: string; raw: string }
    | { kind: "text"; content: string; raw: string }
  >;
}

// 动作到客户端操作的映射取自 domain 的交付登记表：ui 类由执行体处理，
// job 类由客户端作业单例触发。映射不在此另写一份，否则与前端的执行体
// 会各自漂移，而两侧谁也校验不了谁。
const clientOpFor = (name: string): string | undefined => actionDelivery(name)?.clientOp ?? undefined;

function argsHash(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex");
}

function needsConfirmation(action: ActionDefinition, args: unknown): boolean {
  if (action.confirmLevel !== "confirm") return false;
  // 导出：普通格式直接执行，交付级（zip）确认后执行（表 10 语义）。
  if (action.name === "export_deliverable") {
    return (args as { format?: string }).format === "zip";
  }
  return true;
}

function systemPrompt(snapshot: WorkspaceSnapshot): string {
  return [
    "你是古建测绘工作台的操作助手。根据用户这句话，从提供的动作中选择一个调用；",
    "只在没有任何动作匹配、纯属提问或闲聊时用文字回答。",
    "不要虚构动作参数；用户没说清楚的参数宁可省略让校验提示。",
    `当前工作区：环节 ${snapshot.currentStage ?? "未知"}，` +
    `停靠事项 ${snapshot.openDockItems ?? "未知"} 项，构件 ${snapshot.componentCount ?? "未知"} 个，` +
    `几何版本${snapshot.hasGeometryRevision ? "已有" : "没有"}，图纸${snapshot.hasDrawings ? "已有" : "没有"}。`,
  ].join("\n");
}

export class AssistantRuntime {
  readonly #gateway: ToolGateway;
  readonly #ledger: ActionLedger;
  readonly #tokens: ConfirmationTokenStore;
  // 待确认动作的参数暂存：确认令牌兑付后按 confirmId 取回执行参数与分发来源。
  readonly #pendingArgs = new Map<string, { action: ActionDefinition; args: unknown; source: "model" | "keyword" }>();

  constructor(options: {
    gateway: ToolGateway;
    ledger?: ActionLedger;
    tokens?: ConfirmationTokenStore;
  }) {
    this.#gateway = options.gateway;
    this.#ledger = options.ledger ?? new ActionLedger();
    this.#tokens = options.tokens ?? new ConfirmationTokenStore();
  }

  get ledger(): ActionLedger {
    return this.#ledger;
  }

  async handleTurn(rawBody: unknown, sessionRef: string, emit: SseEmit, signal: AbortSignal): Promise<void> {
    const parsed = TurnRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      emit({ type: "failed", text: "请求格式不正确", issues: parsed.error.issues.map((issue) => issue.message) });
      return;
    }
    const { text, snapshot } = parsed.data;
    emit({ type: "progress", text: "正在理解你的指令" });

    const runModel: ModelDispatchRunner = async ({ userText, retryIssues }) => {
      const content = retryIssues
        ? `${userText}\n\n（上一次动作参数有误：${retryIssues.join("；")}。请修正后重新选择动作）`
        : userText;
      return this.#gateway.executeWithTools({
        systemPrompt: systemPrompt(snapshot),
        userContent: content,
        tools: modelFacingCatalog(),
        signal,
      });
    };

    const decision = await dispatchUserText(text, {
      modelAvailable: this.#gateway.configured && snapshot.modelRouteAvailable === true,
      runModel,
    });

    const modelAttempts = decision.trace.attempts.filter((attempt) => attempt.source === "model");
    const modelRaw = modelAttempts[modelAttempts.length - 1]?.raw ?? null;

    if (decision.kind === "answer") {
      this.#ledger.recordInvocation({
        sessionRef, actionName: "answer_question", argsHash: argsHash({ text }),
        source: decision.source, resultCode: "ANSWERED", modelRawOutput: modelRaw,
      });
      emit(
        decision.source === "model"
          ? { type: "answer", text: decision.text }
          : { type: "answer", text: "模型服务当前不可用，我只能执行明确的操作指令（如：切到构件清单、生成图纸）。你刚才的话我没有匹配到可执行的动作。" },
      );
      return;
    }

    const { action, args } = decision;
    const precondition = evaluatePrecondition(action.preconditionCode, snapshot);
    if (!precondition.satisfied) {
      this.#ledger.recordInvocation({
        sessionRef, actionName: action.name, argsHash: argsHash(args),
        source: decision.source, resultCode: "PRECONDITION_UNSATISFIED", modelRawOutput: modelRaw,
      });
      emit({ type: "failed", text: precondition.reasonZh, actionName: action.name });
      return;
    }

    if (needsConfirmation(action, args)) {
      const confirmId = crypto.randomUUID();
      const digest = argsHash(args);
      this.#ledger.recordAsk(confirmId, action.name, digest);
      this.#pendingArgs.set(confirmId, { action, args, source: decision.source });
      const confirmToken = this.#tokens.issue({ confirmId, actionName: action.name, argsHash: digest });
      this.#ledger.recordInvocation({
        sessionRef, actionName: action.name, argsHash: digest,
        source: decision.source, resultCode: "ASKED", modelRawOutput: modelRaw,
      });
      emit({
        type: "ask",
        text: `${action.displayNameZh}需要你确认后才会执行`,
        confirmToken,
        card: {
          actionName: action.name,
          displayNameZh: action.displayNameZh,
          argsSummaryZh: JSON.stringify(args),
          costlyEstimateZh: action.costly ? "该作业耗时较长，具体时长取决于项目规模，执行中可取消" : null,
          warnings: [],
        },
      });
      return;
    }

    this.#ledger.recordInvocation({
      sessionRef, actionName: action.name, argsHash: argsHash(args),
      source: decision.source, resultCode: "DISPATCHED", modelRawOutput: modelRaw,
    });
    emit({
      type: "action",
      actionName: action.name,
      text: `执行${action.displayNameZh}`,
      clientOp: clientOpFor(action.name) ?? "ui:unknown",
      args,
    });
  }

  async handleConfirm(rawBody: unknown, sessionRef: string, emit: SseEmit): Promise<void> {
    const parsed = ConfirmRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      emit({ type: "failed", text: "确认请求格式不正确" });
      return;
    }
    const redeemed = this.#tokens.redeem(parsed.data.confirmToken);
    if (!redeemed.ok) {
      emit({
        type: "failed",
        text: redeemed.code === "TOKEN_EXPIRED" ? "确认已过期，该动作未执行，需要时请重新发起" : "确认无效，该动作未执行",
      });
      return;
    }
    const { grant } = redeemed;
    const decision: ConfirmationDecision = parsed.data.decision;
    this.#ledger.recordDecision(grant.confirmId, decision, grant.actionName, grant.argsHash);
    const pending = this.#pendingArgs.get(grant.confirmId);
    this.#pendingArgs.delete(grant.confirmId);

    if (decision !== "allow_once") {
      emit({ type: "answer", text: decision === "deny" ? "已拒绝，该动作未执行。" : "已取消，该动作未执行。" });
      return;
    }
    if (!pending) {
      emit({ type: "failed", text: "确认已受理，但动作参数已失效，请重新发起" });
      return;
    }
    this.#ledger.recordInvocation({
      sessionRef, actionName: pending.action.name, argsHash: grant.argsHash,
      source: pending.source, resultCode: "CONFIRMED_DISPATCHED", modelRawOutput: null,
    });
    emit({
      type: "action",
      actionName: pending.action.name,
      text: `已确认，执行${pending.action.displayNameZh}`,
      clientOp: clientOpFor(pending.action.name) ?? "ui:unknown",
      args: pending.args,
    });
  }

  // 服务重启后对孤儿询问按通道不可用补决定（阶段 6 的启动扫描入口）。
  reconcileOrphanAsks(): number {
    const orphans = this.#ledger.orphanAsks();
    for (const orphan of orphans) {
      this.#ledger.recordDecision(orphan.confirmId, "channel_unavailable", orphan.actionName, "");
    }
    return orphans.length;
  }
}
