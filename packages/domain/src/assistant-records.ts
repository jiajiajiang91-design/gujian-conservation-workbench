import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyRefSchema, UuidSchema } from "./primitives.js";

// 助手动作层新增的三类记录：构件库条目、排除记录、退回记录。
// 旧原型有对应实现（S.构件库 / S.排除记录 / S.退回记录），新架构此前缺位。
// 本文件先定义契约；命令注册与 IndexedDB store（v6 升 v7）在合并窗口接入，
// 接入前本文件不进 index.ts barrel，避免改共享文件。

// 构件库条目：责任人确认的形制判断入库复用（旅程第五步）。
// 字段按受控词表条目形态：首选名、别名、类别、参数模板、确认三要素。
export const ComponentLibraryEntrySchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  prefLabelZh: z.string().min(1).max(120),
  altLabels: z.array(z.string().min(1).max(120)).max(20),
  categoryZh: z.string().min(1).max(120),
  parameterTemplate: z.array(z.object({
    field: z.string().min(1).max(120),
    valueText: z.string().min(1).max(500),
  }).strict()).max(100),
  confirmedBy: z.object({
    actorId: UuidSchema,
    decisionId: UuidSchema.optional(),
    reasonZh: z.string().min(1).max(2_000),
    confirmedAt: IsoDateTimeSchema,
  }).strict(),
  sourceRefs: z.array(NonEmptyRefSchema).max(100),
}).strict();

// 排除记录：删除误识别时写入，识别任务读取以过滤同类误报（旧原型问题清单第 47 项，见历史归档）。
export const ExclusionRecordSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  subjectDescriptionZh: z.string().min(1).max(500),
  categoryZh: z.string().min(1).max(120).nullable(),
  reasonZh: z.string().min(1).max(2_000),
  excludedBy: UuidSchema,
  occurredAt: IsoDateTimeSchema,
  originRef: NonEmptyRefSchema.nullable(),
}).strict();

// 退回记录：审核退回或用户退回时写入。只打标受影响对象，不做局部重算（MVP 默认值）。
export const ReturnRecordSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  reasonZh: z.string().min(1).max(2_000),
  returnedBy: UuidSchema,
  occurredAt: IsoDateTimeSchema,
  targetStage: z.string().min(1).max(60),
  affectedRefs: z.array(NonEmptyRefSchema).min(1).max(1_000),
  resubmittedAt: IsoDateTimeSchema.nullable(),
}).strict();

export type ComponentLibraryEntry = z.infer<typeof ComponentLibraryEntrySchema>;
export type ExclusionRecord = z.infer<typeof ExclusionRecordSchema>;
export type ReturnRecord = z.infer<typeof ReturnRecordSchema>;
