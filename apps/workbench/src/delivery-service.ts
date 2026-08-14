import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import { ArtifactRecordSchema, DeliveryDraftSchema, DeliveryEvaluationSchema, type ArtifactRecord, type CheckRun, type DeliveryDraft, type GeometryRevision } from "@gujian/domain";
import { IndexedDbProjectRepository, recordHash, sha256Hex } from "@gujian/infrastructure";

const GEOMETRY_KIND: Record<string, ArtifactRecord["kind"]> = {
  ifc: "ifc", glb: "glb", manifest: "geometryManifest", sourceMap: "geometrySourceMap",
  report: "geometryReport", preview: "geometryPreview",
};

export class DeliveryService {
  constructor(private readonly input: { repository: IndexedDbProjectRepository; commands: ProjectCommandService }) {}

  async createProxyDraft(head: ProjectHead, actorId: string, geometry: GeometryRevision, drawingArtifacts: readonly ArtifactRecord[], checkRun: CheckRun): Promise<{ head: ProjectHead; draft: DeliveryDraft }> {
    let updated = head;
    const existingArtifacts = await this.input.repository.getProjectArtifacts(head.projectId);
    const existingIds = new Set(existingArtifacts.map((item) => item.assetId));
    const geometryArtifacts = geometry.assets.filter((asset) => !existingIds.has(asset.assetId)).map((asset) => ArtifactRecordSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: geometry.projectRevisionId, geometryRevisionId: geometry.id,
      requirementMatrixId: null, kind: GEOMETRY_KIND[asset.kind]!, fileName: `${asset.kind}.${asset.kind === "glb" ? "glb" : asset.kind === "ifc" ? "ifc" : asset.kind === "preview" ? "png" : asset.kind === "sourceMap" ? "ndjson" : "json"}`,
      assetId: asset.assetId, sha256: asset.sha256, mimeType: asset.mimeType, byteLength: asset.byteLength,
      status: "generated-not-qualified", l1Eligible: false, formalEligibility: false, sourceRefs: [geometry.id],
      blockers: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"], createdAt: new Date().toISOString(),
    }));
    if (geometryArtifacts.length) {
      await this.input.commands.execute({ commandType: "CommitArtifactSet", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: updated.revisionId, issuedAt: new Date().toISOString(), payload: { artifacts: geometryArtifacts, assets: [], stagingSessionId: null } });
      updated = (await this.input.repository.getProjectHead(head.projectId))!;
    }
    const allArtifacts = [...geometryArtifacts, ...drawingArtifacts, ...(await this.input.repository.getProjectArtifacts(head.projectId)).filter((item) => item.geometryRevisionId === geometry.id)];
    const unique = [...new Map(allArtifacts.map((item) => [item.id, item])).values()];
    const evaluation = DeliveryEvaluationSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: updated.revisionId, geometryRevisionId: geometry.id,
      artifactRefs: unique.map((item) => item.id), checkRunRefs: [checkRun.id], outcome: "proxy-ready",
      blockerCodes: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE", "L1_ELIGIBILITY_FALSE"],
      formalEligibility: false, evaluatedAt: new Date().toISOString(),
    });
    await this.input.commands.execute({ commandType: "EvaluateDelivery", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: updated.revisionId, issuedAt: evaluation.evaluatedAt, payload: { evaluation } });
    updated = (await this.input.repository.getProjectHead(head.projectId))!;
    const manifestPayload = {
      schemaVersion: "1.0", projectId: head.projectId, projectRevisionId: updated.revisionId, geometryRevisionId: geometry.id,
      status: "proxy-unissued", qualification: "generated-not-qualified", l1Eligible: false, formalEligibility: false,
      artifacts: unique.map((item) => ({ artifactId: item.id, kind: item.kind, assetId: item.assetId, fileName: item.fileName, sha256: item.sha256, byteLength: item.byteLength })),
      blockers: evaluation.blockerCodes,
    };
    const bytes = new TextEncoder().encode(`${JSON.stringify(manifestPayload, null, 2)}\n`);
    const manifestAsset = {
      id: crypto.randomUUID(), projectId: head.projectId, fileName: "delivery-manifest.json", mimeType: "application/json",
      byteLength: bytes.byteLength, sha256: sha256Hex(bytes), contentStatus: "available" as const, createdAt: new Date().toISOString(),
    };
    const sessionId = crypto.randomUUID();
    await this.input.repository.stageAssets(sessionId, [manifestAsset], new Map([[manifestAsset.id, new Blob([bytes as BlobPart], { type: manifestAsset.mimeType })]]));
    const manifestArtifact = ArtifactRecordSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: updated.revisionId, geometryRevisionId: geometry.id,
      requirementMatrixId: null, kind: "deliveryManifest", fileName: manifestAsset.fileName, assetId: manifestAsset.id,
      sha256: manifestAsset.sha256, mimeType: manifestAsset.mimeType, byteLength: manifestAsset.byteLength,
      status: "generated-not-qualified", l1Eligible: false, formalEligibility: false, sourceRefs: [evaluation.id],
      blockers: evaluation.blockerCodes, createdAt: manifestAsset.createdAt,
    });
    const draft = DeliveryDraftSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: updated.revisionId, geometryRevisionId: geometry.id,
      evaluationId: evaluation.id, artifactRefs: [...unique.map((item) => item.id), manifestArtifact.id], manifestAssetId: manifestAsset.id,
      manifestHash: manifestAsset.sha256, status: "proxy-unissued", l1Eligible: false, formalEligibility: false, signatureStatus: "unsigned",
      restrictions: ["代理成果", "未签发", "不可用于正式交付或施工", "需专业复核"], createdAt: manifestAsset.createdAt,
    });
    await this.input.commands.execute({ commandType: "CreateDeliveryDraft", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: updated.revisionId, issuedAt: draft.createdAt, payload: { draft, manifestAsset, manifestArtifact, stagingSessionId: sessionId } });
    return { head: (await this.input.repository.getProjectHead(head.projectId))!, draft };
  }

  blockers(head: ProjectHead): string[] {
    const missingGeometry = ["geometry.overallWidthMm", "geometry.overallDepthMm", "geometry.baseHeightMm", "geometry.wallHeightMm", "geometry.ridgeHeightMm"]
      .filter((field) => !head.snapshot.facts.some((item) => item.field === field && item.reviewStatus === "confirmed" && item.dataStatus === "available"));
    const open = head.snapshot.issues.filter((item) => item.status === "open").map((item) => item.description);
    return [...missingGeometry.map((field) => `缺少已确认事实：${field}`), ...open];
  }

  async recordBlockedEvaluation(head: ProjectHead, actorId: string): Promise<import("@gujian/domain").DeliveryEvaluation> {
    const blockerCodes = this.blockers(head);
    if (!blockerCodes.length) throw new Error("DELIVERY_NOT_BLOCKED");
    const evaluation = DeliveryEvaluationSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: head.revisionId,
      geometryRevisionId: head.snapshot.geometryRevisions.at(-1)?.id ?? null,
      artifactRefs: [], checkRunRefs: [], outcome: "blocked", blockerCodes,
      formalEligibility: false, evaluatedAt: new Date().toISOString(),
    });
    await this.input.commands.execute({
      commandType: "EvaluateDelivery", commandId: crypto.randomUUID(), projectId: head.projectId,
      actorId, expectedRevisionId: head.revisionId, issuedAt: evaluation.evaluatedAt, payload: { evaluation },
    });
    return evaluation;
  }
}
