import { ALL_SWITCHABLE_VIEW_NAMES, type SwitchableViewName } from "@gujian/domain";

// 视图名取自 ALL_SWITCHABLE_VIEW_NAMES，每个视图都要有一行，测试有覆盖检查。
// 缺失视图不从目录移除（目录稳定原则），切换时落到最近替代 stage 并返回结构化说明。
//
// 两类视图语义不同，用带类型的联合表达，消费方按 kind 分派：
// 工作区视图是切换项目内的 stage；项目列表是退出当前项目回到列表页。
// 不给项目列表编一个假 stage 标识让消费方去猜。
export type ViewMapping =
  | { view: SwitchableViewName; kind: "stage"; stageId: string; implemented: boolean; noteZh: string | null }
  | { view: SwitchableViewName; kind: "exitProject"; implemented: boolean; noteZh: string | null };

const MAPPINGS: readonly ViewMapping[] = [
  { view: "任务卡", kind: "stage", stageId: "tasks", implemented: true, noteZh: null },
  { view: "资料清单", kind: "stage", stageId: "evidence", implemented: true, noteZh: null },
  { view: "实测基准", kind: "stage", stageId: "measurements", implemented: true, noteZh: null },
  { view: "构件清单", kind: "stage", stageId: "objects", implemented: true, noteZh: null },
  { view: "现状记录", kind: "stage", stageId: "conditions", implemented: true, noteZh: null },
  { view: "三维模型", kind: "stage", stageId: "geometry", implemented: true, noteZh: null },
  { view: "问题队列", kind: "stage", stageId: "issues", implemented: true, noteZh: null },
  { view: "图纸样式", kind: "stage", stageId: "sheetStyle", implemented: true, noteZh: null },
  { view: "图纸与检查", kind: "stage", stageId: "drawings", implemented: true, noteZh: "图纸与检查在工作台中分为图纸和检查两个页签，已切到图纸" },
  { view: "交付包", kind: "stage", stageId: "package", implemented: true, noteZh: null },
  { view: "模型运行与费用", kind: "stage", stageId: "candidates", implemented: true, noteZh: null },
  { view: "项目列表", kind: "exitProject", implemented: true, noteZh: null },
];

export function resolveView(view: string): ViewMapping | null {
  return MAPPINGS.find((m) => m.view === view) ?? null;
}

export const ALL_VIEW_MAPPINGS = MAPPINGS;
export const SWITCHABLE_VIEW_NAMES = ALL_SWITCHABLE_VIEW_NAMES;
