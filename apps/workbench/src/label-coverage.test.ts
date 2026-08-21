import { DataStatusSchema, EvidenceSchema, ParseRecordSchema, ProducerRefSchema, ReviewStatusSchema } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { DATA_STATUS_LABELS, EVIDENCE_TYPE_LABELS, PARSE_STATUS_LABELS, PRODUCER_LABELS, REVIEW_LABELS } from "./App";

// 界面标签表必须覆盖领域 schema 的全部取值。
// 少一个键，该状态就会以英文原值漏到界面（07 界面视觉规范第 8 节）；
// 多一个键说明写的是不存在的状态，永远匹配不到，属于假实现。

function producerTypes(): string[] {
  return ProducerRefSchema.options.map((option) => option.shape.producerType.value);
}

describe("界面标签覆盖领域取值", () => {
  it("来源标签与 producerType 一一对应", () => {
    expect(Object.keys(PRODUCER_LABELS).sort()).toEqual(producerTypes().sort());
  });

  it("审核状态标签与 ReviewStatus 一一对应", () => {
    expect(Object.keys(REVIEW_LABELS).sort()).toEqual([...ReviewStatusSchema.options].sort());
  });

  it("数据状态标签与 DataStatus 一一对应", () => {
    expect(Object.keys(DATA_STATUS_LABELS).sort()).toEqual([...DataStatusSchema.options].sort());
  });

  it("资料类别标签与 evidenceType 一一对应", () => {
    const options = EvidenceSchema.shape.evidenceType.options as readonly string[];
    expect(Object.keys(EVIDENCE_TYPE_LABELS).sort()).toEqual([...options].sort());
  });

  it("解析状态标签与 ParseRecord 状态一一对应", () => {
    const options = ParseRecordSchema.shape.status.options as readonly string[];
    expect(Object.keys(PARSE_STATUS_LABELS).sort()).toEqual([...options].sort());
  });

  // 漏了键，界面会把 measurementRecord 这种驼峰原值直接显示出来。
  // 缩写（AI）允许，连续小写字母串一律视为漏译。
  it("标签里不出现枚举原值", () => {
    const maps = [PRODUCER_LABELS, REVIEW_LABELS, DATA_STATUS_LABELS, EVIDENCE_TYPE_LABELS, PARSE_STATUS_LABELS];
    for (const map of maps) {
      for (const [key, label] of Object.entries(map)) {
        expect(label, key).not.toBe(key);
        expect(/[a-z]{3,}/.test(label), `${key}=${label}`).toBe(false);
      }
    }
  });

  it("存疑与已过期有独立说法，不与可用混同", () => {
    const values = Object.values(DATA_STATUS_LABELS);
    expect(new Set(values).size).toBe(values.length);
    expect(DATA_STATUS_LABELS.uncertain).toBe("存疑");
  });
});
