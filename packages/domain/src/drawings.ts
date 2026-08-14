import { z } from "zod";

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const RectSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

export const DrawingViewKindSchema = z.enum([
  "floorPlan",
  "roofPlan",
  "elevation",
  "transverseSection",
  "longitudinalSection",
  "axonometric",
  "detail",
]);

export const ArtifactViewRequirementSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1).max(80),
  displayLabelZh: z.string().min(1).max(80),
  drawingRef: z.string().min(1).max(20),
  kind: DrawingViewKindSchema,
  scaleDenominator: z.number().int().positive(),
  sheetId: z.uuid(),
  viewportRectMm: RectSchema,
  direction: Vec3Schema,
  right: Vec3Schema,
  up: Vec3Schema,
  sectionPlane: z.object({ normal: Vec3Schema, offsetMm: z.number() }).optional(),
  sourceTypes: z.array(z.string().min(1)).default([]),
}).strict();

export const ArtifactSheetRequirementSchema = z.object({
  id: z.uuid(),
  drawingNumber: z.string().min(1).max(32),
  displayLabelZh: z.string().min(1).max(80),
  pageMm: z.tuple([z.number().positive(), z.number().positive()]),
  viewIds: z.array(z.uuid()).min(1),
}).strict();

export const ArtifactRequirementMatrixSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.uuid(),
  projectId: z.uuid(),
  projectRevisionId: z.uuid(),
  geometryRevisionId: z.uuid(),
  titleZh: z.string().min(1).max(120),
  buildingDisplayNameZh: z.string().min(1).max(120),
  issueState: z.literal("proxy-unissued"),
  issueDate: z.null(),
  revisionLabel: z.string().min(1).max(16),
  views: z.array(ArtifactViewRequirementSchema).min(1),
  sheets: z.array(ArtifactSheetRequirementSchema).min(1),
  observationCandidates: z.array(z.object({
    id: z.uuid(),
    targetEntityId: z.uuid(),
    displayLabelZh: z.string().min(1).max(160),
    reviewStatus: z.literal("unreviewed"),
    producerType: z.literal("demo"),
  }).strict()).default([]),
  createdAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  const viewIds = new Set(value.views.map((item) => item.id));
  const used = new Set<string>();
  for (const sheet of value.sheets) {
    for (const viewId of sheet.viewIds) {
      if (!viewIds.has(viewId)) context.addIssue({ code: "custom", message: `sheet references unknown view ${viewId}` });
      if (used.has(viewId)) context.addIssue({ code: "custom", message: `view ${viewId} appears on more than one sheet` });
      used.add(viewId);
    }
  }
  if (used.size !== viewIds.size) context.addIssue({ code: "custom", message: "all views must appear on one sheet" });
  for (const view of value.views) {
    if (!value.sheets.some((sheet) => sheet.id === view.sheetId && sheet.viewIds.includes(view.id))) {
      context.addIssue({ code: "custom", message: `view ${view.id} sheet binding differs` });
    }
    if ((view.kind === "transverseSection" || view.kind === "longitudinalSection" || view.kind === "detail") && !view.sectionPlane) {
      context.addIssue({ code: "custom", message: `section view ${view.id} requires a section plane` });
    }
  }
});

export type ArtifactRequirementMatrix = z.infer<typeof ArtifactRequirementMatrixSchema>;
