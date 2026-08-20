// 助手动作的交付登记表（05 界面与交互形态第八节通用约定 5）。
//
// 为什么放在 domain：交付状态与客户端操作名都是服务端目录与前端执行体之间的
// 契约，两边都要认。apps/workbench 不依赖 apps/server，把表写在任一侧都无法被
// 另一侧校验。曾因此出现文档写"本期交付 14 个受控动作"，而其中一个前端只有桩。
//
// 这份表是实现状态的唯一来源。文档陈述实现状态时按它写，不另行叙述。

export type ActionDeliveryState =
  // 前端执行体真实可跑，端到端可用，投影进模型可见目录
  | "executable"
  // 只有目录定义与参数校验，前端执行体缺失或只有桩。
  // 不投影进模型可见目录：让模型选中一个必然失败的动作，等于把缺口
  // 转嫁成对话里的失败，而不是在目录层如实缺席。
  | "definedOnly";

export interface ActionDelivery {
  readonly state: ActionDeliveryState;
  // 客户端操作名。null 表示该动作不落客户端执行体（回答类动作直接出文本）。
  readonly clientOp: string | null;
  // definedOnly 必填：缺的是什么，补上什么才能转 executable
  readonly gapZh?: string;
}

export const ASSISTANT_ACTION_DELIVERY: Readonly<Record<string, ActionDelivery>> = {
  switch_view: { state: "executable", clientOp: "ui:switch-view" },
  locate_evidence: { state: "executable", clientOp: "ui:locate" },
  query_job_progress: { state: "executable", clientOp: "ui:job-progress" },
  answer_question: { state: "executable", clientOp: null },
  propose_modification: { state: "executable", clientOp: "ui:propose-modification" },
  marquee_correction: { state: "executable", clientOp: "ui:marquee-correction" },
  rerun_recognition: { state: "executable", clientOp: "job:model-recognition" },
  advance_workflow: { state: "executable", clientOp: "ui:advance" },
  run_data_check: { state: "executable", clientOp: "ui:run-check" },
  generate_geometry: { state: "executable", clientOp: "job:cad" },
  generate_drawings: { state: "executable", clientOp: "job:drawing" },
  export_deliverable: { state: "executable", clientOp: "ui:export" },
  draft_delivery_note: { state: "executable", clientOp: "ui:draft-delivery-note" },
  parse_task_brief: { state: "executable", clientOp: "job:model-parse" },
};

export function actionDelivery(name: string): ActionDelivery | null {
  return ASSISTANT_ACTION_DELIVERY[name] ?? null;
}

function namesByState(state: ActionDeliveryState): string[] {
  return Object.entries(ASSISTANT_ACTION_DELIVERY)
    .filter(([, item]) => item.state === state)
    .map(([name]) => name)
    .sort();
}

export function executableActionNames(): string[] {
  return namesByState("executable");
}

export function definedOnlyActionNames(): string[] {
  return namesByState("definedOnly");
}

// 只有桩的客户端操作名。前端据此断言桩与登记表一致，不多不少。
export function stubClientOps(): string[] {
  return Object.values(ASSISTANT_ACTION_DELIVERY)
    .filter((item) => item.state === "definedOnly" && item.clientOp !== null)
    .map((item) => item.clientOp!)
    .sort();
}
