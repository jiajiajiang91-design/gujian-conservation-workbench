import type { ProjectHead } from "@gujian/application";
import {
  ArtifactRequirementMatrixSchema,
  type ArtifactRequirementMatrix,
  type GeometryRevision,
  type ProjectDrivenGeometrySpec,
} from "@gujian/domain";

function samePlane(left: { normal: readonly number[]; offsetMm: number }, right: { normal: readonly number[]; offsetMm: number }): boolean {
  return left.normal.every((value, index) => Math.abs(value - right.normal[index]!) < 1e-9)
    && Math.abs(left.offsetMm - right.offsetMm) < 1e-6;
}

export function buildArtifactMatrix(head: ProjectHead, geometry: GeometryRevision, spec: ProjectDrivenGeometrySpec): ArtifactRequirementMatrix {
  const task = head.snapshot.taskDefinitions.find((item) => item.confirmedAt !== null);
  if (!task) throw new Error("DRAWING_TASK_NOT_CONFIRMED");
  const requirements = task.artifactRequirements;
  if (!requirements) throw new Error("DRAWING_REQUIREMENTS_STRUCTURED_MISSING");

  const evidenceIds = new Set(head.snapshot.evidences.map((item) => item.id));
  const objectsByStableKey = new Map(spec.objects.map((item) => [item.stableKey, item]));
  const sheetIds = new Map(requirements.sheets.map((sheet) => [sheet.key, crypto.randomUUID()]));

  for (const view of requirements.views) {
    const missingTargets = view.targetStableKeys.filter((key) => !objectsByStableKey.has(key));
    const missingEvidence = view.sourceEvidenceRefs.filter((id) => !evidenceIds.has(id));
    if (missingTargets.length) throw new Error(`DRAWING_TARGET_COMPONENT_MISSING:${view.key}:${missingTargets.join(",")}`);
    if (missingEvidence.length) throw new Error(`DRAWING_SOURCE_EVIDENCE_MISSING:${view.key}:${missingEvidence.join(",")}`);
    if (view.kind === "detail") {
      if (!view.targetStableKeys.length || !view.sourceEvidenceRefs.length || !view.sectionPlane) {
        throw new Error(`DETAIL_LOCAL_EVIDENCE_REQUIRED:${view.key}`);
      }
      const detailPlane = view.sectionPlane;
      const duplicate = requirements.views.some((candidate) => candidate.key !== view.key
        && (candidate.kind === "transverseSection" || candidate.kind === "longitudinalSection")
        && candidate.sectionPlane && detailPlane && samePlane(detailPlane, candidate.sectionPlane)
        && (!candidate.cropBoundsMm || JSON.stringify(candidate.cropBoundsMm) === JSON.stringify(view.cropBoundsMm)));
      if (duplicate) throw new Error(`DETAIL_DUPLICATES_BUILDING_SECTION:${view.key}`);
    }
  }

  const views = requirements.views.map((view) => ({
    id: crypto.randomUUID(),
    key: view.key,
    displayLabelZh: view.displayLabelZh,
    drawingRef: view.drawingRef,
    kind: view.kind,
    scaleDenominator: view.scaleDenominator,
    sheetId: sheetIds.get(view.sheetKey)!,
    viewportRectMm: view.viewportRectMm,
    direction: view.direction,
    right: view.right,
    up: view.up,
    ...(view.sectionPlane ? { sectionPlane: view.sectionPlane } : {}),
    ...(view.cropBoundsMm ? { cropBoundsMm: view.cropBoundsMm } : {}),
    sourceTypes: [...new Set(view.targetStableKeys.map((key) => objectsByStableKey.get(key)!.componentType))],
    sourceEntityIds: view.targetStableKeys.map((key) => objectsByStableKey.get(key)!.id),
    sourceEvidenceRefs: view.sourceEvidenceRefs,
  }));
  const viewByKey = new Map(requirements.views.map((item, index) => [item.key, views[index]!]));
  const sheets = requirements.sheets.map((sheet) => ({
    id: sheetIds.get(sheet.key)!,
    drawingNumber: sheet.drawingNumber,
    displayLabelZh: sheet.displayLabelZh,
    pageMm: sheet.pageMm,
    viewIds: requirements.views.filter((view) => view.sheetKey === sheet.key).map((view) => viewByKey.get(view.key)!.id),
  }));
  if (sheets.some((sheet) => !sheet.viewIds.length)) throw new Error("DRAWING_EMPTY_SHEET_NOT_ALLOWED");

  return ArtifactRequirementMatrixSchema.parse({
    schemaVersion: "1.0",
    id: crypto.randomUUID(),
    projectId: head.projectId,
    projectRevisionId: geometry.projectRevisionId,
    geometryRevisionId: geometry.id,
    titleZh: requirements.titleZh,
    buildingDisplayNameZh: head.snapshot.buildings[0]!.name,
    issueState: "proxy-unissued",
    issueDate: null,
    revisionLabel: requirements.revisionLabel,
    views,
    sheets,
    observationCandidates: [],
    createdAt: new Date().toISOString(),
  });
}
