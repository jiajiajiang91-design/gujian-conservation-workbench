import type { ProjectHead } from "@gujian/application";

import { checkModification, type MeasurementForCheck } from "./value-check.js";
import { resolveView } from "./view-map.js";

// 客户端动作执行体。写入一律走 ProjectCommandService 唯一路径（幂等、乐观并发、
// 审计链内建）；界面类动作返回 UI 意图由挂载方执行；执行前由调用方完成
// 前置条件的本地二次校验（服务端按快照判过一次，这里堵时间差）。

export interface ExecutorDeps {
  commands: { execute: (command: unknown) => Promise<unknown> };
  workflow: { evaluate: (head: ProjectHead, actorId: string) => Promise<unknown> };
  actorId: () => string;
}

export type UiIntent =
  | { op: "switchStage"; stageId: string; noteZh: string | null }
  // 退出当前项目回到列表页。与切 stage 不是一回事，消费方分开处理。
  | { op: "exitProject" }
  | { op: "locate"; ref: string }
  | { op: "advance" };

export type ExecutionOutcome =
  | { kind: "ui"; intent: UiIntent; messageZh: string }
  | { kind: "committed"; messageZh: string }
  | { kind: "rejected"; reasonZh: string };

// 修改建议条目：AI 提议产出的待确认单元，逐条确认后才落库。
export interface ModificationProposal {
  proposalId: string;
  subjectRef: string;
  subjectName: string;
  field: string;
  oldValueText: string;
  newValueText: string;
  value: unknown;
  rationaleZh: string;
  modelRunId: string | null;
  warnings: string[];
}

export function buildModificationProposal(input: {
  subjectRef: string;
  subjectName: string;
  field: string;
  oldValueText: string;
  newValueText: string;
  value: unknown;
  rationaleZh: string;
  modelRunId: string | null;
  measurements: readonly MeasurementForCheck[];
}): ModificationProposal {
  return {
    proposalId: crypto.randomUUID(),
    subjectRef: input.subjectRef,
    subjectName: input.subjectName,
    field: input.field,
    oldValueText: input.oldValueText,
    newValueText: input.newValueText,
    value: input.value,
    rationaleZh: input.rationaleZh,
    modelRunId: input.modelRunId,
    warnings: checkModification(
      {
        subjectName: input.subjectName,
        field: input.field,
        oldValueText: input.oldValueText,
        newValueText: input.newValueText,
      },
      input.measurements,
    ),
  };
}

// 用户确认一条建议后落库：值的生产者按来源标记（模型建议为 model，
// 否则为 human），人工确认经 acceptanceRef 指向本次命令。
export function buildCommitFactsCommand(input: {
  head: ProjectHead;
  actorId: string;
  proposal: ModificationProposal;
}): Record<string, unknown> {
  const commandId = crypto.randomUUID();
  const producer = input.proposal.modelRunId
    ? { producerType: "model", runId: input.proposal.modelRunId }
    : {
        producerType: "human",
        actorId: input.actorId,
        actionRef: { commandId },
      };
  return {
    commandType: "CommitFacts",
    commandId,
    projectId: input.head.projectId,
    actorId: input.actorId,
    expectedRevisionId: input.head.revisionId,
    issuedAt: new Date().toISOString(),
    payload: {
      facts: [
        {
          id: crypto.randomUUID(),
          subjectRef: input.proposal.subjectRef,
          field: input.proposal.field,
          value: input.proposal.value,
          producer,
          evidenceRefs: [],
          reviewStatus: "confirmed",
          acceptanceRef: { type: "command", id: commandId },
          dataStatus: "available",
        },
      ],
    },
  };
}

export class AssistantExecutors {
  readonly #deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
  }

  switchView(view: string): ExecutionOutcome {
    const mapping = resolveView(view);
    if (!mapping) return { kind: "rejected", reasonZh: `未知视图: ${view}` };
    if (mapping.kind === "exitProject") {
      return { kind: "ui", intent: { op: "exitProject" }, messageZh: "已退出当前项目，回到项目列表" };
    }
    return {
      kind: "ui",
      intent: { op: "switchStage", stageId: mapping.stageId, noteZh: mapping.noteZh },
      messageZh: mapping.noteZh ?? `已切到${view}`,
    };
  }

  locateEvidence(ref: string, knownRefs: readonly string[]): ExecutionOutcome {
    const hit = knownRefs.find((known) => known === ref || known.includes(ref));
    if (!hit) return { kind: "rejected", reasonZh: `没有找到与"${ref}"对应的对象` };
    return { kind: "ui", intent: { op: "locate", ref: hit }, messageZh: `已定位到 ${hit}` };
  }

  advanceWorkflow(openDockItems: number): ExecutionOutcome {
    if (openDockItems > 0) {
      return { kind: "rejected", reasonZh: `当前环节还有 ${openDockItems} 项停靠事项未处理，处理完才能推进` };
    }
    return { kind: "ui", intent: { op: "advance" }, messageZh: "停靠事项已清，进入下一环节" };
  }

  async runDataCheck(head: ProjectHead): Promise<ExecutionOutcome> {
    await this.#deps.workflow.evaluate(head, this.#deps.actorId());
    return { kind: "committed", messageZh: "检查完成，结果已写入检查记录" };
  }

  async commitConfirmedModification(head: ProjectHead, proposal: ModificationProposal): Promise<ExecutionOutcome> {
    const command = buildCommitFactsCommand({
      head,
      actorId: this.#deps.actorId(),
      proposal,
    });
    await this.#deps.commands.execute(command);
    return { kind: "committed", messageZh: `已生效：${proposal.subjectName} 的 ${proposal.field}` };
  }
}
