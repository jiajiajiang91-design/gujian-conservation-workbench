import { z } from "zod";

import { DrawingAnnotationRuleSchema } from "./drawing-annotation-policy.js";
import { DrawingDetailRuleSchema } from "./drawing-detail-policy.js";

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const RectSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);
const CropBoundsSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((value) => value[2] > value[0] && value[3] > value[1], "crop bounds must have positive width and height");

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
  sourceEntityIds: z.array(z.uuid()).default([]),
  sourceEvidenceRefs: z.array(z.string().min(1)).default([]),
  cropBoundsMm: CropBoundsSchema.optional(),
  // 质量基准 4.3 的图面细节层级，按本视图比例解析后随矩阵下发。
  // 制图侧只执行这里的规则，不自己判断比例与构件族的对应关系。
  detailRules: z.array(DrawingDetailRuleSchema).default([]),
  // 本视图必备与可选的标注种类，以及各自的条数上限
  annotationRules: z.array(DrawingAnnotationRuleSchema).default([]),
  // 标注请求：标什么、取自哪个构件、在视图二维坐标里的位置。
  // 由 annotation-planner 从项目事实与几何派生，制图侧只解析成图元。
  annotationPlan: z.object({
    axes: z.array(z.object({
      label: z.string().min(1).max(8),
      along: z.enum(["u", "v"]),
      positionMm: z.number(),
      basisZh: z.string().min(1).max(40),
      sourceEntityIds: z.array(z.uuid()).min(1),
    }).strict()).default([]),
    levels: z.array(z.object({
      label: z.string().min(1).max(20),
      elevationMm: z.number(),
      basisZh: z.string().min(1).max(40),
      sourceEntityIds: z.array(z.uuid()).min(1),
    }).strict()).default([]),
    labels: z.array(z.object({
      text: z.string().min(1).max(80),
      anchorMm: z.tuple([z.number(), z.number()]),
      sourceEntityIds: z.array(z.uuid()).min(1),
    }).strict()).default([]),
    sectionMarks: z.array(z.object({
      label: z.string().min(1).max(80),
      fromMm: z.tuple([z.number(), z.number()]),
      toMm: z.tuple([z.number(), z.number()]),
      targetViewKey: z.string().min(1).max(80),
    }).strict()).default([]),
    // 模型标高与项目已记录尺寸对不上的条目。两个数并列，不由制图侧选一个。
    levelConflicts: z.array(z.object({
      labelZh: z.string().min(1).max(20),
      geometryMm: z.number(),
      documentedMm: z.number(),
      documentedNameZh: z.string().min(1).max(80),
    }).strict()).default([]),
    northAngleDeg: z.number().nullable().default(null),
    // 按上限丢弃的条数，逐种记。丢弃要看得见，不静默截断。
    droppedByKind: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }).strict().default({
    axes: [], levels: [], labels: [], sectionMarks: [], levelConflicts: [],
    northAngleDeg: null, droppedByKind: {},
  }),
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
    if (view.kind === "detail" && !view.cropBoundsMm) {
      context.addIssue({ code: "custom", message: `detail view ${view.id} requires local crop bounds` });
    }
  }
});

export type ArtifactRequirementMatrix = z.infer<typeof ArtifactRequirementMatrixSchema>;
