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
    case "ui:marquee-correction":
      return warn("框选修正需要在照片上框选位置，图片框选界面尚未接入，本条未执行");
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
