import type { ProjectHead } from "@gujian/application";
import type { HeritageEntity } from "@gujian/domain";

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
// 图上位置的中文说明。构件记录里位置与位置说明分开存，两处都要用这一个
// 写法，各拼各的迟早会分叉。
export function describeImageRegion(
  evidenceTitle: string,
  region: { x: number; y: number; width: number; height: number },
): string {
  return `${evidenceTitle} 上 ${(region.x * 100).toFixed(1)}%、${(region.y * 100).toFixed(1)}% 起`
    + `，宽 ${(region.width * 100).toFixed(1)}%、高 ${(region.height * 100).toFixed(1)}%`;
}

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

  // 框选新增的构件直接入库并留痕，不走逐条确认：表 10 规定新增与遮挡标记
  // 直接执行并留痕，只有删除进排除记录。
  async commitMarqueeEntity(head: ProjectHead, input: {
    name: string;
    entityType: string;
    imageRegion: { evidenceRef: string; x: number; y: number; width: number; height: number };
    locationText: string;
  }): Promise<ExecutionOutcome> {
    const building = head.snapshot.buildings[0];
    if (!building) return { kind: "rejected", reasonZh: "项目里还没有建筑，无法新增构件" };
    await this.#deps.commands.execute({
      commandType: "CommitEntities",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId: this.#deps.actorId(),
      expectedRevisionId: head.revisionId,
      issuedAt: new Date().toISOString(),
      payload: {
        entities: [{
          id: crypto.randomUUID(),
          projectId: head.projectId,
          buildingId: building.id,
          parentId: null,
          entityType: input.entityType,
          name: input.name,
          locationText: input.locationText,
          imageRegion: input.imageRegion,
          origin: "marquee",
        }],
      },
    });
    return { kind: "committed", messageZh: `已新增构件记录：${input.name}` };
  }

  // 识别产出的构件确认后入库。与框选新增走同一条命令，只是 origin 不同：
  // 一个是人工在图上圈出来的，一个是模型认出来再由人确认的，两者要分得开。
  async commitRecognizedComponents(head: ProjectHead, components: readonly {
    nameZh: string;
    categoryZh: string | null;
    evidenceRef: string;
    region: { x: number; y: number; width: number; height: number };
  }[]): Promise<ExecutionOutcome> {
    const building = head.snapshot.buildings[0];
    if (!building) return { kind: "rejected", reasonZh: "项目里还没有建筑，无法写入构件" };
    if (!components.length) return { kind: "rejected", reasonZh: "没有可写入的构件" };
    await this.#deps.commands.execute({
      commandType: "CommitEntities",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId: this.#deps.actorId(),
      expectedRevisionId: head.revisionId,
      issuedAt: new Date().toISOString(),
      payload: {
        entities: components.map((item) => ({
          id: crypto.randomUUID(),
          projectId: head.projectId,
          buildingId: building.id,
          parentId: null,
          entityType: item.categoryZh ?? "待确认",
          name: item.nameZh,
          locationText: null,
          imageRegion: { evidenceRef: item.evidenceRef, ...item.region },
          origin: "recognition",
        })),
      },
    });
    return { kind: "committed", messageZh: `已写入 ${components.length} 个构件记录，来源为识别后人工确认` };
  }

  async commitExclusion(head: ProjectHead, input: {
    subjectDescriptionZh: string;
    categoryZh: string | null;
    reasonZh: string;
    originRef: string | null;
  }): Promise<ExecutionOutcome> {
    await this.#deps.commands.execute({
      commandType: "CommitExclusionRecords",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId: this.#deps.actorId(),
      expectedRevisionId: head.revisionId,
      issuedAt: new Date().toISOString(),
      payload: {
        records: [{
          id: crypto.randomUUID(),
          projectId: head.projectId,
          subjectDescriptionZh: input.subjectDescriptionZh,
          categoryZh: input.categoryZh,
          reasonZh: input.reasonZh,
          excludedBy: this.#deps.actorId(),
          occurredAt: new Date().toISOString(),
          originRef: input.originRef,
        }],
      },
    });
    return { kind: "committed", messageZh: `已记入排除记录：${input.subjectDescriptionZh}` };
  }

  async commitConfirmedModification(head: ProjectHead, proposal: ModificationProposal): Promise<ExecutionOutcome> {
    const command = buildCommitFactsCommand({
      head,
      actorId: this.#deps.actorId(),
      proposal,
    });
    const receipt = await this.#deps.commands.execute(command) as { revisionId?: string } | undefined;
    // 事实写完还要把构件记录本身改掉。只写事实的话，采纳了把类别改成撑栱
    // 之后构件表仍显示待确认，位置调整之后下一次框选命中仍按旧框判。
    // 事实那条不删：它承载来源、理由与复核状态，两者各管各的。
    //
    // 版本号取回执里的那个。写事实已经推进了一版，再拿入参那个旧版本去改
    // 构件记录必然撞上乐观并发，表现是采纳了但类别没变，界面上看不出失败。
    const revised = await this.#reviseEntityFromProposal(head, proposal, receipt?.revisionId ?? head.revisionId);
    return {
      kind: "committed",
      messageZh: revised
        ? `已生效：${proposal.subjectName} 的 ${proposal.field}，构件记录已同步更新`
        : `已生效：${proposal.subjectName} 的 ${proposal.field}`,
    };
  }

  // 修改建议指向的是构件记录时，把那条记录同步改掉。指向别的对象就不动，
  // 返回 false 让调用方如实说只写了事实。
  async #reviseEntityFromProposal(head: ProjectHead, proposal: ModificationProposal, revisionId: string): Promise<boolean> {
    const target = head.snapshot.entities.find((item) => item.id === proposal.subjectRef);
    if (!target) return false;
    // 位置改了，位置说明要跟着改。两者分开存，只改一个就会出现记录说位置在
    // 30%、65%，同一行的说明写着 20%、55%，读的人不知道该信哪个。
    const movedRegion = proposal.value as HeritageEntity["imageRegion"];
    const next = proposal.field === "entityType" ? { ...target, entityType: String(proposal.value) }
      : proposal.field === "imageRegion" ? {
        ...target,
        imageRegion: movedRegion,
        locationText: movedRegion
          ? describeImageRegion(head.snapshot.evidences.find((item) => item.id === movedRegion.evidenceRef)?.title ?? "资料原件", movedRegion)
          : target.locationText,
      }
      : proposal.field === "visibility" ? { ...target, visibility: proposal.value as HeritageEntity["visibility"] }
      : null;
    if (!next) return false;
    await this.#deps.commands.execute({
      commandType: "ReviseEntities",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId: this.#deps.actorId(),
      expectedRevisionId: revisionId,
      issuedAt: new Date().toISOString(),
      payload: { entities: [next] },
    });
    return true;
  }

  // 遮挡标记直接执行。按 2026-08-20 的处置，新增与遮挡标记不走逐条确认：
  // 用户已经在图上圈了位置又说明了看不见什么，再要一次确认没有新增信息。
  // 理由写进记录本身，因此不依赖修改历史视图也留得住。
  async markEntityHidden(head: ProjectHead, input: {
    entityId: string;
    reasonZh: string;
  }): Promise<ExecutionOutcome> {
    const target = head.snapshot.entities.find((item) => item.id === input.entityId);
    if (!target) return { kind: "rejected", reasonZh: "要标记的构件不在当前项目里，本条未执行" };
    await this.#deps.commands.execute({
      commandType: "ReviseEntities",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId: this.#deps.actorId(),
      expectedRevisionId: head.revisionId,
      issuedAt: new Date().toISOString(),
      payload: {
        entities: [{ ...target, visibility: { state: "不可见", needsReshoot: true, reasonZh: input.reasonZh } }],
      },
    });
    return { kind: "committed", messageZh: `已标记为不可见并记下原因：${target.name}` };
  }
}
