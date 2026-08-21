import { describe, expect, it } from "vitest";

import { buildModelRunCostView, buildProjectDashboardSummary, buildProvenanceGraphView } from "./query-models";

const id = () => crypto.randomUUID();

describe("workbench query models", () => {
  it("derives an honest project summary without changing the project snapshot", () => {
    const projectId = id();
    const snapshot = {
      schemaVersion: "3.0" as const,
      project: { id: projectId, name: "test", status: "active" as const, locationText: null, createdAt: "2026-08-14T00:00:00.000Z" },
      buildings: [{ id: id(), projectId, name: "building", periodText: null, addressText: null, status: "uncertain" as const }],
      taskDefinitions: [], evidences: [], parseRecords: [], entities: [], exclusionRecords: [], relations: [], observations: [], measurements: [], facts: [], candidates: [], issues: [], dependencyEdges: [], geometrySpecs: [], geometryRevisions: [], adoptedRecordRefs: [],
    };
    const summary = buildProjectDashboardSummary({
      head: { projectId, revisionId: id(), auditEventId: id(), snapshot },
      modelRuns: [], ruleRuns: [], decisions: [], artifacts: [], checks: [], evaluations: [], deliveries: [],
    });
    expect(summary.stage).toBe("资料整理");
    expect(summary.evidenceCompleteness).toBe(0);
    expect(summary.qualificationLabel).toContain("未签发");
    expect(summary.qualificationLabel).toContain("未达专业样板等级");
    expect(snapshot.evidences).toHaveLength(0);
  });

  it("shows real usage while refusing to invent a price", () => {
    const view = buildModelRunCostView([{
      id: id(), projectId: id(), inputRevisionId: id(), inputHash: "a".repeat(64), provider: "moonshot", model: "kimi-k2.6", taskType: "evidence-summary", status: "succeeded",
      evidenceRefs: [], events: [
        { id: id(), runId: "00000000-0000-4000-8000-000000000000", sequence: 0, eventType: "queued", attempt: 1, detail: null, occurredAt: "2026-08-14T00:00:00.000Z" },
        { id: id(), runId: "00000000-0000-4000-8000-000000000000", sequence: 1, eventType: "succeeded", attempt: 1, detail: null, occurredAt: "2026-08-14T00:00:01.000Z" },
      ], usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, cachedTokens: 0 }, outputHash: "b".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", completedAt: "2026-08-14T00:00:01.000Z",
    }]);
    expect(view.totalTokens).toBe(18);
    expect(view.rows[0]?.costLabel).toBe("费用待核算");
    expect(view.hasPriceBasis).toBe(false);
  });
});

describe("来源面板的阻断计数", () => {
  it("没有三维模型时也把问题队列算进影响正式交付", () => {
    const projectId = id();
    const buildingId = id();
    const issue = (blocksFormal: boolean) => ({
      id: id(), projectId, issueType: "missingEvidence" as const, subjectRefs: [buildingId],
      description: "缺现场实测记录，尺寸只能按推算处理。", sourceRef: id(), status: "open" as const,
      impactRefs: [], blocksProxyOutcome: false, blocksFormalEligibility: blocksFormal,
      producer: { producerType: "demo" as const, fixtureId: "test" }, createdAt: "2026-08-18T00:00:00.000Z", resolvedAt: null,
    });
    const snapshot = {
      schemaVersion: "3.0" as const,
      project: { id: projectId, name: "test", status: "active" as const, locationText: null, createdAt: "2026-08-18T00:00:00.000Z" },
      buildings: [{ id: buildingId, projectId, name: "building", periodText: null, addressText: null, status: "existing" as const }],
      taskDefinitions: [], evidences: [], parseRecords: [], entities: [], exclusionRecords: [], relations: [], observations: [],
      measurements: [], facts: [], candidates: [], issues: [issue(true), issue(true), issue(false)],
      dependencyEdges: [], geometrySpecs: [], geometryRevisions: [], adoptedRecordRefs: [],
    };
    const view = buildProvenanceGraphView({
      head: { projectId, revisionId: id(), auditEventId: id(), snapshot },
      modelRuns: [], ruleRuns: [], decisions: [], artifacts: [], checks: [], evaluations: [], deliveries: [],
    }, null);
    expect(view.unknownCount).toBe(3);
    expect(view.formalBlockerCount).toBe(2);
  });
});
