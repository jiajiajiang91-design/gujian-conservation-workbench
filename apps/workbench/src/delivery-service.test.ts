import type { ProjectHead } from "@gujian/application";
import type { ArtifactRecord, CheckRun, GeometryRevision, ProjectDrivenGeometrySpec } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { collectDeliveryBlockerDetails } from "./delivery-service";

describe("delivery blocker propagation", () => {
  it("传播 open issue、结构化 unknown 和 blocked check，并区分仅正式资格阻断", () => {
    const projectId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const geometrySpecId = crypto.randomUUID();
    const geometryId = crypto.randomUUID();
    const objectId = crypto.randomUUID();
    const unknownId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const checkId = crypto.randomUUID();
    const spec = {
      schemaVersion: "2.0", id: geometrySpecId, projectId, projectRevisionId: revisionId, buildingId: crypto.randomUUID(), inputHash: "1".repeat(64),
      coordinateSystem: { name: "local", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] }, tolerances: { modellingMm: 0.5, interfaceMm: 0.5, tessellationMm: 1 },
      objects: [{ id: objectId, stableKey: "wall", parentId: null, componentType: "wall", displayNameZh: "墙", materialCode: "documented", solid: { kind: "box", sizeX: "1", sizeY: "1", sizeZ: "1", centerMm: [0, 0, 0] }, parameters: [], producer: { producerType: "rule", ruleRunId: crypto.randomUUID() }, factRefs: [], evidenceRefs: [], unknownRefs: [unknownId] }],
      interfaces: [], unknowns: [{ id: unknownId, subjectRef: objectId, reasonCode: "WALL_SECTION_MISSING", description: "墙身构造缺失。", requiredEvidence: ["墙身详图"], affectedRefs: [objectId], evidenceRefs: [], blocksProxyOutcome: true, blocksFormalEligibility: true }],
      createdAt: "2026-08-14T00:00:00Z",
    } as ProjectDrivenGeometrySpec;
    const head = {
      projectId, revisionId, auditEventId: crypto.randomUUID(),
      snapshot: {
        geometrySpecs: [spec],
        issues: [{ id: issueId, projectId, issueType: "ruleConflict", subjectRefs: [objectId], description: "开口定位冲突。", sourceRef: "rule:opening", status: "open", impactRefs: [geometryId], blocksProxyOutcome: true, blocksFormalEligibility: true, producer: { producerType: "rule", ruleRunId: crypto.randomUUID() }, createdAt: "2026-08-14T00:00:00Z", resolvedAt: null }],
      },
    } as unknown as ProjectHead;
    const geometry = { id: geometryId, geometrySpecId } as GeometryRevision;
    const checkRun = {
      id: checkId,
      results: [
        { code: "GEOMETRY_SOURCE_CLOSURE_FAILED", outcome: "blocked", message: "来源闭包失败。", sourceRefs: [geometryId] },
        { code: "PROFESSIONAL_REVIEW_REQUIRED", outcome: "blocked", message: "需专业复核。", sourceRefs: [geometryId] },
      ],
    } as CheckRun;
    const artifact = { id: crypto.randomUUID(), fileName: "drawing.dxf", blockers: ["FORMAL_SIGNOFF_UNAVAILABLE"] } as ArtifactRecord;
    const details = collectDeliveryBlockerDetails(head, geometry, [artifact], checkRun);
    expect(details.some((item) => item.sourceType === "unknown" && item.blocksProxyOutcome)).toBe(true);
    expect(details.some((item) => item.sourceType === "issue" && item.blocksProxyOutcome)).toBe(true);
    expect(details.some((item) => item.code === "CHECK_BLOCKED:GEOMETRY_SOURCE_CLOSURE_FAILED" && item.blocksProxyOutcome)).toBe(true);
    expect(details.find((item) => item.code === "CHECK_BLOCKED:PROFESSIONAL_REVIEW_REQUIRED")?.blocksProxyOutcome).toBe(false);
    expect(details.find((item) => item.code === "FORMAL_SIGNOFF_UNAVAILABLE")?.blocksProxyOutcome).toBe(false);
  });
});
