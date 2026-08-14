import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import { type FactEnvelope, FactEnvelopeSchema } from "@gujian/domain";
import { IndexedDbProjectRepository } from "@gujian/infrastructure";

export interface GeometryFactInput {
  overallWidthMm: number;
  overallDepthMm: number;
  baseHeightMm: number;
  wallHeightMm: number;
  ridgeHeightMm: number;
  evidenceRefs: string[];
}

export async function commitGeometryFacts(input: {
  head: ProjectHead; actorId: string; values: GeometryFactInput;
  repository: IndexedDbProjectRepository; commands: ProjectCommandService;
}): Promise<ProjectHead> {
  const fields = [
    ["geometry.overallWidthMm", input.values.overallWidthMm],
    ["geometry.overallDepthMm", input.values.overallDepthMm],
    ["geometry.baseHeightMm", input.values.baseHeightMm],
    ["geometry.wallHeightMm", input.values.wallHeightMm],
    ["geometry.ridgeHeightMm", input.values.ridgeHeightMm],
  ] as const;
  if (!input.values.evidenceRefs.length || fields.some(([, value]) => !Number.isFinite(value) || value <= 0)) throw new Error("GEOMETRY_FACT_INPUT_INVALID");
  const commandId = crypto.randomUUID();
  const facts: FactEnvelope[] = fields.map(([field, value]) => FactEnvelopeSchema.parse({
    id: crypto.randomUUID(), subjectRef: input.head.snapshot.buildings[0]!.id, field, value,
    producer: { producerType: "human", actorId: input.actorId, actionRef: { commandId } },
    evidenceRefs: input.values.evidenceRefs, reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId }, dataStatus: "available",
  }));
  await input.commands.execute({
    commandType: "CommitFacts", commandId, projectId: input.head.projectId, actorId: input.actorId,
    expectedRevisionId: input.head.revisionId, issuedAt: new Date().toISOString(), payload: { facts },
  });
  const head = await input.repository.getProjectHead(input.head.projectId);
  if (!head) throw new Error("PROJECT_NOT_FOUND_AFTER_GEOMETRY_FACTS");
  return head;
}
