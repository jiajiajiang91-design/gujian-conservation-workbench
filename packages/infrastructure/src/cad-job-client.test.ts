import { describe, expect, it } from "vitest";
import { ProjectDrivenGeometrySpecSchema } from "@gujian/domain";
import { recordHash } from "./hash.js";

import { rebindExistingGeometrySpec } from "./cad-job-client.js";

const uuid = () => crypto.randomUUID();

describe("existing GeometrySpec input", () => {
  it("rebinds an imported project-owned spec while retaining stable component IDs", () => {
    const projectId = uuid();
    const buildingId = uuid();
    const objectId = uuid();
    const source = ProjectDrivenGeometrySpecSchema.parse({
      schemaVersion: "2.0", id: uuid(), projectId, projectRevisionId: uuid(), buildingId,
      inputHash: "a".repeat(64), coordinateSystem: { name: "local", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
      tolerances: { modellingMm: 0.1, interfaceMm: 0.2, tessellationMm: 0.5 },
      objects: [{ id: objectId, stableKey: "column:west", parentId: null, componentType: "column", displayNameZh: "西柱", materialCode: "demo-timber", solid: { kind: "box", sizeX: "200", sizeY: "200", sizeZ: "3000", centerMm: [0, 0, 1500] }, parameters: [], producer: { producerType: "demo", fixtureId: "portable-package" }, factRefs: [], evidenceRefs: [], unknownRefs: [] }],
      interfaces: [], unknowns: [], createdAt: "2026-08-14T00:00:00.000Z",
    });
    const revisionId = uuid();
    const head = {
      projectId, revisionId, auditEventId: uuid(), snapshot: {
        schemaVersion: "3.0" as const,
        project: { id: projectId, name: "portable", status: "active" as const, locationText: null, createdAt: "2026-08-14T00:00:00.000Z" },
        buildings: [{ id: buildingId, projectId, name: "building", periodText: null, addressText: null, status: "uncertain" as const }],
        taskDefinitions: [], evidences: [], parseRecords: [], entities: [], relations: [], observations: [], measurements: [], facts: [], candidates: [], issues: [], dependencyEdges: [], geometrySpecs: [source], geometryRevisions: [], adoptedRecordRefs: [],
      },
    };
    const rebound = rebindExistingGeometrySpec(head, source);
    expect(rebound.id).not.toBe(source.id);
    expect(rebound.projectRevisionId).toBe(revisionId);
    expect(rebound.objects[0]?.id).toBe(objectId);
    expect(rebound.objects[0]?.stableKey).toBe("column:west");
    expect(rebound.inputHash).not.toBe(source.inputHash);
    // 服务端 geometryInputHash 会把 inputHash 置零后按 canonical JSON 重算并比对；
    // 重绑结果必须能通过该校验，否则 existingGeometrySpec 路径被 CAD_INPUT_SNAPSHOT_INVALID 拒绝
    expect(rebound.inputHash).toBe(recordHash({ ...rebound, inputHash: "0".repeat(64) }));
  });
});
