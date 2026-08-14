import type { ProjectHead } from "@gujian/application";
import type { GeometryRevision, ProjectDrivenGeometrySpec } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { buildArtifactMatrix } from "./artifact-matrix-builder";

function input(deliverables: string[]): { head: ProjectHead; geometry: GeometryRevision; spec: ProjectDrivenGeometrySpec } {
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
          id: crypto.randomUUID(), name: "代理成果", scope: ["当前建筑"], regulationRefs: [], deliverables,
          responsibilities: [{ role: "projectLead", actorId: crypto.randomUUID() }], automationPolicyRef: null, confirmedAt: "2026-08-14T00:00:00Z",
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
        id: crypto.randomUUID(), stableKey: "base", parentId: null, componentType: "base", displayNameZh: "基座", materialCode: "demo",
        solid: { kind: "box", sizeX: "1000", sizeY: "800", sizeZ: "100", centerMm: [0, 0, 50] }, parameters: [],
        producer: { producerType: "rule", ruleRunId: crypto.randomUUID() }, factRefs: [], evidenceRefs: [], unknownRefs: [],
      }], interfaces: [], unknowns: [], createdAt: "2026-08-14T00:00:00Z",
    },
  };
}

describe("buildArtifactMatrix", () => {
  it("由三项任务要求生成一张图纸而不补充未要求视图", () => {
    const current = input(["平面", "南立面", "横剖"]);
    const matrix = buildArtifactMatrix(current.head, current.geometry, current.spec);
    expect(matrix.views.map((item) => item.kind)).toEqual(["floorPlan", "elevation", "transverseSection"]);
    expect(matrix.sheets).toHaveLength(1);
    expect(matrix.issueDate).toBeNull();
  });

  it("由七项任务要求生成两张图纸，视图和布局不依赖项目名称", () => {
    const current = input(["平面", "屋顶平面", "立面", "横剖", "纵剖", "轴测", "详图"]);
    current.head.snapshot.project.name = "任意第三方项目名称";
    const matrix = buildArtifactMatrix(current.head, current.geometry, current.spec);
    expect(matrix.views).toHaveLength(7);
    expect(matrix.sheets.map((sheet) => sheet.viewIds.length)).toEqual([4, 3]);
    expect(JSON.stringify(matrix)).not.toContain("targetViewId");
    expect(matrix.titleZh).toBe("测试建筑代理成果图");
  });
});
