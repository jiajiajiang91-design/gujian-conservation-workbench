import type { ProjectHead } from "@gujian/application";

import { buildModificationProposal, type AssistantExecutors, type ModificationProposal } from "./action-executors.js";
import type { MeasurementForCheck } from "./value-check.js";

// clientOp 适配器：把服务端 action 事件的 clientOp 前缀翻译为真实执行。
// ui:* 走执行体与界面回调，job:* 调用挂载方注入的既有作业触发器；
// 服务端不代发作业、不持有项目状态，与既定架构一致。

export interface ClientOpDeps {
  executors: AssistantExecutors;
  getHead: () => ProjectHead | null;
  getOpenDockItems: () => number;
  knownRefs: () => readonly string[];
  measurements: () => readonly MeasurementForCheck[];
  switchStage: (stageId: string) => void;
  exitProject: () => void;
  advanceStage: () => string | null;
  jobProgressSummary: () => string;
  startGeometryJob: () => Promise<void>;
  startDrawingJob: () => Promise<void>;
  startModelJob: () => Promise<void>;
  exportPackage: (format: string) => Promise<void>;
  runDataCheck: () => Promise<void>;
  presentProposal: (proposal: ModificationProposal) => void;
}

export interface ClientOpResult {
  text: string;
  tone: "result" | "risk";
}

const ok = (text: string): ClientOpResult => ({ text, tone: "result" });
const warn = (text: string): ClientOpResult => ({ text, tone: "risk" });

// 只有桩、还没有真执行体的客户端操作。集中写在这里而不是散在 switch 里，
// 交付状态测试据此与 domain 的登记表逐条比对：少一条是漏实现，
// 多一条是登记表说已交付而前端其实没做。
export const STUB_CLIENT_OP_TEXT: Readonly<Record<string, string>> = {};


// 两个归一化矩形是否相交。框选命中构件用它判，不做面积占比阈值：
// 框到一角也算指到了这个构件，阈值多少是个没有出处的数。
function overlaps(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    first.x + first.width <= second.x || second.x + second.width <= first.x
    || first.y + first.height <= second.y || second.y + second.height <= first.y
  );
}

function toResult(outcome: { kind: string; messageZh?: string; reasonZh?: string }): ClientOpResult {
  if (outcome.kind === "rejected") return warn(outcome.reasonZh ?? "本条未执行");
  return ok(outcome.messageZh ?? "已执行");
}

function factValueText(head: ProjectHead | null, subjectRef: string, field: string): string {
  const fact = head?.snapshot.facts.find((item) => item.subjectRef === subjectRef && item.field === field);
  return fact ? JSON.stringify(fact.value) : "无既有记录";
}

function deliveryDraftSummary(head: ProjectHead): string {
  const measurementCount = head.snapshot.measurements.length;
  const confirmedFacts = head.snapshot.facts.filter((item) => item.reviewStatus === "confirmed").length;
  const openIssues = head.snapshot.issues.filter((item) => item.status === "open").length;
  const unreviewed = head.snapshot.facts.filter((item) => item.reviewStatus === "unreviewed").length;
  return [
    "交付说明草稿（逐条核对后采用）：",
    `1. 尺寸依据：${measurementCount} 条测量记录，${confirmedFacts} 条已确认事实。`,
    "2. 限制条件：generated-not-qualified / L1=false / 代理成果 / 未签发，不可用于正式交付或施工。",
    `3. 未确认项：${openIssues} 个开放问题，${unreviewed} 条未核对事实。`,
  ].join("\n");
}

export async function runClientOp(
  deps: ClientOpDeps,
  input: { clientOp: string; actionName: string; args: unknown },
): Promise<ClientOpResult> {
  const args = (input.args ?? {}) as Record<string, unknown>;
  const head = deps.getHead();
  switch (input.clientOp) {
    case "ui:switch-view": {
      const outcome = deps.executors.switchView(String(args.view ?? ""));
      if (outcome.kind !== "ui") return warn(outcome.kind === "rejected" ? outcome.reasonZh : "视图切换失败");
      // 项目级页面与工作区视图分开处理，不共用一个 stage 标识。
      if (outcome.intent.op === "exitProject") {
        deps.exitProject();
        return ok(outcome.messageZh);
      }
      if (outcome.intent.op !== "switchStage") return warn("视图切换失败");
      deps.switchStage(outcome.intent.stageId);
      return ok(outcome.messageZh);
    }
    case "ui:locate": {
      const outcome = deps.executors.locateEvidence(String(args.ref ?? ""), deps.knownRefs());
      if (outcome.kind !== "ui") return warn(outcome.kind === "rejected" ? outcome.reasonZh : "定位失败");
      deps.switchStage("objects");
      return ok(`${outcome.messageZh}，已切到对象与构件页`);
    }
    case "ui:advance": {
      const outcome = deps.executors.advanceWorkflow(deps.getOpenDockItems());
      if (outcome.kind !== "ui") return warn(outcome.kind === "rejected" ? outcome.reasonZh : "无法推进");
      const next = deps.advanceStage();
      return next ? ok(`${outcome.messageZh}：${next}`) : warn("已在最后一个环节，无法继续推进");
    }
    case "ui:job-progress":
      return ok(deps.jobProgressSummary());
    case "ui:run-check": {
      if (!head) return warn("请先选择项目");
      await deps.runDataCheck();
      return ok("检查完成，结果已写入检查记录，停靠事项见问题队列");
    }
    case "ui:propose-modification": {
      if (!head) return warn("请先选择项目");
      const subjectRef = String(args.subjectRef ?? "");
      const payload = (args.payload ?? {}) as Record<string, unknown>;
      const field = String(payload.field ?? args.changeType ?? "value");
      const proposal = buildModificationProposal({
        subjectRef,
        subjectName: deps.knownRefs().find((ref) => ref === subjectRef || ref.includes(subjectRef)) ?? subjectRef,
        field,
        oldValueText: factValueText(head, subjectRef, field),
        newValueText: JSON.stringify(payload.value ?? payload),
        value: payload.value ?? payload,
        rationaleZh: String(payload.rationale ?? `助手建议的${String(args.changeType ?? "修改")}`),
        modelRunId: null,
        measurements: deps.measurements(),
      });
      deps.presentProposal(proposal);
      return ok(`已生成修改建议：${proposal.subjectName} 的 ${proposal.field}，逐条确认后才会生效${proposal.warnings.length ? `（${proposal.warnings.length} 条核对警示）` : ""}`);
    }
    case "ui:marquee-correction": {
      if (!head) return warn("请先选择项目");
      const selection = args.selection as {
        evidenceId?: string;
        rectNormalized?: { x: number; y: number; width: number; height: number };
      } | undefined;
      if (!selection?.evidenceId || !selection.rectNormalized) {
        return warn("这条要在照片上先框出位置。请在资料区的图片上框选，再说要改什么");
      }
      const evidence = head.snapshot.evidences.find((item) => item.id === selection.evidenceId);
      if (!evidence) return warn("框选所在的资料不在当前项目里，本条未执行");
      const instruction = String(args.instruction ?? "").trim();
      if (!instruction) return warn("框选之后还要说一句要改什么，本条未执行");
      const changeType = String(args.changeType ?? "");
      const rect = selection.rectNormalized;
      const positionText = `${evidence.title} 上 ${(rect.x * 100).toFixed(1)}%、${(rect.y * 100).toFixed(1)}% 起`
        + `，宽 ${(rect.width * 100).toFixed(1)}%、高 ${(rect.height * 100).toFixed(1)}%`;

      if (changeType === "新增") {
        const label = String(args.label ?? "").trim() || instruction.slice(0, 40);
        // 类别未定就如实写未定，不按名称猜类型
        return toResult(await deps.executors.commitMarqueeEntity(head, {
          name: label,
          entityType: "待确认",
          imageRegion: { evidenceRef: evidence.id, ...rect },
          locationText: positionText,
        }));
      }

      // 其余四类要先确定改的是哪个构件。只有带图上位置的构件能被框选命中；
      // 由形制参数或几何管线产出的构件没有图上位置，命不中时按表 11 提问，不猜。
      const hits = head.snapshot.entities.filter((item) => item.imageRegion
        && item.imageRegion.evidenceRef === evidence.id
        && overlaps(rect, item.imageRegion));
      if (hits.length === 0) {
        const positioned = head.snapshot.entities.filter((item) => item.imageRegion).length;
        return warn(positioned === 0
          ? `框选位置已记下，但本项目还没有任何构件带图上位置，无法按框选对应到构件。`
            + `请说明是哪个构件，或先用框选新增把它记下来。`
          : `框选位置上没有已登记的构件。请说明是哪个构件，或换一个位置重框。`);
      }
      if (hits.length > 1) {
        return warn(`框选位置上有 ${hits.length} 个构件：${hits.map((item) => item.name).join("、")}。`
          + `请说明是哪一个，或把框收小一些。`);
      }

      const target = hits[0]!;
      if (changeType === "删除") {
        return toResult(await deps.executors.commitExclusion(head, {
          subjectDescriptionZh: target.name,
          categoryZh: target.entityType,
          reasonZh: `用户在${positionText}框选并说明：${instruction}`,
          originRef: target.id,
        }));
      }

      const field = changeType === "类别修改" ? "entityType"
        : changeType === "位置调整" ? "imageRegion"
        : "visibility";
      const value = changeType === "类别修改" ? (String(args.label ?? "").trim() || instruction)
        : changeType === "位置调整" ? { evidenceRef: evidence.id, ...rect }
        : { state: "不可见", needsReshoot: true, reasonZh: instruction };
      const proposal = buildModificationProposal({
        subjectRef: target.id,
        subjectName: target.name,
        field,
        oldValueText: changeType === "类别修改" ? target.entityType : JSON.stringify(target.imageRegion ?? null),
        newValueText: typeof value === "string" ? value : JSON.stringify(value),
        value,
        rationaleZh: `用户在${positionText}框选并说明：${instruction}`,
        modelRunId: null,
        measurements: deps.measurements(),
      });
      deps.presentProposal(proposal);
      return ok(`已按框选位置对${target.name}生成${changeType}建议，逐条确认后才会生效`);
    }
    case "ui:draft-delivery-note":
      return head ? ok(deliveryDraftSummary(head)) : warn("请先选择项目");
    case "ui:export": {
      if (!head) return warn("请先选择项目");
      const format = String(args.format ?? "zip");
      if (format === "zip" || format === "json") {
        await deps.exportPackage(format);
        return ok(`已导出 ${format.toUpperCase()} 项目包`);
      }
      deps.switchStage("drawings");
      return ok(`${format.toUpperCase()} 为单项成果下载，已切到成组图纸页，请在成果列表中下载`);
    }
    case "job:cad": {
      if (!head) return warn("请先选择项目");
      await deps.startGeometryJob();
      return ok("三维生成作业已发起，进度见助手面板与三维模型页");
    }
    case "job:drawing": {
      if (!head) return warn("请先选择项目");
      await deps.startDrawingJob();
      return ok("图纸生成作业已发起，进度见成组图纸页");
    }
    case "job:model-recognition":
    case "job:model-parse": {
      if (!head) return warn("请先选择项目");
      await deps.startModelJob();
      return ok(input.clientOp === "job:model-parse"
        ? "资料解析运行已发起，候选结果将进入候选区，逐条确认后生效"
        : "重新识别运行已发起，结果标注 AI 实时，需人工核对");
    }
    default:
      return warn(`该动作的客户端执行尚未接入（${input.clientOp}），本条未执行`);
  }
}
