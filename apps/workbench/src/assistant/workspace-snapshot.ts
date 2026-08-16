// 工作区状态快照构造：只送计数与有无标记，不送全量事实。
// 与服务端 apps/server/src/actions/snapshot-types.ts 的契约一致。
export interface WorkspaceSnapshot {
  projectId: string | null;
  currentStage: string;
  openDockItems: number;
  componentCount: number;
  hasGeometryRevision: boolean;
  hasDrawings: boolean;
  hasDeliverable: boolean;
  modelRouteAvailable: boolean;
}

export interface SnapshotInput {
  projectId: string | null;
  currentStage: string;
  openIssueCount: number;
  entityCount: number;
  geometryRevisionCount: number;
  artifactCount: number;
  deliveryCount: number;
  serverModelConfigured: boolean;
}

export function buildWorkspaceSnapshot(input: SnapshotInput): WorkspaceSnapshot {
  return {
    projectId: input.projectId,
    currentStage: input.currentStage,
    openDockItems: Math.max(0, input.openIssueCount),
    componentCount: Math.max(0, input.entityCount),
    hasGeometryRevision: input.geometryRevisionCount > 0,
    hasDrawings: input.artifactCount > 0,
    hasDeliverable: input.deliveryCount > 0,
    modelRouteAvailable: input.serverModelConfigured,
  };
}
