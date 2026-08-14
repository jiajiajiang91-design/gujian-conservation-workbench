import type { ArtifactRecord, AssetRecord, AuditEvent, CadJob, CheckRun, Decision, DeliveryDraft, DeliveryEvaluation, GeometryRevision, ModelRun, ProjectDrivenGeometrySpec, ProjectSnapshot, RuleRun } from "@gujian/domain";

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
  readonly artifactsToPut?: readonly ArtifactRecord[];
  readonly checkRunsToPut?: readonly CheckRun[];
  readonly deliveryEvaluationsToPut?: readonly DeliveryEvaluation[];
  readonly deliveriesToPut?: readonly DeliveryDraft[];
}

export interface ProjectTransaction {
  getCommandReceipt(commandId: string): Promise<CommandReceipt | null>;
  getProjectHead(): Promise<ProjectHead | null>;
  getCadJob(jobId: string): Promise<CadJob | null>;
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
