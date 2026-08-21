import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const NonEmptyRefSchema = z.string().min(1).max(200);
export const ExactNumberSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:\/(?:[1-9]\d*))?$/);

export const DataStatusSchema = z.enum(["available", "uncertain", "missing", "stale"]);
export const ReviewStatusSchema = z.enum(["unreviewed", "confirmed", "rejected", "superseded"]);

export const QuantitySchema = z.object({
  originalText: z.string().min(1).max(200),
  exactValue: ExactNumberSchema,
  originalUnit: z.string().min(1).max(32),
  normalizedValue: ExactNumberSchema,
  normalizedUnit: z.string().min(1).max(32),
  precision: ExactNumberSchema,
  conversionVersion: z.string().min(1).max(80),
}).strict();

export type Quantity = z.infer<typeof QuantitySchema>;
