import { z } from "zod";

import { IsoDateTimeSchema, UuidSchema } from "./primitives.js";

// 受控词表（架构 v1.4 §5.6）：构件类型从自由字符串升级为词表引用。
// 同物异名是行业现状（檐柱又称小檐柱、金柱又称老檐柱），词表条目
// 保存首选名、别名、上位概念与术语出处；专业确认是带责任人的记录。
// 与 assistant-records 的 ComponentLibraryEntry 的关系：那是"入库确认
// 动作"的留痕记录，本条目是被确认与被引用的词表对象，两者分开保存。

export const ConceptConfirmationSchema = z.object({
  actorId: UuidSchema,
  decisionId: UuidSchema.optional(),
  reasonZh: z.string().min(1).max(500),
  confirmedAt: IsoDateTimeSchema,
}).strict();

export const ConceptEntrySchema = z.object({
  conceptId: z.string().min(1).max(120),
  prefLabelZh: z.string().min(1).max(120),
  altLabels: z.array(z.string().min(1).max(120)).max(50),
  broader: z.string().min(1).max(120).nullable(),
  sourceText: z.string().min(1).max(500),
  roleZh: z.string().min(1).max(200).nullable(),
  descZh: z.string().min(1).max(2_000).nullable(),
  confirmedBy: ConceptConfirmationSchema.nullable(),
}).strict();

export const ConceptEntriesFileSchema = z.object({
  schemaVersion: z.literal("concept-entries-1"),
  vocabularyId: z.string().min(1).max(120),
  sourceText: z.string().min(1).max(500),
  version: z.string().min(1).max(40),
  entries: z.array(ConceptEntrySchema).min(1).max(2_000),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.entries.map((entry) => entry.conceptId));
  if (ids.size !== value.entries.length) {
    context.addIssue({ code: "custom", message: "concept ids must be unique", path: ["entries"] });
  }
  for (const [index, entry] of value.entries.entries()) {
    if (entry.broader !== null && !ids.has(entry.broader)) {
      context.addIssue({ code: "custom", message: `broader concept is missing: ${entry.broader}`, path: ["entries", index, "broader"] });
    }
    if (entry.broader === entry.conceptId) {
      context.addIssue({ code: "custom", message: "concept cannot broaden itself", path: ["entries", index, "broader"] });
    }
  }
});

export type ConceptConfirmation = z.infer<typeof ConceptConfirmationSchema>;
export type ConceptEntry = z.infer<typeof ConceptEntrySchema>;
export type ConceptEntriesFile = z.infer<typeof ConceptEntriesFileSchema>;

// 上位概念闭包：返回 conceptId 及其全部上位概念（用于角色匹配）
export function broaderClosure(entries: readonly ConceptEntry[], conceptId: string): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.conceptId, entry]));
  const closure = new Set<string>();
  let current: string | null = conceptId;
  while (current !== null && !closure.has(current)) {
    closure.add(current);
    current = byId.get(current)?.broader ?? null;
  }
  return closure;
}
