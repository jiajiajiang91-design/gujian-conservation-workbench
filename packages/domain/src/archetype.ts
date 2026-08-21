import { z } from "zod";

import { IsoDateTimeSchema, UuidSchema } from "./primitives.js";
import { ProducerRefSchema } from "./provenance.js";

// 形制参数层（架构 v1.4 §5.7）：应然值模板，独立于 GeometrySpec，
// 不进 CAD 合同。派生服务按模板与规则集推导应然尺寸，实测值覆盖，
// 两层之差即现状记录。应然值不能作为实测成果或正式标注依据。

const ExactNumberTextSchema = z.string().regex(/^\d+(?:\.\d+)?$/);

// 柱网坐标串（ACA-Builder pillar_net 模式）："0/0,0/1,1/0,1/1"
export const PILLAR_NET_PATTERN = /^\d+\/\d+(?:,\d+\/\d+)*$/;
// 枋连接柱对串（fang_net 模式）："0/0#1/0,0/1#1/1"
export const FANG_NET_PATTERN = /^\d+\/\d+#\d+\/\d+(?:,\d+\/\d+#\d+\/\d+)*$/;

export const ArchetypeSpecSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  buildingRef: UuidSchema,
  // 模数基参（如柱径 D 或斗口），键为公式标识符
  baseParams: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ExactNumberTextSchema),
  bayDimensions: z.array(z.object({
    direction: z.enum(["x", "y"]),
    valuesMm: z.array(ExactNumberTextSchema).min(1).max(20),
  }).strict()).min(1).max(2),
  // 举架系数组引用规则集（规范选择停靠的所选方案）
  liftRatioSetRef: z.string().min(1).max(120).nullable(),
  stepCount: z.number().int().positive().max(20),
  pillarNet: z.string().regex(PILLAR_NET_PATTERN).max(2_000),
  fangNet: z.string().regex(FANG_NET_PATTERN).max(2_000).nullable(),
  sourceDeclaration: z.string().min(1).max(500),
  producer: ProducerRefSchema,
  createdAt: IsoDateTimeSchema,
}).strict();

export type ArchetypeSpec = z.infer<typeof ArchetypeSpecSchema>;

export interface PillarPosition { readonly column: number; readonly row: number }

export function parsePillarNet(net: string): PillarPosition[] {
  return net.split(",").map((token) => {
    const [column, row] = token.split("/").map(Number) as [number, number];
    return { column, row };
  });
}

export function parseFangNet(net: string): Array<{ from: PillarPosition; to: PillarPosition }> {
  return net.split(",").map((token) => {
    const [fromToken, toToken] = token.split("#") as [string, string];
    const [fromColumn, fromRow] = fromToken.split("/").map(Number) as [number, number];
    const [toColumn, toRow] = toToken.split("/").map(Number) as [number, number];
    return { from: { column: fromColumn, row: fromRow }, to: { column: toColumn, row: toRow } };
  });
}
