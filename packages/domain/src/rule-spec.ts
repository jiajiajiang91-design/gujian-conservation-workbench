import { z } from "zod";

// 声明式规则层数据契约（架构 v1.4 §5.5）。
// 规则是数据不是程序：每条规则带规范出处，允许偏离文献但偏离连同理由被记录；
// 多规范表达为并存规则集，不是互斥真理。

export const RuleToleranceSchema = z.object({
  kind: z.enum(["absoluteMm", "ratio"]),
  value: z.string().regex(/^\d+(?:\.\d+)?$/),
}).strict();

export const RuleSpecSchema = z.object({
  ruleId: z.string().min(1).max(160),
  subjectConceptRef: z.string().min(1).max(200),
  dimension: z.string().min(1).max(120),
  // 公式以基准参数或其他规则的 ruleId 表达；byMeasurement 表示按实计
  formula: z.string().min(1).max(500),
  baseParams: z.array(z.string().min(1).max(120)).max(50),
  tolerance: RuleToleranceSchema.nullable(),
  sourceText: z.string().min(1).max(500),
  deviation: z.object({
    valueText: z.string().min(1).max(200),
    reasonZh: z.string().min(1).max(500),
  }).strict().nullable(),
  applicability: z.object({
    archetype: z.array(z.string().min(1).max(120)).max(50).optional(),
    scale: z.enum(["major", "minor"]).optional(),
  }).strict().nullable(),
}).strict();

export const RuleSpecFileSchema = z.object({
  schemaVersion: z.literal("rule-spec-1"),
  ruleSetId: z.string().min(1).max(120),
  sourceText: z.string().min(1).max(500),
  version: z.string().min(1).max(40),
  rules: z.array(RuleSpecSchema).min(1).max(500),
}).strict();

// 修改建议合理性核对的配置（表 10 生成修改建议行的程序核对，供 value-check 消费）
export const ModificationCheckConfigSchema = z.object({
  magnitudeBand: z.object({ minRatio: z.number().positive(), maxRatio: z.number().positive() }).strict(),
  anchorPart: z.string().min(1).max(120),
  mustExceedAnchor: z.array(z.string().min(1).max(120)).max(50),
  mustStayBelowAnchor: z.array(z.string().min(1).max(120)).max(50),
  estimateMarkPattern: z.string().min(1).max(120),
  measurementMatchToleranceMm: z.number().positive(),
}).strict();

// 规则数据文件顶层：程序规则参数、修改核对配置与并存规则集
export const RuleDataFileSchema = z.object({
  schemaVersion: z.literal("rule-data-1"),
  dataSetId: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  programParams: z.object({
    dimensionChainToleranceMm: z.string().regex(/^\d+(?:\.\d+)?$/),
  }).strict(),
  modificationCheck: ModificationCheckConfigSchema,
  ruleSets: z.array(RuleSpecFileSchema).max(20),
}).strict();

export type RuleTolerance = z.infer<typeof RuleToleranceSchema>;
export type RuleSpec = z.infer<typeof RuleSpecSchema>;
export type RuleSpecFile = z.infer<typeof RuleSpecFileSchema>;
export type ModificationCheckConfig = z.infer<typeof ModificationCheckConfigSchema>;
export type RuleDataFile = z.infer<typeof RuleDataFileSchema>;
