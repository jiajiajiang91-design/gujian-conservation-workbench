import type { ArchetypeSpec, ArtifactRecord, ArtifactRequirementMatrix, AssetRecord, AuditEvent, CadJob, CheckRun, ConceptEntry, Decision, DeliveryDraft, DeliveryEvaluation, GeometryRevision, ModelRun, ProjectDrivenGeometrySpec, ProjectSnapshot, RuleRun } from "@gujian/domain";

import type { ProjectCommand, ProjectCommandType } from "./commands.js";

export interface ProjectHead {
  readonly projectId: string;
  readonly revisionId: string;
  readonly auditEventId: string;
  readonly snapshot: ProjectSnapshot;
}

export interface ProjectSummary {
  readonly projectId: string;
  readonly currentRevisionId: string;
  readonly name: string;
  readonly buildingName: string;
  readonly status: "active" | "archived";
  readonly updatedAt: string;
  readonly auditHeadHash: string;
}

export interface CommandReceipt {
  readonly commandId: string;
  readonly commandType: ProjectCommandType;
  readonly projectId: string;
  readonly revisionId: string;
  readonly auditEventId: string;
  readonly committedAt: string;
  // 这条命令改了哪些领域对象。审计事件的写集指向的是存储记录（项目与修订），
  // 领域对象的 id 只在修订的 changedRefs 里，而修订带着整份快照，为了读几个 id
  // 把它们全load出来不可行。回执小，放这里最省。旧回执没有这一项，故可选。
  readonly changedRefs?: readonly string[];
}

export interface CommitProjectMutation {
  readonly command: ProjectCommand;
  readonly authoritativeActorId: string;
  readonly parentRevisionId: string | null;
  readonly snapshot: ProjectSnapshot;
  readonly changedRefs: readonly string[];
  readonly priorAuditEvents?: readonly AuditEvent[];
  readonly assetWrites?: {
    readonly records: readonly AssetRecord[];
    readonly stagingSessionId: string | null;
  };
  readonly modelRunsToPut?: readonly ModelRun[];
  readonly ruleRunsToPut?: readonly RuleRun[];
  readonly decisionsToPut?: readonly Decision[];
  readonly cadJobsToPut?: readonly CadJob[];
  readonly geometrySpecsToPut?: readonly ProjectDrivenGeometrySpec[];
  readonly geometryRevisionsToPut?: readonly GeometryRevision[];
  readonly artifactRequirementMatricesToPut?: readonly ArtifactRequirementMatrix[];
  readonly artifactsToPut?: readonly ArtifactRecord[];
  readonly checkRunsToPut?: readonly CheckRun[];
  readonly deliveryEvaluationsToPut?: readonly DeliveryEvaluation[];
  readonly deliveriesToPut?: readonly DeliveryDraft[];
  // v1.4：部署级词表条目与项目形制参数
  readonly conceptEntriesToPut?: readonly ConceptEntry[];
  readonly archetypeSpecsToPut?: readonly ArchetypeSpec[];
}

export interface ProjectTransaction {
  getCommandReceipt(commandId: string): Promise<CommandReceipt | null>;
  getProjectHead(): Promise<ProjectHead | null>;
  getCadJob(jobId: string): Promise<CadJob | null>;
  getArtifactRequirementMatrix(matrixId: string): Promise<ArtifactRequirementMatrix | null>;
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  getCheckRun(checkRunId: string): Promise<CheckRun | null>;
  getDeliveryEvaluation(evaluationId: string): Promise<DeliveryEvaluation | null>;
  commit(mutation: CommitProjectMutation): Promise<CommandReceipt>;
}

export interface ProjectRepositoryPort {
  transaction<T>(projectId: string, operation: (transaction: ProjectTransaction) => Promise<T>): Promise<T>;
}

export interface ProjectQueryPort {
  listProjects(): Promise<readonly ProjectSummary[]>;
  getProjectHead(projectId: string): Promise<ProjectHead | null>;
}

export interface AuthorizationPort {
  assertAuthorized(input: {
    readonly actorId: string;
    readonly projectId: string;
    readonly commandType: ProjectCommandType;
  }): Promise<void>;
}

export interface CommandAuthority {
  authoritativeActorId?: string;
}
