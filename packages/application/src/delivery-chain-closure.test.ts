import type { ArtifactRecord, CheckRun, DeliveryDraft, DeliveryEvaluation, GeometryRevision } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { assertDeliveryChainClosure } from "./delivery-chain-closure.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-000000000002";
const at = "2026-08-14T00:00:00.000Z";
const hash = (value: string) => value.repeat(64);
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function geometry(value: number): GeometryRevision {
  return {
    id: id(value), projectId, projectRevisionId: revisionId, geometrySpecId: id(value + 100), inputHash: hash("1"),
    entityClosureHash: hash("2"), interfaceClosureHash: hash("3"), geometrySignature: hash("4"),
    assets: [
      { assetId: id(value + 200), kind: "ifc", sha256: hash("5"), mimeType: "application/x-step", byteLength: 10 },
      { assetId: id(value + 201), kind: "glb", sha256: hash("6"), mimeType: "model/gltf-binary", byteLength: 10 },
      { assetId: id(value + 202), kind: "manifest", sha256: hash("7"), mimeType: "application/json", byteLength: 10 },
      { assetId: id(value + 203), kind: "sourceMap", sha256: hash("8"), mimeType: "application/x-ndjson", byteLength: 10 },
      { assetId: id(value + 204), kind: "report", sha256: hash("9"), mimeType: "application/json", byteLength: 10 },
      { assetId: id(value + 205), kind: "preview", sha256: hash("a"), mimeType: "image/png", byteLength: 10 },
    ],
    status: "generated-not-qualified", l1Eligible: false, formalEligibility: false,
    blockers: ["PROFESSIONAL_REVIEW_REQUIRED"], createdAt: at,
  };
}

function artifact(input: Partial<ArtifactRecord> & Pick<ArtifactRecord, "id" | "geometryRevisionId" | "kind" | "assetId" | "sha256" | "mimeType" | "byteLength">): ArtifactRecord {
  return {
    projectId, projectRevisionId: revisionId, requirementMatrixId: null, fileName: `${input.kind}.dat`,
    status: "generated-not-qualified", l1Eligible: false, formalEligibility: false, sourceRefs: [input.geometryRevisionId],
    blockers: ["PROFESSIONAL_REVIEW_REQUIRED"], createdAt: at, ...input,
  };
}

function validGraph() {
  const first = geometry(10);
  const second = geometry(20);
  const ifcAsset = first.assets[0]!;
  const ifc = artifact({ id: id(300), geometryRevisionId: first.id, kind: "ifc", assetId: ifcAsset.assetId, sha256: ifcAsset.sha256, mimeType: ifcAsset.mimeType, byteLength: ifcAsset.byteLength });
  const dxf = artifact({ id: id(301), geometryRevisionId: first.id, kind: "dxf", assetId: id(401), sha256: hash("b"), mimeType: "image/vnd.dxf", byteLength: 20 });
  const report = artifact({ id: id(302), geometryRevisionId: first.id, kind: "checkReport", assetId: id(402), sha256: hash("c"), mimeType: "application/json", byteLength: 30 });
  const other = artifact({ id: id(303), geometryRevisionId: second.id, kind: "dxf", assetId: id(403), sha256: hash("d"), mimeType: "image/vnd.dxf", byteLength: 20 });
  const check: CheckRun = {
    id: id(500), projectId, projectRevisionId: revisionId, geometryRevisionId: first.id,
    artifactRefs: [dxf.id, report.id], status: "completed",
    results: [{ code: "HASH_CLOSURE", outcome: "passed", message: "hash closure passed", sourceRefs: [first.id] }],
    reportAssetId: report.assetId, reportHash: report.sha256, qualification: "generated-not-qualified",
    l1Eligible: false, formalEligibility: false, completedAt: at,
  };
  const evaluation: DeliveryEvaluation = {
    id: id(600), projectId, projectRevisionId: revisionId, geometryRevisionId: first.id,
    artifactRefs: [ifc.id, dxf.id, report.id], checkRunRefs: [check.id], outcome: "proxy-ready",
    blockerCodes: ["PROFESSIONAL_REVIEW_REQUIRED"], formalEligibility: false, evaluatedAt: at,
  };
  const manifest = artifact({ id: id(700), geometryRevisionId: first.id, kind: "deliveryManifest", assetId: id(701), sha256: hash("e"), mimeType: "application/json", byteLength: 40 });
  const draft: DeliveryDraft = {
    id: id(800), projectId, projectRevisionId: revisionId, geometryRevisionId: first.id, evaluationId: evaluation.id,
    artifactRefs: [...evaluation.artifactRefs, manifest.id], manifestAssetId: manifest.assetId, manifestHash: manifest.sha256,
    status: "proxy-unissued", l1Eligible: false, formalEligibility: false, signatureStatus: "unsigned",
    restrictions: ["代理成果，不可正式使用"], createdAt: at,
  };
  return { geometries: [first, second], artifacts: [ifc, dxf, report, other, manifest], check, evaluation, draft, other };
}

describe("delivery chain closure", () => {
  it("accepts one immutable same-geometry delivery chain", () => {
    const graph = validGraph();
    expect(() => assertDeliveryChainClosure({ projectId, geometryRevisions: graph.geometries, artifactRequirementMatrices: [], artifacts: graph.artifacts, checkRuns: [graph.check], deliveryEvaluations: [graph.evaluation], deliveries: [graph.draft] })).not.toThrow();
  });

  it("rejects cross-geometry check artifacts", () => {
    const graph = validGraph();
    const check = { ...graph.check, artifactRefs: [graph.other.id], reportAssetId: graph.other.assetId, reportHash: graph.other.sha256 };
    expect(() => assertDeliveryChainClosure({ projectId, geometryRevisions: graph.geometries, artifactRequirementMatrices: [], artifacts: graph.artifacts, checkRuns: [check], deliveryEvaluations: [], deliveries: [] })).toThrow(/cross-geometry/);
  });

  it("rejects a draft based on a blocked evaluation", () => {
    const graph = validGraph();
    const evaluation = { ...graph.evaluation, outcome: "blocked" as const };
    expect(() => assertDeliveryChainClosure({ projectId, geometryRevisions: graph.geometries, artifactRequirementMatrices: [], artifacts: graph.artifacts, checkRuns: [graph.check], deliveryEvaluations: [evaluation], deliveries: [graph.draft] })).toThrow(/proxy-ready/);
  });

  it("rejects missing artifact references", () => {
    const graph = validGraph();
    const evaluation = { ...graph.evaluation, artifactRefs: [...graph.evaluation.artifactRefs, id(999)] };
    expect(() => assertDeliveryChainClosure({ projectId, geometryRevisions: graph.geometries, artifactRequirementMatrices: [], artifacts: graph.artifacts, checkRuns: [graph.check], deliveryEvaluations: [evaluation], deliveries: [] })).toThrow(/missing/);
  });

  it("rejects replacing the evaluated artifact set in a draft", () => {
    const graph = validGraph();
    const draft = { ...graph.draft, artifactRefs: [graph.evaluation.artifactRefs[0]!, graph.draft.artifactRefs.at(-1)!] };
    expect(() => assertDeliveryChainClosure({ projectId, geometryRevisions: graph.geometries, artifactRequirementMatrices: [], artifacts: graph.artifacts, checkRuns: [graph.check], deliveryEvaluations: [graph.evaluation], deliveries: [draft] })).toThrow(/artifact set differs/);
  });

  it("rejects an artifact whose requirement matrix is missing", () => {
    const graph = validGraph();
    const dxf = { ...graph.artifacts.find((item) => item.kind === "dxf")!, requirementMatrixId: id(998) };
    expect(() => assertDeliveryChainClosure({ projectId, geometryRevisions: graph.geometries, artifactRequirementMatrices: [], artifacts: [dxf], checkRuns: [], deliveryEvaluations: [], deliveries: [] })).toThrow(/requirement matrix/);
  });
});
