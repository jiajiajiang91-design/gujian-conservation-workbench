import { DataStatusSchema, ProducerRefSchema, ReviewStatusSchema } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { DATA_STATUS_LABELS, PRODUCER_LABELS, REVIEW_LABELS } from "./App";

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

  it("存疑与已过期有独立说法，不与可用混同", () => {
    const values = Object.values(DATA_STATUS_LABELS);
    expect(new Set(values).size).toBe(values.length);
    expect(DATA_STATUS_LABELS.uncertain).toBe("存疑");
  });
});
