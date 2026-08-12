import { z } from 'zod'

export const UuidSchema = z.string().uuid()
export const IsoDateTimeSchema = z.string().datetime({ offset: true })
export const ShortTextSchema = z.string().trim().min(1).max(200)
export const LongTextSchema = z.string().trim().min(1).max(4_000)
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const QuantitySchema = z
  .object({
    value: z.number().finite(),
    unit: z.enum(['mm', 'cm', 'm', 'degree']),
    precision: z.number().int().min(0).max(6).optional(),
  })
  .strict()

export type Quantity = z.infer<typeof QuantitySchema>

export const CandidateValueSchema = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.boolean(),
  QuantitySchema,
  z.array(z.string().max(500)).max(100),
])

export type CandidateValue = z.infer<typeof CandidateValueSchema>
