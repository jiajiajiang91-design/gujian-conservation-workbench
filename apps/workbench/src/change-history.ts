import type { ProjectSnapshot } from "@gujian/domain";

// 修改历史（界面文档表 3）。项目里发生过的每一次写入，按时间倒序。
//
// 数据来自三处，各管一段：
//   审计事件  谁、什么时候、改了哪些对象，带哈希链
//   命令回执  这是哪一类动作
//   领域记录  为什么改
//
// 理由分散在各自的记录里，不集中存：排除记录有 reasonZh，遮挡标记的原因写在
// 构件的 visibility 上，事实有 reasonZh。这里按回执的 changedRefs 反查回去，
// 而不是另建一张历史表——另建一张就有两个真相，且它会与领域记录不同步。

export interface ChangeHistoryEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly actionZh: string;
  readonly outcome: "committed" | "rejected" | "failed" | "cancelled" | "late";
  readonly subjectsZh: readonly string[];
  readonly reasonZh: string | null;
  /** 这次改了几条记录。对象名认不出来时至少能说清动了几条 */
  readonly writeCount: number;
}

// 命令类型到中文动作名。缺一条就显示原始类型，不猜也不隐藏：
// 显示英文类型名难看，但比显示一个编出来的中文名可靠。
const COMMAND_LABELS: Record<string, string> = {
  CreateProject: "建立项目",
  ImportProjectSnapshot: "导入项目包",
  ImportEvidence: "上传资料",
  ConfirmTaskSetup: "确认任务要求",
  ReplaceTaskDefinition: "更换任务书",
  CommitFacts: "写入尺寸与事实",
  CommitObservations: "记录现状",
  CommitEntities: "写入构件记录",
  ReviseEntities: "修订构件记录",
  CommitExclusionRecords: "记入排除记录",
  CommitModelRunResult: "保存识别结果",
  CommitRuleEvaluation: "运行规则核对",
  CommitGeometryRevision: "生成三维模型",
  CommitArtifactSet: "生成图纸成果",
  CommitCheckRun: "运行检查",
  CreateDeliveryDraft: "建立交付草案",
  EvaluateDelivery: "评估交付",
  DecideCandidate: "处置候选",
  DecideIssueOption: "选定方案",
  CommitArchetypeSpec: "登记形制参数",
  CommitConceptEntries: "更新词表",
  StartCadJob: "发起几何作业",
  SyncCadJobEvents: "同步作业进度",
};

interface Sources {
  readonly auditEvents: readonly {
    id: string;
    commandId: string;
    actorId: string;
    outcome: ChangeHistoryEntry["outcome"];
    occurredAt: string;
    writeSet: readonly { storeName: string; id: string }[];
  }[];
  readonly receipts: readonly { commandId: string; commandType: string; changedRefs?: readonly string[] }[];
  readonly snapshot: Pick<ProjectSnapshot, "entities" | "exclusionRecords" | "facts" | "evidences"> | null;
}

/** 一次写入改到的对象，尽量说出名字；说不出就不说，不用 id 冒充名字 */
function describeSubjects(refs: readonly string[], snapshot: Sources["snapshot"]): string[] {
  if (!snapshot) return [];
  const named: string[] = [];
  for (const ref of refs) {
    const entity = snapshot.entities.find((one) => one.id === ref);
    if (entity) { named.push(entity.name); continue; }
    const evidence = snapshot.evidences.find((one) => one.id === ref);
    if (evidence) { named.push(evidence.title); continue; }
    const exclusion = snapshot.exclusionRecords.find((one) => one.id === ref);
    if (exclusion) named.push(exclusion.subjectDescriptionZh);
  }
  return [...new Set(named)];
}

/** 为什么改。三处记录各自带理由，按改动对象反查 */
function findReason(refs: readonly string[], snapshot: Sources["snapshot"]): string | null {
  if (!snapshot) return null;
  for (const ref of refs) {
    const exclusion = snapshot.exclusionRecords.find((one) => one.id === ref);
    if (exclusion) return exclusion.reasonZh;
    const fact = snapshot.facts.find((one) => one.id === ref);
    if (fact?.reasonZh) return fact.reasonZh;
    const entity = snapshot.entities.find((one) => one.id === ref);
    if (entity?.visibility) return entity.visibility.reasonZh;
  }
  return null;
}

export function buildChangeHistory(sources: Sources): ChangeHistoryEntry[] {
  const receiptByCommand = new Map(sources.receipts.map((item) => [item.commandId, item]));
  return sources.auditEvents
    .map((event) => {
      const receipt = receiptByCommand.get(event.commandId);
      const commandType = receipt?.commandType;
      // 领域对象的 id 在回执的 changedRefs 里。写集里只有项目与修订两条存储记录，
      // 按它反查什么也查不到，早先版本据此显示未记录理由，其实理由一直都在。
      const refs = receipt?.changedRefs ?? event.writeSet.map((item) => item.id);
      return {
        id: event.id,
        occurredAt: event.occurredAt,
        actorId: event.actorId,
        // 回执缺失时说清是缺失，不写一个看起来正常的动作名
        actionZh: commandType ? COMMAND_LABELS[commandType] ?? commandType : "未记录动作类型",
        outcome: event.outcome,
        subjectsZh: describeSubjects(refs, sources.snapshot),
        reasonZh: findReason(refs, sources.snapshot),
        writeCount: refs.length,
      };
    })
    .sort((first, second) => (first.occurredAt < second.occurredAt ? 1 : first.occurredAt > second.occurredAt ? -1 : 0));
}

/** 已知的命令类型，测试据此断言标签表不漏项 */
export function labelledCommandTypes(): string[] {
  return Object.keys(COMMAND_LABELS).sort();
}
