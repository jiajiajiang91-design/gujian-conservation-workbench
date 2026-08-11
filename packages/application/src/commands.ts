import { z } from "zod";

import {
  BuildingSchema,
  FactEnvelopeSchema,
  IsoDateTimeSchema,
  ProjectSchema,
  UuidSchema,
} from "@gujian/domain";

const CommandHeaderSchema = z.object({
  commandId: UuidSchema,
  projectId: UuidSchema,
  actorId: UuidSchema,
  expectedRevisionId: UuidSchema.nullable(),
  issuedAt: IsoDateTimeSchema,
});

export const CreateProjectCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CreateProject"),
  expectedRevisionId: z.null(),
  payload: z.object({
    project: ProjectSchema,
    building: BuildingSchema,
  }).strict(),
}).strict();

export const CommitFactsCommandSchema = CommandHeaderSchema.extend({
  commandType: z.literal("CommitFacts"),
  expectedRevisionId: UuidSchema,
  payload: z.object({
    facts: z.array(FactEnvelopeSchema).min(1).max(1_000),
  }).strict(),
}).strict();

export const ProjectCommandSchema = z.discriminatedUnion("commandType", [
  CreateProjectCommandSchema,
  CommitFactsCommandSchema,
]);

export type CreateProjectCommand = z.infer<typeof CreateProjectCommandSchema>;
export type CommitFactsCommand = z.infer<typeof CommitFactsCommandSchema>;
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type ProjectCommandType = ProjectCommand["commandType"];
