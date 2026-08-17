import type { WorkspaceViewName } from "@gujian/domain";

import { validateActionCall, type ActionDefinition } from "./action-catalog.js";

export interface ModelToolCall {
  kind: "tool_call";
  name: string;
  argumentsJson: string;
  raw: string;
}
export interface ModelTextReply {
  kind: "text";
  content: string;
  raw: string;
}
export type ModelDispatchOutcome = ModelToolCall | ModelTextReply;

// 模型分发运行器由调用方注入（生产环境为 KimiGateway.executeWithTools）。
// retryIssues 非空表示这是对上一次参数错误的重试调用。
export type ModelDispatchRunner = (input: {
  userText: string;
  retryIssues: string[] | null;
}) => Promise<ModelDispatchOutcome>;

export type DispatchDecision =
  | { kind: "action"; action: ActionDefinition; args: unknown; source: "model" | "keyword"; trace: DispatchTrace }
  | { kind: "answer"; text: string; source: "model" | "keyword"; trace: DispatchTrace };

export interface DispatchTrace {
  attempts: Array<{ source: "model" | "keyword"; resultCode: string; raw: string | null }>;
}

// 关键词退路：移植自旧原型 orchestrator.js userSay（738-807 行）的正则表。
// 关键词无法构造带参动作（如修改建议需要 subjectRef），这类表达一律落回答问题兜底。
// 视图名取自 WORKSPACE_VIEW_NAMES，每个视图都要有一行，测试有覆盖检查。
// 关键词取窄不取宽：单独的"检查""模型""问题"同时是作业动作和视图名，
// 放进这张表会把运行检查、生成三维一类的请求错判成切视图。
export const VIEW_JUMP: Array<[RegExp, WorkspaceViewName]> = [
  [/任务/, "任务卡"],
  [/资料/, "资料清单"],
  [/实测|尺寸/, "实测基准"],
  [/构件/, "构件清单"],
  [/现状/, "现状记录"],
  [/三维/, "三维模型"],
  [/问题队列|待办/, "问题队列"],
  [/样式/, "图纸样式"],
  [/图纸/, "图纸与检查"],
  [/交付/, "交付包"],
  [/费用|用量|运行记录/, "模型运行与费用"],
];

// 切视图带明确的动词前缀（看、去、打开、切到），意图比作业类关键词明确，
// 必须先判。否则"看三维模型"会被派成生成三维这类高成本作业动作。
function viewJump(text: string): { name: string; args: unknown } | null {
  for (const [re, view] of VIEW_JUMP) {
    if (new RegExp(`(看|去|打开|切到).*(${re.source})`).test(text)) {
      return { name: "switch_view", args: { view } };
    }
  }
  return null;
}

export function keywordFallback(text: string): { name: string; args: unknown } {
  const jump = viewJump(text);
  if (jump) return jump;
  if (/重新识别/.test(text)) return { name: "rerun_recognition", args: {} };
  if (/继续|往下|接着/.test(text)) return { name: "advance_workflow", args: {} };
  if (/出图|开始画|画图/.test(text)) return { name: "generate_drawings", args: {} };
  if (/生成三维|三维模型|建模/.test(text)) return { name: "generate_geometry", args: {} };
  if (/交付|组包|导出/.test(text)) return { name: "export_deliverable", args: { format: "zip" } };
  if (/解析任务书|盘点资料|解析资料/.test(text)) return { name: "parse_task_brief", args: {} };
  if (/检查/.test(text)) return { name: "run_data_check", args: {} };
  if (/进度|还要多久|跑完/.test(text)) return { name: "query_job_progress", args: {} };
  return { name: "answer_question", args: { question: text } };
}

// 三级降级：模型分发（参数错回模型重试一次）→ 关键词匹配 → 回答问题兜底。
// 全路径不抛异常、不中断对话；每次尝试进 trace 供留痕。
export async function dispatchUserText(
  text: string,
  options: {
    modelAvailable: boolean;
    runModel: ModelDispatchRunner;
  },
): Promise<DispatchDecision> {
  const trace: DispatchTrace = { attempts: [] };

  const keywordDecision = (): DispatchDecision => {
    const fallback = keywordFallback(text);
    const validated = validateActionCall(fallback.name, fallback.args);
    if (!validated.ok) {
      trace.attempts.push({ source: "keyword", resultCode: validated.code, raw: null });
      return { kind: "answer", text, source: "keyword", trace };
    }
    trace.attempts.push({ source: "keyword", resultCode: "OK", raw: null });
    return { kind: "action", action: validated.action, args: validated.args, source: "keyword", trace };
  };

  if (!options.modelAvailable) return keywordDecision();

  let retryIssues: string[] | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let outcome: ModelDispatchOutcome;
    try {
      outcome = await options.runModel({ userText: text, retryIssues });
    } catch (error) {
      trace.attempts.push({
        source: "model",
        resultCode: `MODEL_ERROR:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
        raw: null,
      });
      return keywordDecision();
    }

    if (outcome.kind === "text") {
      trace.attempts.push({ source: "model", resultCode: "TEXT_REPLY", raw: outcome.raw });
      return { kind: "answer", text: outcome.content, source: "model", trace };
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = outcome.argumentsJson.trim() === "" ? {} : JSON.parse(outcome.argumentsJson);
    } catch {
      trace.attempts.push({ source: "model", resultCode: "ARGS_NOT_JSON", raw: outcome.raw });
      retryIssues = ["arguments 不是合法 JSON"];
      continue;
    }
    const validated = validateActionCall(outcome.name, parsedArgs);
    if (validated.ok) {
      trace.attempts.push({ source: "model", resultCode: "OK", raw: outcome.raw });
      return { kind: "action", action: validated.action, args: validated.args, source: "model", trace };
    }
    trace.attempts.push({ source: "model", resultCode: validated.code, raw: outcome.raw });
    retryIssues = validated.code === "INVALID_ARGS"
      ? validated.issues
      : [`动作 ${outcome.name} 不在清单内，只能从提供的动作中选择`];
  }

  return keywordDecision();
}
