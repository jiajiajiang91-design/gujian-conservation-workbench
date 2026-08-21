// 模型任务注册表（技术架构 7.2）：按 taskType 固定系统提示、输入种类、
// 输出结构与预算。此前只有一个任务类型，提示与输出结构写死在网关里，
// 加第二个任务时才发现改一处会牵动另一处，因此收到这里只留一份。
//
// 系统提示只定义角色、任务目标和责任边界：基于证据工作、标明不确定性、
// 不编造现场测量、不冒充签发人。确定性业务规则不进提示，进程序检查。

export type ModelTaskInputKind = "text" | "image";

export interface ModelTaskDefinition {
  readonly taskType: string;
  readonly displayNameZh: string;
  // 可接受的输入种类。测量转写两种都收：任务是读出资料里写明的尺寸，
  // 来源是文字记录还是图纸不改变任务性质，不必另开一个任务类型。
  readonly inputKinds: readonly ModelTaskInputKind[];
  readonly systemPrompt: string;
}

// 这里不设输入条目数、输入字节和输出 token 的上限。
//
// 之前设过：条目 5 条、输入 12 MiB、输出 4096。三个数都是估出来的，
// 其中 12 MiB 基于"每张实测图约 1 MiB"的判断，而实测每张只有 0.09 MiB，
// 差十倍。输出 4096 是为绕开截断而定的倍数，同样没有依据。
// 编出来的上限不保护任何东西，只会在真实输入变大时无声地截断或拒绝。
//
// 实际约束由三处真实来源承担：请求体上限 maxBodyBytes（既有值）、
// schema 的结构性长度上限、以及上游 API 自身的限制。输出长度交给上游，
// 不再由本服务发 max_completion_tokens。

const FACT_BOUNDARY = "只根据输入资料生成候选，不补写缺失的测量、年代、材料或病害结论。";

export const MODEL_TASKS: readonly ModelTaskDefinition[] = [
  {
    taskType: "evidence-summary",
    displayNameZh: "资料要点整理",
    inputKinds: ["text"],
    systemPrompt: `你是古建保护项目资料整理助手。${FACT_BOUNDARY}输出 JSON 对象，字段为 summary、findings、missingInformation，后两项为字符串数组。`,
  },
  {
    taskType: "measurement-transcription",
    displayNameZh: "图纸尺寸转写",
    inputKinds: ["text", "image"],
    systemPrompt: [
      `你是古建测绘资料转写助手。${FACT_BOUNDARY}`,
      "任务是把资料里已经写明的尺寸读出来，逐条给出原文、对应部位和出处。资料可能是实测图纸，也可能是文字记录。",
      "只转写资料里写明的数字，资料没有写的尺寸一律不给，不按比例量取也不按经验推算。",
      "扫描件的文字层由 OCR 生成，可能有错字与断字（例如 twenty ^f our feet 即 twenty-four feet），按上下文判读并在 noteZh 记下原文。",
      "读不准或不确定量的是哪个部位时，把该条的 certainty 标为 uncertain 并在 noteZh 写明疑点，不要猜。",
      "输出 JSON 对象，字段为：summary（一句话说明本次读了哪几份资料、共读出多少条）、",
      "dimensions（数组，每条含 valueText 图上原文、valueMm 换算毫米值或 null、partZh 对应部位或 null、",
      "evidenceRef 取自哪份资料的标识、locationZh 在资料中的位置描述或 null、certainty 取 certain 或 uncertain、noteZh 备注或 null）、",
      "missingInformation（字符串数组，说明还缺哪些关键尺寸）。",
    ].join(""),
  },
  {
    taskType: "component-recognition",
    displayNameZh: "构件识别",
    inputKinds: ["image"],
    systemPrompt: [
      `你是古建测绘资料的构件识别助手。${FACT_BOUNDARY}`,
      "任务是在给定的资料照片上认出可见的建筑构件，逐个给出名称与它在图上的位置。",
      "位置用相对整张图片的比例表示：x 与 y 是左上角，width 与 height 是宽高，四个数都在 0 到 1 之间。",
      "只标你在图上确实看得见的构件。看不清、被遮挡或只能推测的，要么不给，要么把 certainty 标为 uncertain 并在 noteZh 写明疑点。",
      "不要给出构件的尺寸：本任务只认位置与名称，尺寸另有任务。",
      "构件名用中文通行叫法，判不准类别时 categoryZh 给 null，不要硬套形制术语。",
      "输出 JSON 对象，字段为：summary（一句话说明看了哪几张图、认出多少个）、",
      "components（数组，每条含 nameZh、categoryZh 或 null、evidenceRef 取自输入项的标识、",
      "region 含 x/y/width/height、certainty 取 certain 或 uncertain、noteZh 备注或 null）、",
      "missingInformation（字符串数组，说明还有哪些部位认不出或看不到）。",
    ].join(""),
  },
];

export function findModelTask(taskType: string): ModelTaskDefinition | null {
  return MODEL_TASKS.find((item) => item.taskType === taskType) ?? null;
}
