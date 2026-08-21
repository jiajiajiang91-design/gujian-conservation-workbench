import type { ProjectHead } from "@gujian/application";
import { describe, expect, it } from "vitest";

import { buildProjectGeometrySpec, geometryPrerequisites } from "./geometry-spec-builder.js";

function head(): ProjectHead {
  const projectId = crypto.randomUUID();
  const buildingId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  const wallEvidenceId = crypto.randomUUID();
  const supportEvidenceId = crypto.randomUUID();
  const wallFactId = crypto.randomUUID();
  const supportFactId = crypto.randomUUID();
  return {
    projectId, revisionId, auditEventId: crypto.randomUUID(),
    snapshot: {
      schemaVersion: "3.0",
      project: { id: projectId, name: "证据几何测试", status: "active", locationText: null, createdAt: "2026-08-14T00:00:00Z" },
      buildings: [{ id: buildingId, projectId, name: "测试建筑", periodText: null, addressText: null, status: "existing" }],
      taskDefinitions: [{
        id: crypto.randomUUID(), name: "代理几何", scope: ["有证据构件"], regulationRefs: [], deliverables: ["平面"],
        responsibilities: [{ role: "projectLead", actorId }], automationPolicyRef: null, confirmedAt: "2026-08-14T00:00:00Z",
        artifactRequirements: {
          titleZh: "测试代理成果", revisionLabel: "P1", geometryTargetRoles: ["wall", "support"],
          sheets: [{ key: "sheet", drawingNumber: "P-01", displayLabelZh: "平面", pageMm: [420, 297] }],
          views: [{ key: "plan", displayLabelZh: "平面", drawingRef: "平-01", kind: "floorPlan", scaleDenominator: 50, sheetKey: "sheet", viewportRectMm: [20, 20, 380, 250], direction: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], targetStableKeys: ["wall:east", "post:east"], sourceEvidenceRefs: [wallEvidenceId, supportEvidenceId] }],
        },
      }],
      evidences: [
        { id: wallEvidenceId, projectId, assetId: crypto.randomUUID(), evidenceType: "drawing", title: "图纸第 3 张", rightsDeclaration: null, intendedUse: null, recordedAt: null, relatedEntityRefs: [], dataStatus: "available" },
        { id: supportEvidenceId, projectId, assetId: crypto.randomUUID(), evidenceType: "drawing", title: "图纸第 10 张", rightsDeclaration: null, intendedUse: null, recordedAt: null, relatedEntityRefs: [], dataStatus: "available" },
      ],
      parseRecords: [], entities: [], exclusionRecords: [], relations: [], observations: [], measurements: [], candidates: [], issues: [], dependencyEdges: [], geometrySpecs: [], geometryRevisions: [], adoptedRecordRefs: [],
      facts: [
        {
          id: wallFactId, subjectRef: buildingId, field: "geometry.component.wall:east", reviewStatus: "confirmed", dataStatus: "available",
          producer: { producerType: "human", actorId, actionRef: { commandId: crypto.randomUUID() } }, evidenceRefs: [wallEvidenceId],
          value: {
            stableKey: "wall:east", parentStableKey: null, componentType: "wall", displayNameZh: "东墙可证墙段", materialCode: "bousillage-documented",
            solid: { kind: "box", sizeX: "177.8", sizeY: "6273.8", sizeZ: "2755.9", centerMm: [4676.775, 0, 1377.95] }, parameters: [],
            sourceLocation: "sheet 3, floor plan and plan detail; sheet 4 level", evidenceRefs: [wallEvidenceId],
            unknowns: [{ reasonCode: "WALL_CONNECTION_UNRESOLVED", description: "墙顶连接未完成逐项转写。", requiredEvidence: ["sheets 6–8 wall sections"], affectedStableKeys: ["wall:east"], blocksProxyOutcome: false, blocksFormalEligibility: true }],
          },
        },
        {
          id: supportFactId, subjectRef: buildingId, field: "geometry.component.post:east", reviewStatus: "confirmed", dataStatus: "available",
          producer: { producerType: "human", actorId, actionRef: { commandId: crypto.randomUUID() } }, evidenceRefs: [supportEvidenceId],
          value: {
            stableKey: "post:east", parentStableKey: null, componentType: "support", displayNameZh: "东侧木柱", materialCode: "cypress-documented",
            solid: { kind: "box", sizeX: "127", sizeY: "127", sizeZ: "2755.9", centerMm: [0, 0, 1377.95] }, parameters: [],
            sourceLocation: "sheet 10, wall framing isometric, 5 inch post callout", evidenceRefs: [supportEvidenceId], unknowns: [],
          },
        },
      ],
    },
  };
}

describe("evidence-bound geometry spec", () => {
  it("逐构件只继承其具体事实和证据，不扩散到全部资料", () => {
    const current = head();
    expect(geometryPrerequisites(current).ready).toBe(true);
    const spec = buildProjectGeometrySpec(current, crypto.randomUUID());
    const wall = spec.objects.find((item) => item.stableKey === "wall:east")!;
    const support = spec.objects.find((item) => item.stableKey === "post:east")!;
    expect(wall.factRefs).toEqual([current.snapshot.facts[0]!.id]);
    expect(wall.evidenceRefs).toEqual([current.snapshot.evidences[0]!.id]);
    expect(support.evidenceRefs).toEqual([current.snapshot.evidences[1]!.id]);
    expect(spec.unknowns.map((item) => item.reasonCode)).toContain("WALL_CONNECTION_UNRESOLVED");
    expect(JSON.stringify(spec)).not.toContain("stone-proxy");
  });

  it("仅有五个总尺寸时阻断，不推导墙厚、出檐和构造层", () => {
    const current = head();
    current.snapshot.facts = ["overallWidthMm", "overallDepthMm", "baseHeightMm", "wallHeightMm", "ridgeHeightMm"].map((field) => ({
      id: crypto.randomUUID(), subjectRef: current.snapshot.buildings[0]!.id, field: `geometry.${field}`, value: 1000,
      producer: { producerType: "human" as const, actorId: crypto.randomUUID(), actionRef: { commandId: crypto.randomUUID() } }, evidenceRefs: [current.snapshot.evidences[0]!.id], reviewStatus: "confirmed" as const, dataStatus: "available" as const,
    }));
    expect(geometryPrerequisites(current).ready).toBe(false);
    expect(() => buildProjectGeometrySpec(current, crypto.randomUUID())).toThrow("GEOMETRY_EVIDENCE_FACTS_MISSING");
  });
});
