// 13-6 八视图与工作台 stage 的映射。缺失视图不从目录移除（目录稳定原则），
// 切换时落到最近替代 stage 并返回结构化说明。
export interface ViewMapping {
  view: string;
  stageId: string;
  implemented: boolean;
  noteZh: string | null;
}

const MAPPINGS: readonly ViewMapping[] = [
  { view: "任务卡", stageId: "tasks", implemented: true, noteZh: null },
  { view: "资料清单", stageId: "evidence", implemented: true, noteZh: null },
  { view: "实测基准", stageId: "measurements", implemented: true, noteZh: null },
  { view: "构件清单", stageId: "objects", implemented: true, noteZh: null },
  { view: "现状记录", stageId: "objects", implemented: false, noteZh: "现状记录视图尚未实现，已切到对象与构件视图，可在其中查看现状观察记录" },
  { view: "图纸样式", stageId: "drawings", implemented: false, noteZh: "图纸样式视图尚未实现，已切到图纸视图" },
  { view: "图纸与检查", stageId: "drawings", implemented: true, noteZh: "图纸与检查在工作台中分为图纸和检查两个页签，已切到图纸" },
  { view: "交付包", stageId: "package", implemented: true, noteZh: null },
];

export function resolveView(view: string): ViewMapping | null {
  return MAPPINGS.find((m) => m.view === view) ?? null;
}

export const ALL_VIEW_MAPPINGS = MAPPINGS;
