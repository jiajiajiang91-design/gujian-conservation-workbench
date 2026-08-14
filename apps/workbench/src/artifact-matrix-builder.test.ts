import type { ProjectHead } from "@gujian/application";
import type { GeometryRevision, ProjectDrivenGeometrySpec, TaskArtifactRequirements } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { buildArtifactMatrix } from "./artifact-matrix-builder";

function input(requirements: TaskArtifactRequirements): { head: ProjectHead; geometry: GeometryRevision; spec: ProjectDrivenGeometrySpec } {
  const projectId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const buildingId = crypto.randomUUID();
  const geometryId = crypto.randomUUID();
  return {
    head: {
      projectId,
      revisionId,
      auditEventId: crypto.randomUUID(),
      snapshot: {
        schemaVersion: "3.0",
        project: { id: projectId, name: "任务驱动测试", status: "active", locationText: null, createdAt: "2026-08-14T00:00:00Z" },
        buildings: [{ id: buildingId, projectId, name: "测试建筑", periodText: null, addressText: null, status: "existing" }],
        taskDefinitions: [{
          id: crypto.randomUUID(), name: "代理成果", scope: ["当前建筑"], regulationRefs: [], deliverables: ["按矩阵制图"],
          responsibilities: [{ role: "projectLead", actorId: crypto.randomUUID() }], automationPolicyRef: null,
          artifactRequirements: requirements, confirmedAt: "2026-08-14T00:00:00Z",
        }],
        evidences: [], parseRecords: [], entities: [], relations: [], observations: [], measurements: [], facts: [], candidates: [], issues: [], dependencyEdges: [],
        geometrySpecs: [], geometryRevisions: [], adoptedRecordRefs: [],
      },
    },
    geometry: {
      id: geometryId, projectId, projectRevisionId: revisionId, geometrySpecId: crypto.randomUUID(), inputHash: "1".repeat(64),
      entityClosureHash: "2".repeat(64), interfaceClosureHash: "3".repeat(64), geometrySignature: "4".repeat(64), assets: [],
      status: "generated-not-qualified", l1Eligible: false, formalEligibility: false, blockers: ["PROXY_ONLY"], createdAt: "2026-08-14T00:00:00Z",
    } as GeometryRevision,
    spec: {
      schemaVersion: "2.0", id: crypto.randomUUID(), projectId, projectRevisionId: revisionId, buildingId, inputHash: "1".repeat(64),
      coordinateSystem: { name: "local", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
      tolerances: { modellingMm: 0.5, interfaceMm: 0.5, tessellationMm: 1 },
      objects: [{
        id: crypto.randomUUID(), stableKey: "base", parentId: null, componentType: "base", displayNameZh: "基座", materialCode: "documented",
        solid: { kind: "box", sizeX: "1000", sizeY: "800", sizeZ: "100", centerMm: [0, 0, 50] }, parameters: [],
        producer: { producerType: "rule", ruleRunId: crypto.randomUUID() }, factRefs: [], evidenceRefs: [], unknownRefs: [],
      }], interfaces: [], unknowns: [], createdAt: "2026-08-14T00:00:00Z",
    },
  };
}

const baseRequirements = (): TaskArtifactRequirements => ({
  titleZh: "测试建筑代理成果图",
  revisionLabel: "P1",
  geometryTargetRoles: ["base"],
  sheets: [{ key: "a3", drawingNumber: "P-07", displayLabelZh: "当前任务图纸", pageMm: [420, 297] }],
  views: [{
    key: "floor", displayLabelZh: "平面图", drawingRef: "平-01", kind: "floorPlan", scaleDenominator: 50,
    sheetKey: "a3", viewportRectMm: [20, 30, 380, 240], direction: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0],
    targetStableKeys: ["base"], sourceEvidenceRefs: [],
  }],
});

describe("buildArtifactMatrix", () => {
  it("只按结构化任务中的图幅、比例、布局和目标构件生成", () => {
    const current = input(baseRequirements());
    const matrix = buildArtifactMatrix(current.head, current.geometry, current.spec);
    expect(matrix.views.map((item) => [item.kind, item.scaleDenominator, item.viewportRectMm])).toEqual([["floorPlan", 50, [20, 30, 380, 240]]]);
    expect(matrix.sheets[0]?.pageMm).toEqual([420, 297]);
    expect(matrix.sheets[0]?.drawingNumber).toBe("P-07");
  });

  it("缺结构化成果矩阵时阻断", () => {
    const current = input(baseRequirements());
    delete current.head.snapshot.taskDefinitions[0]!.artifactRequirements;
    expect(() => buildArtifactMatrix(current.head, current.geometry, current.spec)).toThrow("DRAWING_REQUIREMENTS_STRUCTURED_MISSING");
  });

  it("详图缺局部证据或与横剖重复时不生成", () => {
    const requirements = baseRequirements();
    requirements.views.push({
      key: "section", displayLabelZh: "横剖面", drawingRef: "剖-01", kind: "transverseSection", scaleDenominator: 50,
      sheetKey: "a3", viewportRectMm: [20, 30, 180, 240], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1],
      sectionPlane: { normal: [1, 0, 0], offsetMm: 0 }, targetStableKeys: ["base"], sourceEvidenceRefs: [],
    }, {
      key: "detail", displayLabelZh: "节点详图", drawingRef: "详-01", kind: "detail", scaleDenominator: 10,
      sheetKey: "a3", viewportRectMm: [220, 30, 180, 240], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1],
      sectionPlane: { normal: [1, 0, 0], offsetMm: 0 }, cropBoundsMm: [-400, -100, 400, 500], targetStableKeys: ["base"], sourceEvidenceRefs: [crypto.randomUUID()],
    });
    const current = input(requirements);
    current.head.snapshot.evidences.push({
      id: requirements.views[2]!.sourceEvidenceRefs[0]!, projectId: current.head.projectId, assetId: crypto.randomUUID(), evidenceType: "drawing",
      title: "局部详图", rightsDeclaration: null, intendedUse: null, recordedAt: null, relatedEntityRefs: [], dataStatus: "available",
    });
    expect(() => buildArtifactMatrix(current.head, current.geometry, current.spec)).toThrow("DETAIL_DUPLICATES_BUILDING_SECTION");
  });
});
