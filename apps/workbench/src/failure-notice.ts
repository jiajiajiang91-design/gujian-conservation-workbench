// 失败提示：把内部错误码翻成用户能看懂的说明加下一步动作。
// 07 界面视觉规范 5.6 规定失败状态显示原因与恢复操作，不显示错误码原文，
// 但代码里近百个错误抛的是 CODE 或 CODE:detail 形态，直出会漏到界面。
//
// 匹配顺序：完整码精确匹配 → 前缀家族匹配 → 中文原文直接用 → 通用兜底。
// 未覆盖的码走通用兜底，只说明现象与下一步，绝不显示码本身。

export interface FailureNotice {
  summaryZh: string;
  nextStepZh: string;
}

interface FailureRule extends FailureNotice {
  // 冒号后的细节多数是构件号、资料名一类可读引用，这类才显示；
  // 进程 stderr、堆栈一类不显示。
  showDetail?: boolean;
}

const RETRY = "稍后重试。若反复出现，导出项目包留存现场后再处理。";
const RELOAD = "刷新页面重新载入项目。数据未提交的部分需要重新填写。";
const LOCAL_SERVICE = "确认本机服务已启动，然后重试。";

// 完整码精确匹配，用于说法与家族默认不同的情况。
const EXACT: Record<string, FailureRule> = {
  KIMI_API_KEY_NOT_CONFIGURED: {
    summaryZh: "模型服务没有配置访问凭证，本次识别没有运行。",
    nextStepZh: "在本机服务的环境配置中填入凭证后重试。凭证不进入浏览器。",
  },
  KIMI_TIMEOUT: {
    summaryZh: "模型服务响应超时，本次识别没有产出结果。",
    nextStepZh: "缩小识别范围后重试，或稍后再运行。",
  },
  KIMI_RETRY_EXHAUSTED: {
    summaryZh: "模型服务连续多次没有返回可用结果，已停止重试。",
    nextStepZh: RETRY,
  },
  SESSION_TOKEN_MISSING: {
    summaryZh: "本机服务的会话尚未建立，请求没有发出。",
    nextStepZh: LOCAL_SERVICE,
  },
  SESSION_UNAVAILABLE: {
    summaryZh: "连接不到本机服务，请求没有发出。",
    nextStepZh: LOCAL_SERVICE,
  },
  SERVER_STATUS_FAILED: {
    summaryZh: "读取本机服务状态失败。",
    nextStepZh: LOCAL_SERVICE,
  },
  REQUEST_TOO_LARGE: {
    summaryZh: "本次提交的内容超过单次请求上限，没有写入。",
    nextStepZh: "分批提交，或减少一次选中的条目数量。",
  },
  FILE_NAME_INVALID: {
    summaryZh: "文件名不符合要求，该文件没有导入。",
    nextStepZh: "文件名去掉路径分隔符与控制字符后重新上传。",
  },
  FILE_SIZE_NOT_ALLOWED: {
    summaryZh: "文件大小超出允许范围，该文件没有导入。",
    nextStepZh: "压缩或分卷后重新上传。",
  },
  DELIVERY_NOT_BLOCKED: {
    summaryZh: "当前项目没有处于阻断状态，代理交付草案不适用。",
    nextStepZh: "按正式交付流程处理，不需要代理交付草案。",
  },
  DRAWING_TASK_NOT_CONFIRMED: {
    summaryZh: "任务的成果要求尚未确认，图纸没有开始生成。",
    nextStepZh: "回到任务卡确认成果要求后再出图。",
  },
  DRAWING_EMPTY_SHEET_NOT_ALLOWED: {
    summaryZh: "有图纸内容为空，成组图纸没有生成。",
    nextStepZh: "补齐对应视图的数据来源后重新出图。",
  },
  DRAWING_SOURCE_GEOMETRY_NOT_FOUND: {
    summaryZh: "找不到出图依据的三维模型版本，图纸没有生成。",
    nextStepZh: "先生成三维模型，再出图。",
  },
  NO_PARSED_EVIDENCE_FOR_MODEL: {
    summaryZh: "项目里没有已解析的资料，模型没有可用输入。",
    nextStepZh: "先上传资料并完成解析，再运行模型。",
  },
  DOCUMENTED_DIMENSION_CHAIN_INVALID: {
    summaryZh: "尺寸链的分段之和与总长对不上，转写没有写入。",
    nextStepZh: "核对各分段数值与总长后重新填写。",
  },
};

// 前缀家族匹配，按数组顺序取第一个命中，长前缀写在前面。
const FAMILIES: Array<[string, FailureRule]> = [
  ["KIMI_", { summaryZh: "模型服务返回异常，本次识别没有产出结果。", nextStepZh: RETRY }],
  ["ASSISTANT_TURN_ALREADY_ACTIVE", {
    summaryZh: "上一轮助手对话还在进行，本次请求没有发出。",
    nextStepZh: "等当前一轮结束后再发送。",
  }],
  ["ASSISTANT_", { summaryZh: "助手请求失败，本次操作没有执行。", nextStepZh: RETRY }],
  ["MODEL_RUN_ALREADY_ACTIVE", {
    summaryZh: "已有模型运行在进行中，本次请求没有排队。",
    nextStepZh: "等当前运行结束后再发起。",
  }],
  ["MODEL_RUN_", { summaryZh: "模型运行中断，结果没有写入项目。", nextStepZh: RETRY }],
  ["CAD_JOB_ALREADY_ACTIVE", {
    summaryZh: "已有建模作业在进行中，本次请求没有排队。",
    nextStepZh: "等当前作业结束后再发起。",
  }],
  ["CAD_", { summaryZh: "建模作业失败，三维模型没有更新。", nextStepZh: RETRY }],
  ["DRAWING_", { summaryZh: "图纸作业失败，图纸没有更新。", nextStepZh: RETRY, showDetail: true }],
  ["DETAIL_", { summaryZh: "详图的数据要求不满足，图纸没有生成。", nextStepZh: "补齐该视图要求的局部资料后重新出图。", showDetail: true }],
  ["GEOMETRY_", {
    summaryZh: "三维模型的输入数据不完整或前后不一致，模型没有生成。",
    nextStepZh: "回到实测基准与构件清单补齐缺失数据后重试。",
    showDetail: true,
  }],
  ["ARCHETYPE_", {
    summaryZh: "形制参数不完整或与实测不一致，应然值没有推导。",
    nextStepZh: "回到形制模板补齐参数后重试。",
    showDetail: true,
  }],
  ["PACKAGE_", { summaryZh: "项目包内容与清单对不上，导入没有执行。", nextStepZh: "确认项目包完整且未被改动后重新导入。" }],
  ["ZIP_", { summaryZh: "项目包内容与清单对不上，导入没有执行。", nextStepZh: "确认项目包完整且未被改动后重新导入。" }],
  ["PROJECT_JSON_TOO_LARGE", {
    summaryZh: "项目数据超过单个文件上限，导出没有完成。",
    nextStepZh: "拆分项目或清理不再需要的历史版本后重试。",
  }],
  ["PROJECT_REVISION_MISMATCH", {
    summaryZh: "项目包记录的版本与实际数据不一致，导入没有执行。",
    nextStepZh: "使用完整导出的项目包重新导入。",
  }],
  ["ROUNDTRIP_", {
    summaryZh: "导出复核没有通过，导出的内容与项目当前数据不一致。",
    nextStepZh: "本次导出不可用于交付。重新导出，若仍不通过请保留现场。",
  }],
  ["JSON_ROUNDTRIP_", {
    summaryZh: "导出复核没有通过，导出的内容与项目当前数据不一致。",
    nextStepZh: "本次导出不可用于交付。重新导出，若仍不通过请保留现场。",
  }],
  ["AUDIT_", {
    summaryZh: "操作记录链校验没有通过，本次操作没有写入。",
    nextStepZh: "本项目暂不可用于交付。保留现场，不要继续写入。",
  }],
  ["ASSET_", { summaryZh: "资料文件缺失或内容与记录不符。", nextStepZh: "重新上传该资料后重试。" }],
  ["PROJECT_NOT_FOUND", { summaryZh: "读取项目数据失败，界面显示的内容可能不是最新的。", nextStepZh: RELOAD }],
  ["REVISION_NOT_FOUND", { summaryZh: "读取项目版本失败，界面显示的内容可能不是最新的。", nextStepZh: RELOAD }],
  ["DEMO_", { summaryZh: "演示数据不完整，演示项目没有载入。", nextStepZh: "重新载入演示项目。演示数据不影响真实项目。" }],
  ["DELIVERY_", { summaryZh: "交付条件不满足，交付没有生成。", nextStepZh: "查看问题队列，处理阻断项后重试。", showDetail: true }],
  ["ARTIFACT_", { summaryZh: "数据的项目归属对不上，本次操作没有执行。", nextStepZh: RELOAD }],
  ["CHECK_RUN_", { summaryZh: "数据的项目归属对不上，本次操作没有执行。", nextStepZh: RELOAD }],
  ["INVALID_JSON", { summaryZh: "收到的数据格式不正确，本次操作没有执行。", nextStepZh: RETRY }],
  ["SSE_", { summaryZh: "与本机服务的连接中断，进度不再更新。", nextStepZh: LOCAL_SERVICE }],
  ["HTTP_", { summaryZh: "本机服务返回错误，本次操作没有执行。", nextStepZh: LOCAL_SERVICE }],
];

const GENERIC: FailureNotice = {
  summaryZh: "操作没有完成，数据保持在操作前的状态。",
  nextStepZh: RETRY,
};

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,}$/;
const CJK = /[一-鿿]/;
const DETAIL_MAX = 120;

function lookup(code: string): FailureRule | null {
  const exact = EXACT[code];
  if (exact) return exact;
  for (const [prefix, rule] of FAMILIES) {
    if (code.startsWith(prefix)) return rule;
  }
  return null;
}

// 填写校验一类的提示：本身就是说明加做法，不需要再补下一步。
export function inputError(summaryZh: string): FailureNotice {
  return { summaryZh, nextStepZh: "" };
}

// 从抛出的错误里取出用户能看的说明。message 已经是中文的直接采用，
// 是错误码的按规则翻译，都不匹配时走通用兜底。
export function describeFailure(reason: unknown, fallbackZh: string): FailureNotice {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const [head = "", ...rest] = raw.split(":");
  const code = head.trim();

  if (!CODE_SHAPE.test(code)) {
    // 只有中文说明才直接采用。浏览器与运行时抛的是英文原文
    // （如 Failed to fetch），直出同样违反不显示错误码原文的要求。
    const text = raw.trim();
    return {
      summaryZh: CJK.test(text) ? text : `${fallbackZh}。数据保持在操作前的状态。`,
      nextStepZh: GENERIC.nextStepZh,
    };
  }

  const rule = lookup(code);
  if (!rule) return { summaryZh: `${fallbackZh}。数据保持在操作前的状态。`, nextStepZh: GENERIC.nextStepZh };

  const detail = rest.join(":").trim();
  if (!rule.showDetail || detail === "") {
    return { summaryZh: rule.summaryZh, nextStepZh: rule.nextStepZh };
  }
  // 细节本身常常是内层错误码（如 DRAWING_JOB_FAILED:DRAWING_WORKER_FAILED）。
  // 能翻译就用内层的中文说明，翻译不出就只留外层说明，不把标识符抛给用户。
  if (CODE_SHAPE.test(detail)) {
    const inner = lookup(detail);
    return inner
      ? { summaryZh: inner.summaryZh, nextStepZh: inner.nextStepZh }
      : { summaryZh: rule.summaryZh, nextStepZh: rule.nextStepZh };
  }
  if (!CJK.test(detail)) return { summaryZh: rule.summaryZh, nextStepZh: rule.nextStepZh };
  const shown = detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
  return { summaryZh: `${rule.summaryZh}涉及：${shown}`, nextStepZh: rule.nextStepZh };
}
