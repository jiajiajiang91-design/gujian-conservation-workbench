import { describe, expect, it } from "vitest";

import { ModelCandidateOutputSchema, ModelCandidateSchema } from "./records.js";

// 模型候选的结构化输出按任务类型分，判别字段是 kind。
// 消费方据此分支，不靠字段有无来猜；界面渲染错了会把尺寸当摘要显示。

const base = {
  id: "3b241101-e2bb-4255-8caf-4136c566a962",
  projectId: "2fa4684c-f640-5c45-99cd-407305343f3f",
  runId: "d2511b25-9b51-562d-bb39-a05305712053",
  inputRevisionId: "9f8e7d6c-5b4a-4392-8170-fedcba987654",
  contentText: "原始输出",
  producer: { producerType: "model" as const, runId: "d2511b25-9b51-562d-bb39-a05305712053" },
  evidenceRefs: ["evidence:sheet-16"],
  reviewStatus: "unreviewed" as const,
  createdAt: "2026-08-20T00:00:00Z",
};

const dimension = {
  valueText: "24'-0\"",
  valueMm: "7315.2",
  partZh: "总面阔",
  evidenceRef: "evidence:sheet-16",
  locationZh: "图纸 16 平面下方标注",
  certainty: "certain" as const,
  noteZh: null,
};

describe("模型候选的结构化输出", () => {
  it("资料整理与测量转写按 kind 区分", () => {
    expect(ModelCandidateOutputSchema.parse({
      kind: "evidenceSummary", summary: "读了三份资料", findings: ["有平面图"], missingInformation: [],
    }).kind).toBe("evidenceSummary");
    expect(ModelCandidateOutputSchema.parse({
      kind: "measurementTranscription", summary: "读出十二条尺寸", dimensions: [dimension], missingInformation: [],
    }).kind).toBe("measurementTranscription");
  });

  it("缺 kind 直接拒收，不按字段猜任务类型", () => {
    expect(ModelCandidateOutputSchema.safeParse({
      summary: "读了三份资料", findings: [], missingInformation: [],
    }).success).toBe(false);
  });

  it("尺寸条目必须指明取自哪份资料", () => {
    const { evidenceRef, ...withoutEvidence } = dimension;
    void evidenceRef;
    expect(ModelCandidateOutputSchema.safeParse({
      kind: "measurementTranscription", summary: "读出一条", dimensions: [withoutEvidence], missingInformation: [],
    }).success).toBe(false);
  });

  // 用户旅程第二步：读不准的单独列出来由人工确认，不由模型替人决定
  it("确定与否是必填的两值，不允许省略", () => {
    const { certainty, ...withoutCertainty } = dimension;
    void certainty;
    expect(ModelCandidateOutputSchema.safeParse({
      kind: "measurementTranscription", summary: "读出一条", dimensions: [withoutCertainty], missingInformation: [],
    }).success).toBe(false);
    expect(ModelCandidateOutputSchema.safeParse({
      kind: "measurementTranscription", summary: "读出一条", dimensions: [{ ...dimension, certainty: "maybe" }], missingInformation: [],
    }).success).toBe(false);
  });

  it("换算毫米值可以为空：图上只写英尺时不强行换算", () => {
    expect(ModelCandidateOutputSchema.safeParse({
      kind: "measurementTranscription", summary: "读出一条",
      dimensions: [{ ...dimension, valueMm: null }], missingInformation: [],
    }).success).toBe(true);
  });

  it("候选整体带上结构化输出后仍通过校验", () => {
    const candidate = ModelCandidateSchema.parse({
      ...base,
      taskType: "measurement-transcription",
      structured: { kind: "measurementTranscription", summary: "读出一条", dimensions: [dimension], missingInformation: [] },
    });
    expect(candidate.structured?.kind).toBe("measurementTranscription");
  });

  it("运行失败时结构化输出为空，不留半截结果", () => {
    expect(ModelCandidateSchema.parse({ ...base, taskType: "evidence-summary", structured: null }).structured).toBeNull();
  });
});
