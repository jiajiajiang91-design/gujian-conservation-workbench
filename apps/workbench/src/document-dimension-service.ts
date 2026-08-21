import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import { FactEnvelopeSchema, type FactEnvelope } from "@gujian/domain";
import { IndexedDbProjectRepository } from "@gujian/infrastructure";

export async function commitDocumentedDimensionChain(input: {
  head: ProjectHead;
  actorId: string;
  repository: IndexedDbProjectRepository;
  commands: ProjectCommandService;
  totalWidthMm: number;
  segmentWidthsMm: number[];
  measurementMetadataComplete: boolean;
  evidenceRefs: string[];
}): Promise<ProjectHead> {
  if (!input.evidenceRefs.length || !Number.isFinite(input.totalWidthMm) || input.totalWidthMm <= 0 ||
      !input.segmentWidthsMm.length || input.segmentWidthsMm.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("DOCUMENTED_DIMENSION_CHAIN_INVALID");
  }
  const commandId = crypto.randomUUID();
  const facts: FactEnvelope[] = [
    ["documentedDimension.totalWidthMm", input.totalWidthMm],
    ["documentedDimension.segmentWidthsMm", input.segmentWidthsMm],
    ["documentedDimension.measurementMetadataComplete", input.measurementMetadataComplete],
  ].map(([field, value]) => FactEnvelopeSchema.parse({
    id: crypto.randomUUID(), subjectRef: input.head.snapshot.buildings[0]!.id, field, value,
    producer: { producerType: "human", actorId: input.actorId, actionRef: { commandId } },
    evidenceRefs: input.evidenceRefs, reviewStatus: "confirmed", acceptanceRef: { type: "command", id: commandId },
    dataStatus: "available",
  }));
  await input.commands.execute({
    commandType: "CommitFacts", commandId, projectId: input.head.projectId, actorId: input.actorId,
    expectedRevisionId: input.head.revisionId, issuedAt: new Date().toISOString(), payload: { facts },
  });
  const updated = await input.repository.getProjectHead(input.head.projectId);
  if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_DIMENSION_TRANSCRIPTION");
  return updated;
}
