import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import {
  ArtifactRecordSchema,
  DeliveryDraftSchema,
  DeliveryEvaluationSchema,
  type ArtifactRecord,
  type CheckRun,
  type DeliveryDraft,
  type DeliveryEvaluation,
  type GeometryRevision,
} from "@gujian/domain";
import { IndexedDbProjectRepository, sha256Hex } from "@gujian/infrastructure";

import { geometryPrerequisites } from "./geometry-spec-builder";

const GEOMETRY_KIND: Record<string, ArtifactRecord["kind"]> = {
  ifc: "ifc", glb: "glb", brepBundle: "brepBundle", manifest: "geometryManifest", sourceMap: "geometrySourceMap",
  report: "geometryReport", preview: "geometryPreview",
};

type DeliveryBlockerDetail = NonNullable<DeliveryEvaluation["blockerDetails"]>[number];
const FORMAL_ONLY_CODES = new Set(["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE", "L1_ELIGIBILITY_FALSE"]);

export function collectDeliveryBlockerDetails(head: ProjectHead, geometry: GeometryRevision, artifacts: readonly ArtifactRecord[], checkRun: CheckRun): DeliveryBlockerDetail[] {
  const details: DeliveryBlockerDetail[] = [];
  const add = (detail: DeliveryBlockerDetail) => {
    if (!details.some((item) => item.code === detail.code && item.sourceRef === detail.sourceRef)) details.push(detail);
  };
  for (const code of FORMAL_ONLY_CODES) {
    add({ code, sourceType: "qualification", sourceRef: geometry.id, message: "代理成果未取得专业复核、正式签发或 L1 资格。", blocksProxyOutcome: false });
  }
  const spec = head.snapshot.geometrySpecs.find((item) => item.id === geometry.geometrySpecId);
  for (const unknown of spec?.unknowns ?? []) {
    add({ code: `UNKNOWN:${unknown.reasonCode}`, sourceType: "unknown", sourceRef: unknown.id, message: unknown.description, blocksProxyOutcome: unknown.blocksProxyOutcome });
  }
  for (const issue of head.snapshot.issues.filter((item) => item.status === "open")) {
    add({ code: `OPEN_ISSUE:${issue.issueType}:${issue.id}`, sourceType: "issue", sourceRef: issue.id, message: issue.description, blocksProxyOutcome: issue.blocksProxyOutcome });
  }
  for (const result of checkRun.results.filter((item) => item.outcome === "blocked")) {
    add({ code: `CHECK_BLOCKED:${result.code}`, sourceType: "check", sourceRef: checkRun.id, message: result.message, blocksProxyOutcome: !FORMAL_ONLY_CODES.has(result.code) });
  }
  for (const artifact of artifacts) {
    for (const code of artifact.blockers) {
      add({ code, sourceType: "artifact", sourceRef: artifact.id, message: `成果 ${artifact.fileName} 的资格或质量阻断：${code}`, blocksProxyOutcome: !FORMAL_ONLY_CODES.has(code) });
    }
  }
  return details;
}

export class DeliveryService {
  constructor(private readonly input: { repository: IndexedDbProjectRepository; commands: ProjectCommandService }) {}

  async createProxyDraft(head: ProjectHead, actorId: string, geometry: GeometryRevision, drawingArtifacts: readonly ArtifactRecord[], checkRun: CheckRun): Promise<{ head: ProjectHead; draft: DeliveryDraft }> {
    let updated = head;
    const existingArtifacts = await this.input.repository.getProjectArtifacts(head.projectId);
    const existingIds = new Set(existingArtifacts.map((item) => item.assetId));
    const geometryArtifacts = geometry.assets.filter((asset) => !existingIds.has(asset.assetId)).map((asset) => ArtifactRecordSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: geometry.projectRevisionId, geometryRevisionId: geometry.id,
      requirementMatrixId: null, kind: GEOMETRY_KIND[asset.kind]!, fileName: asset.kind === "brepBundle" ? "model-brep.zip" : `${asset.kind}.${asset.kind === "glb" ? "glb" : asset.kind === "ifc" ? "ifc" : asset.kind === "preview" ? "png" : asset.kind === "sourceMap" ? "ndjson" : "json"}`,
      assetId: asset.assetId, sha256: asset.sha256, mimeType: asset.mimeType, byteLength: asset.byteLength,
      status: "generated-not-qualified", l1Eligible: false, formalEligibility: false, sourceRefs: [geometry.id],
      blockers: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"], createdAt: new Date().toISOString(),
    }));
    if (geometryArtifacts.length) {
      await this.input.commands.execute({ commandType: "CommitArtifactSet", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: updated.revisionId, issuedAt: new Date().toISOString(), payload: { artifacts: geometryArtifacts, assets: [], stagingSessionId: null } });
      updated = (await this.input.repository.getProjectHead(head.projectId))!;
    }
    const persistedArtifacts = (await this.input.repository.getProjectArtifacts(head.projectId))
      .filter((item) => item.geometryRevisionId === geometry.id);
    const geometryAssetIds = new Set(geometry.assets.map((asset) => asset.assetId));
    const checkedDrawingIds = new Set(checkRun.artifactRefs);
    const allArtifacts = [
      ...geometryArtifacts,
      ...persistedArtifacts.filter((item) => geometryAssetIds.has(item.assetId)),
      ...drawingArtifacts.filter((item) => checkedDrawingIds.has(item.id)),
    ];
    const unique = [...new Map(allArtifacts.map((item) => [item.id, item])).values()];
    const blockerDetails = collectDeliveryBlockerDetails(updated, geometry, unique, checkRun);
    const blockerCodes = [...new Set(blockerDetails.map((item) => item.code))];
    const blocksProxy = blockerDetails.some((item) => item.blocksProxyOutcome);
    const evaluation = DeliveryEvaluationSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: updated.revisionId, geometryRevisionId: geometry.id,
      artifactRefs: unique.map((item) => item.id), checkRunRefs: [checkRun.id], outcome: blocksProxy ? "blocked" : "proxy-ready",
      blockerCodes, blockerDetails, formalEligibility: false, evaluatedAt: new Date().toISOString(),
    });
    await this.input.commands.execute({ commandType: "EvaluateDelivery", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: updated.revisionId, issuedAt: evaluation.evaluatedAt, payload: { evaluation } });
    updated = (await this.input.repository.getProjectHead(head.projectId))!;
    if (blocksProxy) throw new Error(`DELIVERY_PROXY_BLOCKED:${blockerCodes.join(",")}`);

    const manifestPayload = {
      schemaVersion: "1.0", projectId: head.projectId, projectRevisionId: updated.revisionId, geometryRevisionId: geometry.id,
      status: "proxy-unissued", qualification: "generated-not-qualified", l1Eligible: false, formalEligibility: false,
      artifacts: unique.map((item) => ({ artifactId: item.id, kind: item.kind, assetId: item.assetId, fileName: item.fileName, sha256: item.sha256, byteLength: item.byteLength })),
      blockers: evaluation.blockerCodes,
      blockerDetails,
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
      restrictions: ["代理成果", "未签发", "不可用于正式交付或施工", "需专业复核", ...[...new Set(blockerDetails.map((item) => item.message))].slice(0, 96)], createdAt: manifestAsset.createdAt,
    });
    await this.input.commands.execute({ commandType: "CreateDeliveryDraft", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: updated.revisionId, issuedAt: draft.createdAt, payload: { draft, manifestAsset, manifestArtifact, stagingSessionId: sessionId } });
    return { head: (await this.input.repository.getProjectHead(head.projectId))!, draft };
  }

  blockers(head: ProjectHead): string[] {
    const missing = geometryPrerequisites(head).missing.map((field) => `缺少已确认事实或任务要求：${field}`);
    const open = head.snapshot.issues.filter((item) => item.status === "open").map((item) => item.description);
    return [...missing, ...open];
  }

  async recordBlockedEvaluation(head: ProjectHead, actorId: string): Promise<DeliveryEvaluation> {
    const messages = this.blockers(head);
    if (!messages.length) throw new Error("DELIVERY_NOT_BLOCKED");
    const openIssues = head.snapshot.issues.filter((item) => item.status === "open");
    const blockerDetails: DeliveryBlockerDetail[] = messages.map((message, index) => ({
      code: `PROJECT_INPUT_BLOCKED:${index + 1}`,
      sourceType: message.startsWith("缺少已确认") ? "fact" : "issue",
      sourceRef: openIssues.find((item) => item.description === message)?.id ?? head.projectId,
      message,
      blocksProxyOutcome: true,
    }));
    const evaluation = DeliveryEvaluationSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: head.revisionId,
      geometryRevisionId: head.snapshot.geometryRevisions.at(-1)?.id ?? null,
      artifactRefs: [], checkRunRefs: [], outcome: "blocked", blockerCodes: blockerDetails.map((item) => item.code), blockerDetails,
      formalEligibility: false, evaluatedAt: new Date().toISOString(),
    });
    await this.input.commands.execute({
      commandType: "EvaluateDelivery", commandId: crypto.randomUUID(), projectId: head.projectId,
      actorId, expectedRevisionId: head.revisionId, issuedAt: evaluation.evaluatedAt, payload: { evaluation },
    });
    return evaluation;
  }
}
