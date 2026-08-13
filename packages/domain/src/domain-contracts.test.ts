import { describe, expect, it } from "vitest";

import {
  FactEnvelopeSchema,
  GeometrySpecSchema,
  MeasurementRecordSchema,
  ProjectSnapshotSchema,
  QuantitySchema,
} from "./index.js";

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  building: "00000000-0000-4000-8000-000000000002",
  fact: "00000000-0000-4000-8000-000000000003",
  run: "00000000-0000-4000-8000-000000000004",
  measurement: "00000000-0000-4000-8000-000000000005",
  actor: "00000000-0000-4000-8000-000000000006",
  revision: "00000000-0000-4000-8000-000000000007",
  unknown: "00000000-0000-4000-8000-000000000008",
};

const quantity = {
  originalText: "4200 mm",
  exactValue: "4200",
  originalUnit: "mm",
  normalizedValue: "4.2",
  normalizedUnit: "m",
  precision: "1",
  conversionVersion: "unit-conversion-1",
};

function minimalSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: "3.0",
    project: {
      id: ids.project,
      name: "测试项目",
      status: "active",
      locationText: null,
      createdAt: "2026-08-11T00:00:00Z",
    },
    buildings: [{
      id: ids.building,
      projectId: ids.project,
      name: "测试建筑",
      periodText: null,
      addressText: null,
      status: "existing",
    }],
    taskDefinitions: [],
    evidences: [],
    parseRecords: [],
    entities: [],
    relations: [],
    observations: [],
    measurements: [],
    facts: [],
    issues: [],
    dependencyEdges: [],
    adoptedRecordRefs: [],
  };
}

describe("来源责任契约", () => {
  it("拒绝 system、program 和缺少运行引用的模型来源", () => {
    const baseFact = {
      id: ids.fact,
      subjectRef: ids.building,
      field: "bayWidth",
      value: quantity,
      evidenceRefs: ["evidence:field-note-1"],
      reviewStatus: "unreviewed",
      dataStatus: "available",
    };

    expect(FactEnvelopeSchema.safeParse({ ...baseFact, producer: { producerType: "system" } }).success).toBe(false);
    expect(FactEnvelopeSchema.safeParse({ ...baseFact, producer: { producerType: "program" } }).success).toBe(false);
    expect(FactEnvelopeSchema.safeParse({ ...baseFact, producer: { producerType: "model" } }).success).toBe(false);
  });

  it("人工接受模型候选后仍保留模型运行来源", () => {
    const parsed = FactEnvelopeSchema.parse({
      id: ids.fact,
      subjectRef: ids.building,
      field: "bayWidth",
      value: quantity,
      producer: { producerType: "model", runId: ids.run },
      evidenceRefs: ["evidence:field-note-1"],
      reviewStatus: "confirmed",
      acceptanceRef: { type: "decision", id: ids.actor },
      dataStatus: "available",
    });

    expect(parsed.producer).toEqual({ producerType: "model", runId: ids.run });
    expect(parsed.acceptanceRef).toEqual({ type: "decision", id: ids.actor });
  });
});

describe("测量与未知值契约", () => {
  it("测量元数据完整性必须与人员、时间和方法一致", () => {
    const record = {
      id: ids.measurement,
      subjectRef: ids.building,
      quantity,
      measuredBy: ids.actor,
      measuredAt: "2026-08-11T09:00:00+01:00",
      method: null,
      originalEvidenceRef: "evidence:field-note-1",
      instrumentText: null,
      pointRef: null,
      metadataStatus: "complete",
      producer: { producerType: "model", runId: ids.run },
      dataStatus: "available",
    };

    expect(MeasurementRecordSchema.safeParse(record).success).toBe(false);
    expect(MeasurementRecordSchema.parse({ ...record, metadataStatus: "incomplete" }).producer.producerType).toBe("model");
  });

  it("数量必须保留原值、单位、精度和换算版本", () => {
    expect(QuantitySchema.safeParse({ ...quantity, originalUnit: "" }).success).toBe(false);
    expect(QuantitySchema.safeParse({ ...quantity, exactValue: "unknown" }).success).toBe(false);
    expect(QuantitySchema.safeParse({ ...quantity, exactValue: "1/0" }).success).toBe(false);
  });

  it("几何输入用明确未知区表达缺失，不用零值替代", () => {
    const parsed = GeometrySpecSchema.parse({
      schemaVersion: "1.0",
      projectRevisionId: ids.revision,
      inputHash: "a".repeat(64),
      projectCoordinateSystem: "local-project-mm",
      localCoordinateSystems: [],
      lengthUnit: "mm",
      angleUnit: "degree",
      modellingTolerance: { ...quantity, originalText: "1 mm", exactValue: "1", normalizedValue: "1", normalizedUnit: "mm" },
      drawingTolerance: { ...quantity, originalText: "2 mm", exactValue: "2", normalizedValue: "2", normalizedUnit: "mm" },
      primitives: [],
      unknownRegions: [{
        id: ids.unknown,
        subjectRef: ids.building,
        reasonCode: "missing-measured-roof-rise",
        evidenceRefs: [],
      }],
      unresolvedConstraintRefs: ["constraint:roof-rise"],
    });

    expect(parsed.primitives).toHaveLength(0);
    expect(parsed.unknownRegions[0]?.reasonCode).toBe("missing-measured-roof-rise");
  });
});

describe("项目快照边界", () => {
  it("不允许把版本、运行、成果、交付或审计历史嵌入快照", () => {
    for (const forbidden of ["revisions", "modelRuns", "ruleRuns", "artifacts", "deliveries", "auditEvents"]) {
      expect(ProjectSnapshotSchema.safeParse({ ...minimalSnapshot(), [forbidden]: [] }).success).toBe(false);
    }
  });

  it("拒绝跨项目建筑引用", () => {
    const snapshot = minimalSnapshot();
    snapshot.buildings = [{
      ...(snapshot.buildings as Array<Record<string, unknown>>)[0],
      projectId: "00000000-0000-4000-8000-000000000099",
    }];
    expect(ProjectSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
