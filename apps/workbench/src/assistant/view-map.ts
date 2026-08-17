import type { WorkspaceViewName } from "@gujian/domain";

// 视图名取自 WORKSPACE_VIEW_NAMES，每个视图都要有一行，测试有覆盖检查。
// 缺失视图不从目录移除（目录稳定原则），切换时落到最近替代 stage 并返回结构化说明。
export interface ViewMapping {
  view: WorkspaceViewName;
  stageId: string;
  implemented: boolean;
  noteZh: string | null;
}

const MAPPINGS: readonly ViewMapping[] = [
  { view: "任务卡", stageId: "tasks", implemented: true, noteZh: null },
  { view: "资料清单", stageId: "evidence", implemented: true, noteZh: null },
  { view: "实测基准", stageId: "measurements", implemented: true, noteZh: null },
  { view: "构件清单", stageId: "objects", implemented: true, noteZh: null },
  { view: "现状记录", stageId: "conditions", implemented: true, noteZh: null },
  { view: "三维模型", stageId: "geometry", implemented: true, noteZh: null },
  { view: "问题队列", stageId: "issues", implemented: true, noteZh: null },
  { view: "图纸样式", stageId: "sheetStyle", implemented: true, noteZh: null },
  { view: "图纸与检查", stageId: "drawings", implemented: true, noteZh: "图纸与检查在工作台中分为图纸和检查两个页签，已切到图纸" },
  { view: "交付包", stageId: "package", implemented: true, noteZh: null },
  { view: "模型运行与费用", stageId: "candidates", implemented: true, noteZh: null },
];

export function resolveView(view: string): ViewMapping | null {
  return MAPPINGS.find((m) => m.view === view) ?? null;
}

export const ALL_VIEW_MAPPINGS = MAPPINGS;
