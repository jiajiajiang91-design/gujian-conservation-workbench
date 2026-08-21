// 资格与阻断说明：界面上出现的资格限制、阻断原因都从这里取词。
// 原来常驻标签只写了签发状态一层，成果等级、使用禁区、身份性质三层
// 只写在交付草案的 restrictions 与图纸图签上，界面比图纸说得少。

export interface QualificationLimit {
  code: string;
  layerZh: string;
  textZh: string;
}

// 三条与 delivery-service 的 FORMAL_ONLY_CODES 一一对应，
// 也与图纸图签上印的代理成果、未签发、未经专业复核不可用于正式交付或施工同源。
export const QUALIFICATION_LIMITS: readonly QualificationLimit[] = [
  {
    code: "L1_ELIGIBILITY_FALSE",
    layerZh: "成果等级",
    textZh: "未达专业样板等级，不作为专业样板或参照标准使用。",
  },
  {
    code: "PROFESSIONAL_REVIEW_REQUIRED",
    layerZh: "使用禁区",
    textZh: "未经项目责任人员专业复核，不可用于正式交付、施工与法定档案入库。",
  },
  {
    code: "FORMAL_SIGNOFF_UNAVAILABLE",
    layerZh: "身份性质",
    textZh: "本机身份不具备签发资格，签发须由项目责任人员在正式环境完成。",
  },
];

export const QUALIFICATION_CHIP_LABEL = "代理成果 · 未签发 · 未达专业样板等级";

const ISSUE_TYPE_ZH: Record<string, string> = {
  missingEvidence: "缺资料",
  ruleConflict: "数据对不上",
  professionalUncertainty: "需专业判断",
  highRisk: "高风险",
};

const CHECK_CODE_ZH: Record<string, string> = {
  PROFESSIONAL_REVIEW_REQUIRED: "尚未经专业复核",
  FORMAL_SIGNOFF_UNAVAILABLE: "本机环境不能签发",
  L1_ELIGIBILITY_FALSE: "未达专业样板等级",
  DRAWING_OUTPUT_HASH_CLOSURE: "图纸成果与构建清单不一致",
  UNVERIFIED_DIMENSION_CANDIDATES: "尺寸尚未核验",
  MEASUREMENT_METADATA_MISSING: "测量记录缺测量人、时间或方法",
  GEOMETRY_EVIDENCE_FACTS_MISSING: "缺少支撑三维模型的实测数据",
};

// 阻断原因：交付评估写的是 CODE 或 CODE:细节:UUID 形态，直出会把
// 内部码和 UUID 漏到界面（07 界面视觉规范 5.6）。
export function describeBlocker(code: string): string {
  const direct = CHECK_CODE_ZH[code] ?? ISSUE_TYPE_ZH[code];
  if (direct) return direct;

  const [head = "", second = ""] = code.split(":");
  if (head === "OPEN_ISSUE") return `未处理事项：${ISSUE_TYPE_ZH[second] ?? "需人工判断"}`;
  if (head === "CHECK_BLOCKED") return `检查不通过：${CHECK_CODE_ZH[second] ?? "详见检查结果"}`;
  if (head === "UNKNOWN") return "有未确认项，详见待确认清单";
  if (head === "PROJECT_INPUT_BLOCKED") return "项目输入数据不完整";
  return "有阻断项，详见检查结果与问题队列";
}
