import { describe, expect, it } from "vitest";

import { GeometryRevisionSchema, ProjectDrivenGeometrySpecSchema, TypedParameterSchema, UnknownValueSchema } from "./geometry.js";

describe("project-driven geometry contracts", () => {
  it("keeps length, angle, count, ratio and text values distinct", () => {
    const base = { id: crypto.randomUUID(), name: "参数", basis: "demo", factRefs: [], evidenceRefs: [] };
    expect(TypedParameterSchema.parse({ ...base, valueType: "length", exactValue: "4200", unit: "mm" }).valueType).toBe("length");
    expect(TypedParameterSchema.parse({ ...base, id: crypto.randomUUID(), valueType: "count", value: 5, unit: "1" }).valueType).toBe("count");
    expect(TypedParameterSchema.safeParse({ ...base, valueType: "count", value: 5, unit: "mm" }).success).toBe(false);
    expect(TypedParameterSchema.safeParse({ ...base, valueType: "length", exactValue: "5", unit: "1" }).success).toBe(false);
  });

  it("requires structured unknown impact and evidence needs", () => {
    const parsed = UnknownValueSchema.parse({
      id: crypto.randomUUID(), subjectRef: crypto.randomUUID(), reasonCode: "MEASUREMENT_MISSING",
      description: "缺少现场测量", requiredEvidence: ["带测量人和时间的原始记录"],
      affectedRefs: [crypto.randomUUID()], evidenceRefs: [], blocksProxyOutcome: false, blocksFormalEligibility: true,
    });
    expect(parsed.blocksFormalEligibility).toBe(true);
    expect(UnknownValueSchema.safeParse({ ...parsed, requiredEvidence: [] }).success).toBe(false);
  });

  it("rejects missing object, unknown and interface closure", () => {
    const projectId = crypto.randomUUID();
    const objectId = crypto.randomUUID();
    const value = {
      schemaVersion: "2.0", id: crypto.randomUUID(), projectId, projectRevisionId: crypto.randomUUID(), buildingId: crypto.randomUUID(), inputHash: "a".repeat(64),
      coordinateSystem: { name: "局部", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
      tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
      objects: [{
        id: objectId, stableKey: "base", parentId: null, componentType: "base", displayNameZh: "台基", materialCode: "demo",
        solid: { kind: "box", sizeX: "100", sizeY: "100", sizeZ: "100", centerMm: [0, 0, 50] },
        parameters: [], producer: { producerType: "demo", fixtureId: "test" }, factRefs: [], evidenceRefs: [], unknownRefs: [crypto.randomUUID()],
      }], interfaces: [], unknowns: [], createdAt: new Date().toISOString(),
    };
    expect(ProjectDrivenGeometrySpecSchema.safeParse(value).success).toBe(false);
  });

  it("requires all seven geometry assets and keeps qualification false", () => {
    const projectId = crypto.randomUUID();
    const asset = (kind: "ifc" | "glb" | "brepBundle" | "manifest" | "sourceMap" | "report" | "preview") => ({
      assetId: crypto.randomUUID(), kind, sha256: "a".repeat(64), mimeType: "application/octet-stream", byteLength: 1,
    });
    const revision = GeometryRevisionSchema.parse({
      id: crypto.randomUUID(), projectId, projectRevisionId: crypto.randomUUID(), geometrySpecId: crypto.randomUUID(),
      inputHash: "b".repeat(64), entityClosureHash: "c".repeat(64), interfaceClosureHash: "d".repeat(64), geometrySignature: "e".repeat(64),
      assets: [asset("ifc"), asset("glb"), asset("brepBundle"), asset("manifest"), asset("sourceMap"), asset("report"), asset("preview")],
      status: "generated-not-qualified", l1Eligible: false, formalEligibility: false,
      blockers: ["PROFESSIONAL_REVIEW_REQUIRED"], createdAt: new Date().toISOString(),
    });
    expect(revision.l1Eligible).toBe(false);
    expect(GeometryRevisionSchema.safeParse({ ...revision, l1Eligible: true }).success).toBe(false);
  });
});
