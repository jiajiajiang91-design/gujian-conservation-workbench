import type { WorkspaceSnapshot } from "./snapshot-types.js";

export type PreconditionResult =
  | { satisfied: true }
  | { satisfied: false; reasonZh: string };

const ok: PreconditionResult = { satisfied: true };
const no = (reasonZh: string): PreconditionResult => ({ satisfied: false, reasonZh });

// 前置条件求值：快照字段缺失一律按不满足处理（fail-closed）。
// 精确的对象解析（如自然语言引用能否命中构件）由客户端执行体二次校验。
const evaluators: Record<string, (s: WorkspaceSnapshot) => PreconditionResult> = {
  TARGET_EXISTS: (s) =>
    (s.componentCount ?? 0) > 0 ? ok : no("当前项目没有可定位的对象，请先导入项目或完成识别"),
  MODEL_ROUTE_AVAILABLE: (s) =>
    s.modelRouteAvailable === true ? ok : no("模型服务当前不可用"),
  STAGE_CLEAR: (s) =>
    s.openDockItems === undefined
      ? no("无法确认停靠事项状态")
      : s.openDockItems === 0
        ? ok
        : no(`当前环节还有 ${s.openDockItems} 项停靠事项未处理，处理完才能推进`),
  PROJECT_IMPORTED: (s) =>
    s.projectId != null && (s.componentCount ?? 0) > 0
      ? ok
      : no("项目未导入或构件库为空，无法生成三维模型"),
  GEOMETRY_EXISTS: (s) =>
    s.hasGeometryRevision === true ? ok : no("还没有几何版本，请先生成三维模型"),
  DRAWINGS_EXIST: (s) =>
    s.hasDrawings === true ? ok : no("还没有图纸，请先生成图纸"),
  DELIVERABLE_EXISTS: (s) =>
    s.hasDeliverable === true ? ok : no("还没有可交付内容"),
  IMAGE_SELECTION_PRESENT: (s) =>
    s.hasImageSelection === true
      ? ok
      : no("这条要在照片上先框出位置。请在资料区的图片上框选，再说要改什么"),
  EVIDENCE_EXISTS: (s) =>
    (s.unparsedEvidenceCount ?? 0) > 0 ? ok : no("项目内没有待解析的资料，请先上传任务书或其他资料"),
};

export function evaluatePrecondition(
  code: string | null,
  snapshot: WorkspaceSnapshot,
): PreconditionResult {
  if (code === null) return ok;
  const evaluate = evaluators[code];
  if (!evaluate) return no(`未知前置条件码: ${code}`);
  return evaluate(snapshot);
}

export const KNOWN_PRECONDITION_CODES = Object.keys(evaluators);
