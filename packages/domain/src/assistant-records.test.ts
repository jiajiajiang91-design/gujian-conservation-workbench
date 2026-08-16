import { describe, expect, it } from "vitest";

import {
  ComponentLibraryEntrySchema,
  ExclusionRecordSchema,
  ReturnRecordSchema,
} from "./assistant-records.js";

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

describe("构件库条目", () => {
  it("完整条目通过，确认三要素必填", () => {
    const entry = {
      id: uuid(), projectId: uuid(),
      prefLabelZh: "五铺作单杪单昂", altLabels: ["五铺作"], categoryZh: "铺作",
      parameterTemplate: [{ field: "出跳", valueText: "两跳" }],
      confirmedBy: { actorId: uuid(), reasonZh: "按栌斗尺度与昂嘴形制判定", confirmedAt: now() },
      sourceRefs: ["evidence:photo-17"],
    };
    expect(ComponentLibraryEntrySchema.safeParse(entry).success).toBe(true);
    const missingReason = { ...entry, confirmedBy: { actorId: uuid(), confirmedAt: now() } };
    expect(ComponentLibraryEntrySchema.safeParse(missingReason).success).toBe(false);
  });
});

describe("排除记录", () => {
  it("原因必填，来源可空", () => {
    const record = {
      id: uuid(), projectId: uuid(),
      subjectDescriptionZh: "右次间下部误识别的替木", categoryZh: "替木",
      reasonZh: "该位置为树木阴影，非构件", excludedBy: uuid(), occurredAt: now(), originRef: null,
    };
    expect(ExclusionRecordSchema.safeParse(record).success).toBe(true);
    expect(ExclusionRecordSchema.safeParse({ ...record, reasonZh: "" }).success).toBe(false);
  });
});

describe("退回记录", () => {
  it("受影响对象至少一条，重新提交时间可空", () => {
    const record = {
      id: uuid(), projectId: uuid(),
      reasonZh: "明间面阔与实测不符", returnedBy: uuid(), occurredAt: now(),
      targetStage: "objects", affectedRefs: ["entity:P12"], resubmittedAt: null,
    };
    expect(ReturnRecordSchema.safeParse(record).success).toBe(true);
    expect(ReturnRecordSchema.safeParse({ ...record, affectedRefs: [] }).success).toBe(false);
  });
});
