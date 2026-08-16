import { broaderClosure, type ConceptEntry } from "@gujian/domain";

import { HERITAGE_CONCEPTS_V1 } from "./vocabulary/heritage-concepts-v1.js";

// 词表解析：种子词表加用户提交的 overlay（overlay 按 conceptId 覆盖种子）。
// 双写迁移期：componentType 字符串与 conceptId 一致的条目零成本映射。

export function resolveVocabulary(overlay: readonly ConceptEntry[] = []): readonly ConceptEntry[] {
  const merged = new Map<string, ConceptEntry>(
    HERITAGE_CONCEPTS_V1.entries.map((entry) => [entry.conceptId, entry as ConceptEntry]),
  );
  for (const entry of overlay) merged.set(entry.conceptId, entry);
  return [...merged.values()];
}

export function conceptLabel(entries: readonly ConceptEntry[], idOrType: string): string | null {
  const entry = entries.find((item) => item.conceptId === idOrType || item.altLabels.includes(idOrType));
  return entry ? entry.prefLabelZh : null;
}

// 角色匹配：精确或前缀（既有约定）→ 词表上位概念闭包（新能力）。
// 无词表命中时回退现行前缀规则，保证旧项目行为不变。
export function matchesGeometryRole(
  entries: readonly ConceptEntry[],
  componentType: string,
  conceptRef: string | undefined,
  role: string,
): boolean {
  if (componentType === role || componentType.startsWith(`${role}:`)) return true;
  const conceptId = conceptRef ?? componentType;
  if (entries.some((entry) => entry.conceptId === conceptId)) {
    return broaderClosure(entries, conceptId).has(role);
  }
  return false;
}
