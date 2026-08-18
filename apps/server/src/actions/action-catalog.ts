import { ALL_SWITCHABLE_VIEW_NAMES } from "@gujian/domain";
import { z } from "zod";

// 动作目录：05 界面与交互形态表 11、表 12 的代码形态。
// 模型可见字段只有 name/description/parameters 三项（见 modelFacingCatalog），
// 确认级别、前置条件等执行字段绝不进入模型请求。

export type ConfirmLevel = "direct" | "readonly" | "per_item" | "confirm";

export interface ActionDefinition {
  name: string;
  displayNameZh: string;
  description: string;
  parameters: z.ZodType;
  parametersJsonSchema: Record<string, unknown>;
  confirmLevel: ConfirmLevel;
  preconditionCode: string | null;
  costly: boolean;
  generation: 1 | 2 | 3;
}

// 工作区视图加项目级页面。项目列表是退出当前项目，不是切 stage。
const VIEW_NAMES = ALL_SWITCHABLE_VIEW_NAMES;

const CHANGE_TYPES = [
  "参数修改", "类别修改", "标记存疑", "标记不可用", "标记不可见", "新增", "删除",
] as const;

const EXPORT_FORMATS = ["dxf", "svg", "pdf", "zip"] as const;
const JOB_TYPES = ["model", "cad", "drawing"] as const;

function jsonEnum(values: readonly string[], description: string) {
  return { type: "string", enum: [...values], description };
}

export const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  {
    name: "switch_view",
    displayNameZh: "切换视图",
    description: "切换工作区视图。用户说要看某个视图或某类内容时使用。",
    parameters: z.object({
      view: z.enum(VIEW_NAMES),
      target: z.string().min(1).max(200).optional(),
    }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: {
        view: jsonEnum(VIEW_NAMES, "目标视图"),
        target: { type: "string", description: "可选，聚焦的构件号或资料号" },
      },
      required: ["view"],
    },
    confirmLevel: "direct",
    preconditionCode: null,
    costly: false,
    generation: 1,
  },
  {
    name: "locate_evidence",
    displayNameZh: "定位证据",
    description: "定位某构件或数据的证据并高亮。用户说要看某构件的照片、依据、出处时使用。",
    parameters: z.object({ ref: z.string().min(1).max(200) }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "构件号或自然语言描述" } },
      required: ["ref"],
    },
    confirmLevel: "direct",
    preconditionCode: "TARGET_EXISTS",
    costly: false,
    generation: 2,
  },
  {
    name: "query_job_progress",
    displayNameZh: "查询作业进度",
    description: "查询生成作业的进度与状态。用户问进度、还要多久、在干什么时使用。",
    parameters: z.object({ jobType: z.enum(JOB_TYPES).optional() }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: { jobType: jsonEnum(JOB_TYPES, "可选，作业类型，缺省查全部活动作业") },
      required: [],
    },
    confirmLevel: "readonly",
    preconditionCode: null,
    costly: false,
    generation: 2,
  },
  {
    name: "answer_question",
    displayNameZh: "回答问题",
    description: "回答与项目相关的问题并给出引用。其余动作都不匹配时的兜底动作。",
    parameters: z.object({ question: z.string().min(1).max(4_000) }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: { question: { type: "string", description: "用户的问题" } },
      required: ["question"],
    },
    confirmLevel: "readonly",
    preconditionCode: "MODEL_ROUTE_AVAILABLE",
    costly: false,
    generation: 1,
  },
  {
    name: "propose_modification",
    displayNameZh: "生成修改建议",
    description: "对构件数据生成修改建议，逐条确认后生效。用户说要改、补、推测某个数据时使用。",
    parameters: z.object({
      subjectRef: z.string().min(1).max(200),
      changeType: z.enum(CHANGE_TYPES),
      payload: z.record(z.string(), z.unknown()),
    }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: {
        subjectRef: { type: "string", description: "目标构件或数据引用" },
        changeType: jsonEnum(CHANGE_TYPES, "修改类型"),
        payload: { type: "object", description: "按修改类型给出的字段与值" },
      },
      required: ["subjectRef", "changeType", "payload"],
    },
    confirmLevel: "per_item",
    preconditionCode: "MODEL_ROUTE_AVAILABLE",
    costly: false,
    generation: 1,
  },
  {
    name: "marquee_correction",
    displayNameZh: "框选修正",
    description: "按用户在照片上框选的位置修正构件记录。仅当消息带框选位置时使用。",
    parameters: z.object({
      bbox: z.object({
        x: z.number(), y: z.number(),
        width: z.number().positive(), height: z.number().positive(),
      }).strict(),
      instruction: z.string().min(1).max(2_000),
    }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: {
        bbox: {
          type: "object",
          description: "框选区域",
          properties: {
            x: { type: "number" }, y: { type: "number" },
            width: { type: "number" }, height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
        instruction: { type: "string", description: "用户对框选位置的说明" },
      },
      required: ["bbox", "instruction"],
    },
    confirmLevel: "per_item",
    preconditionCode: null,
    costly: false,
    generation: 1,
  },
  {
    name: "rerun_recognition",
    displayNameZh: "重新识别",
    description: "重新运行构件识别。用户说重新识别或质疑识别结果时使用。结果标 AI 实时，需人工核对。",
    parameters: z.object({ scope: z.string().min(1).max(500).optional() }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: { scope: { type: "string", description: "可选，识别范围，缺省为当前视图对象集" } },
      required: [],
    },
    confirmLevel: "direct",
    preconditionCode: "MODEL_ROUTE_AVAILABLE",
    costly: false,
    generation: 1,
  },
  {
    name: "advance_workflow",
    displayNameZh: "推进流程",
    description: "推进到下一环节。用户说继续、下一步时使用。停靠事项未清时会拒绝并说明。",
    parameters: z.object({}).strict(),
    parametersJsonSchema: { type: "object", properties: {}, required: [] },
    confirmLevel: "direct",
    preconditionCode: "STAGE_CLEAR",
    costly: false,
    generation: 1,
  },
  {
    name: "run_data_check",
    displayNameZh: "运行数据检查",
    description: "运行规则检查并返回检查项、结论与停靠事项。用户说检查一下、看看有没有问题时使用。",
    parameters: z.object({ scope: z.string().min(1).max(500).optional() }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: { scope: { type: "string", description: "可选，检查范围，缺省为当前环节" } },
      required: [],
    },
    confirmLevel: "readonly",
    preconditionCode: null,
    costly: false,
    generation: 2,
  },
  {
    name: "generate_geometry",
    displayNameZh: "生成三维模型",
    description: "按当前项目数据生成新的三维模型版本。用户说生成、更新三维时使用。耗时较长，执行前需确认。",
    parameters: z.object({ note: z.string().min(1).max(500).optional() }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: { note: { type: "string", description: "可选，本次生成的备注" } },
      required: [],
    },
    confirmLevel: "confirm",
    preconditionCode: "PROJECT_IMPORTED",
    costly: true,
    generation: 2,
  },
  {
    name: "generate_drawings",
    displayNameZh: "生成图纸",
    description: "基于三维模型生成图纸目录。用户说出图时使用。耗时较长，执行前需确认。",
    parameters: z.object({
      views: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
    }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: {
        views: { type: "array", items: { type: "string" }, description: "可选，视图选择，缺省全套" },
      },
      required: [],
    },
    confirmLevel: "confirm",
    preconditionCode: "GEOMETRY_EXISTS",
    costly: true,
    generation: 2,
  },
  {
    name: "export_deliverable",
    displayNameZh: "导出成果",
    description: "导出图纸或交付包。用户说导出、下载成果时使用。交付级导出需证据等级满足。",
    parameters: z.object({
      format: z.enum(EXPORT_FORMATS),
      scope: z.string().min(1).max(500).optional(),
    }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: {
        format: jsonEnum(EXPORT_FORMATS, "导出格式，zip 为交付包"),
        scope: { type: "string", description: "可选，导出范围" },
      },
      required: ["format"],
    },
    confirmLevel: "confirm",
    preconditionCode: "DRAWINGS_EXIST",
    costly: false,
    generation: 2,
  },
  {
    name: "draft_delivery_note",
    displayNameZh: "起草交付说明",
    description: "起草交付说明草稿，含尺寸依据、限制条件与未确认项，逐条确认后采用。",
    parameters: z.object({}).strict(),
    parametersJsonSchema: { type: "object", properties: {}, required: [] },
    confirmLevel: "per_item",
    preconditionCode: "DELIVERABLE_EXISTS",
    costly: false,
    generation: 2,
  },
  {
    // 第 3 代提前项（D1 决策 2026-08-16）：解析任务书与盘点资料。
    name: "parse_task_brief",
    displayNameZh: "解析任务书与盘点资料",
    description: "解析项目内的任务书与资料并盘点，产出候选事实清单供逐条确认。用户说解析任务书、盘点资料、整理资料时使用。",
    parameters: z.object({
      scope: z.array(z.string().min(1).max(200)).max(200).optional(),
    }).strict(),
    parametersJsonSchema: {
      type: "object",
      properties: {
        scope: { type: "array", items: { type: "string" }, description: "可选，资料 ID 列表，缺省解析全部未解析资料" },
      },
      required: [],
    },
    confirmLevel: "per_item",
    preconditionCode: "EVIDENCE_EXISTS",
    costly: false,
    generation: 3,
  },
];

export interface ModelFacingAction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// 模型侧目录：只投影三字段，任何执行字段不得出现在返回值里。
export function modelFacingCatalog(): ModelFacingAction[] {
  return ACTION_DEFINITIONS.map((a) => ({
    name: a.name,
    description: a.description,
    parameters: a.parametersJsonSchema,
  }));
}

export type ActionCallValidation =
  | { ok: true; action: ActionDefinition; args: unknown }
  | { ok: false; code: "UNKNOWN_ACTION"; message: string }
  | { ok: false; code: "INVALID_ARGS"; message: string; issues: string[] };

// 校验模型发起的动作调用。参数解析失败返回结构化错误，供回传模型重试。
export function validateActionCall(name: string, rawArgs: unknown): ActionCallValidation {
  const action = ACTION_DEFINITIONS.find((a) => a.name === name);
  if (!action) {
    return { ok: false, code: "UNKNOWN_ACTION", message: `动作不在清单内: ${name}` };
  }
  const parsed = action.parameters.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_ARGS",
      message: `动作 ${name} 参数不合规`,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, action, args: parsed.data };
}
