// 工作区视图名：05 界面与交互形态表 2 的十个视图，加表 3 的模型运行与费用。
// 这份清单此前在动作目录、关键词退路、工作台视图映射三处各存一份，
// 改一处漏两处会让助手切不过去，因此收到领域层只留一份。
// 项目列表属左栏，不是工作区视图，不进本清单。

export const WORKSPACE_VIEW_NAMES = [
  "任务卡",
  "资料清单",
  "实测基准",
  "构件清单",
  "现状记录",
  "三维模型",
  "问题队列",
  "图纸样式",
  "图纸与检查",
  "交付包",
  "模型运行与费用",
] as const;

export type WorkspaceViewName = (typeof WORKSPACE_VIEW_NAMES)[number];

// 05 界面与交互形态表 3 的项目级页面。它们不是工作区视图：
// 项目列表是退出当前项目回到列表页，模型运行与费用是项目内的一个页面。
// 两者语义不同，消费方按类型分派，不能塞同一个 stage 标识。
export const PROJECT_LEVEL_VIEW_NAMES = [
  "项目列表",
] as const;

export type ProjectLevelViewName = (typeof PROJECT_LEVEL_VIEW_NAMES)[number];

// switch_view 能接受的全部视图名。
export const ALL_SWITCHABLE_VIEW_NAMES = [
  ...WORKSPACE_VIEW_NAMES,
  ...PROJECT_LEVEL_VIEW_NAMES,
] as const;

export type SwitchableViewName = (typeof ALL_SWITCHABLE_VIEW_NAMES)[number];
