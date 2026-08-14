import type {
  ArtifactRecord,
  ArtifactRequirementMatrix,
  CheckRun,
  DeliveryDraft,
  DeliveryEvaluation,
  GeometryRevision,
} from "@gujian/domain";

import { CommandError } from "./errors.js";

export interface DeliveryChainClosure {
  readonly projectId: string;
  readonly geometryRevisions: readonly GeometryRevision[];
  readonly artifactRequirementMatrices: readonly ArtifactRequirementMatrix[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly checkRuns: readonly CheckRun[];
  readonly deliveryEvaluations: readonly DeliveryEvaluation[];
  readonly deliveries: readonly DeliveryDraft[];
}

const GEOMETRY_ARTIFACT_KINDS = new Set<ArtifactRecord["kind"]>([
  "ifc",
  "glb",
  "brepBundle",
  "geometryManifest",
  "geometrySourceMap",
  "geometryReport",
  "geometryPreview",
]);

function fail(message: string): never {
  throw new CommandError("COMMAND_INVALID", message);
}

function uniqueById<T extends { readonly id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) fail(`${label} contains a duplicate id`);
    result.set(item.id, item);
  }
  return result;
}

function requireUniqueRefs(refs: readonly string[], label: string): void {
  if (new Set(refs).size !== refs.length) fail(`${label} contains duplicate references`);
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((ref) => expected.has(ref));
}

/**
 * Validates the immutable GeometryRevision -> Artifact -> CheckRun ->
 * DeliveryEvaluation -> DeliveryDraft graph. Callers pass the complete affected
 * subgraph, so the same validator protects normal commands and package import.
 */
export function assertDeliveryChainClosure(input: DeliveryChainClosure): void {
  const geometries = uniqueById(input.geometryRevisions, "geometry revisions");
  const matrices = uniqueById(input.artifactRequirementMatrices, "artifact requirement matrices");
  const artifacts = uniqueById(input.artifacts, "artifacts");
  const checks = uniqueById(input.checkRuns, "check runs");
  const evaluations = uniqueById(input.deliveryEvaluations, "delivery evaluations");
  uniqueById(input.deliveries, "delivery drafts");

  for (const geometry of geometries.values()) {
    if (geometry.projectId !== input.projectId) fail("geometry revision belongs to another project");
  }

  for (const matrix of matrices.values()) {
    if (matrix.projectId !== input.projectId) fail("artifact requirement matrix belongs to another project");
    if (!geometries.has(matrix.geometryRevisionId)) fail("artifact requirement matrix references a missing geometry revision");
  }

  for (const artifact of artifacts.values()) {
    if (artifact.projectId !== input.projectId) fail("artifact belongs to another project");
    const geometry = geometries.get(artifact.geometryRevisionId);
    if (!geometry) fail("artifact references a missing geometry revision");
    if (artifact.requirementMatrixId !== null) {
      const matrix = matrices.get(artifact.requirementMatrixId);
      if (!matrix || matrix.geometryRevisionId !== artifact.geometryRevisionId) {
        fail("artifact references a missing or cross-geometry requirement matrix");
      }
    }
    if (GEOMETRY_ARTIFACT_KINDS.has(artifact.kind)) {
      const expectedKind = artifact.kind === "geometryManifest" ? "manifest"
        : artifact.kind === "geometrySourceMap" ? "sourceMap"
          : artifact.kind === "geometryReport" ? "report"
            : artifact.kind === "geometryPreview" ? "preview"
              : artifact.kind;
      const asset = geometry.assets.find((item) => item.kind === expectedKind);
      if (!asset || asset.assetId !== artifact.assetId || asset.sha256 !== artifact.sha256 ||
          asset.mimeType !== artifact.mimeType || asset.byteLength !== artifact.byteLength) {
        fail("geometry artifact does not match its geometry revision asset closure");
      }
    }
  }

  for (const check of checks.values()) {
    if (check.projectId !== input.projectId) fail("check run belongs to another project");
    if (!geometries.has(check.geometryRevisionId)) fail("check run references a missing geometry revision");
    requireUniqueRefs(check.artifactRefs, "check run artifactRefs");
    let reportMatched = false;
    for (const artifactId of check.artifactRefs) {
      const artifact = artifacts.get(artifactId);
      if (!artifact || artifact.geometryRevisionId !== check.geometryRevisionId) {
        fail("check run contains a missing or cross-geometry artifact");
      }
      if (artifact.assetId === check.reportAssetId && artifact.sha256 === check.reportHash) reportMatched = true;
    }
    if (!reportMatched) fail("check run report is outside its artifact closure");
  }

  for (const evaluation of evaluations.values()) {
    if (evaluation.projectId !== input.projectId) fail("delivery evaluation belongs to another project");
    requireUniqueRefs(evaluation.artifactRefs, "delivery evaluation artifactRefs");
    requireUniqueRefs(evaluation.checkRunRefs, "delivery evaluation checkRunRefs");
    if (evaluation.geometryRevisionId === null) {
      if (evaluation.outcome !== "blocked" || evaluation.artifactRefs.length || evaluation.checkRunRefs.length) {
        fail("an evaluation without geometry must be blocked and contain no artifact or check references");
      }
      continue;
    }
    if (!geometries.has(evaluation.geometryRevisionId)) fail("delivery evaluation references a missing geometry revision");
    if (evaluation.outcome === "proxy-ready" && (!evaluation.artifactRefs.length || !evaluation.checkRunRefs.length)) {
      fail("proxy-ready evaluation requires artifacts and checks");
    }
    const checkedArtifactIds = new Set<string>();
    for (const checkId of evaluation.checkRunRefs) {
      const check = checks.get(checkId);
      if (!check || check.geometryRevisionId !== evaluation.geometryRevisionId) {
        fail("delivery evaluation contains a missing or cross-geometry check run");
      }
      for (const artifactId of check.artifactRefs) checkedArtifactIds.add(artifactId);
    }
    for (const artifactId of evaluation.artifactRefs) {
      const artifact = artifacts.get(artifactId);
      if (!artifact || artifact.geometryRevisionId !== evaluation.geometryRevisionId) {
        fail("delivery evaluation contains a missing or cross-geometry artifact");
      }
      if (!GEOMETRY_ARTIFACT_KINDS.has(artifact.kind) && !checkedArtifactIds.has(artifactId)) {
        fail("delivery evaluation contains an unchecked generated artifact");
      }
    }
    for (const artifactId of checkedArtifactIds) {
      if (!evaluation.artifactRefs.includes(artifactId)) fail("delivery evaluation omits an artifact from its check closure");
    }
  }

  for (const draft of input.deliveries) {
    if (draft.projectId !== input.projectId) fail("delivery draft belongs to another project");
    const evaluation = evaluations.get(draft.evaluationId);
    if (!evaluation || evaluation.outcome !== "proxy-ready" || evaluation.geometryRevisionId === null) {
      fail("delivery draft requires a proxy-ready evaluation");
    }
    if (draft.geometryRevisionId !== evaluation.geometryRevisionId) fail("delivery draft and evaluation geometry differ");
    requireUniqueRefs(draft.artifactRefs, "delivery draft artifactRefs");
    const manifestArtifacts = draft.artifactRefs
      .map((artifactId) => artifacts.get(artifactId))
      .filter((artifact): artifact is ArtifactRecord => artifact?.kind === "deliveryManifest");
    if (manifestArtifacts.length !== 1) fail("delivery draft must contain exactly one manifest artifact");
    const manifest = manifestArtifacts[0]!;
    if (manifest.geometryRevisionId !== draft.geometryRevisionId || manifest.assetId !== draft.manifestAssetId ||
        manifest.sha256 !== draft.manifestHash) fail("delivery draft manifest closure is invalid");
    const nonManifestRefs = draft.artifactRefs.filter((artifactId) => artifactId !== manifest.id);
    if (!sameRefs(nonManifestRefs, evaluation.artifactRefs)) fail("delivery draft artifact set differs from its evaluation");
    if (draft.artifactRefs.some((artifactId) => !artifacts.has(artifactId))) fail("delivery draft references a missing artifact");
  }
}
