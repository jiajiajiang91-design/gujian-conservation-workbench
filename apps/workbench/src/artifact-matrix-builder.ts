import type { ProjectHead } from "@gujian/application";
import { ArtifactRequirementMatrixSchema, type ArtifactRequirementMatrix, type GeometryRevision, type ProjectDrivenGeometrySpec } from "@gujian/domain";

interface ViewDefinition {
  token: string; key: string; label: string; ref: string;
  kind: "floorPlan" | "roofPlan" | "elevation" | "transverseSection" | "longitudinalSection" | "axonometric" | "detail";
  direction: readonly [number, number, number]; right: readonly [number, number, number]; up: readonly [number, number, number];
  section?: "x" | "y" | "z";
}

const definitions: readonly ViewDefinition[] = [
  { token: "平面", key: "floor-plan", label: "平面图", ref: "平-01", kind: "floorPlan" as const, direction: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], section: "z" },
  { token: "屋顶", key: "roof-plan", label: "屋顶平面图", ref: "屋-01", kind: "roofPlan" as const, direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
  { token: "立面", key: "south-elevation", label: "南立面图", ref: "立-01", kind: "elevation" as const, direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { token: "横剖", key: "transverse-section", label: "横剖面图", ref: "剖-01", kind: "transverseSection" as const, direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], section: "x" },
  { token: "纵剖", key: "longitudinal-section", label: "纵剖面图", ref: "剖-02", kind: "longitudinalSection" as const, direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], section: "y" },
  { token: "轴测", key: "axonometric", label: "轴测图", ref: "轴-01", kind: "axonometric" as const, direction: [-0.5773502692, -0.5773502692, -0.5773502692], right: [0.7071067812, -0.7071067812, 0], up: [-0.4082482905, -0.4082482905, 0.8164965809] },
  { token: "详图", key: "eave-section-detail", label: "屋面与墙体界面详图", ref: "详-01", kind: "detail" as const, direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], section: "x" },
];

function requested(taskText: string, token: string): boolean {
  return taskText.includes(token);
}

export function buildArtifactMatrix(head: ProjectHead, geometry: GeometryRevision, spec: ProjectDrivenGeometrySpec): ArtifactRequirementMatrix {
  const task = head.snapshot.taskDefinitions.find((item) => item.confirmedAt !== null);
  if (!task) throw new Error("DRAWING_TASK_NOT_CONFIRMED");
  const taskText = [...task.deliverables, ...task.scope].join("|");
  const selected = definitions.filter((item) => requested(taskText, item.token));
  if (!selected.length) throw new Error("DRAWING_REQUIREMENTS_MISSING");
  const sheetIds = Array.from({ length: Math.ceil(selected.length / 4) }, () => crypto.randomUUID());
  const rects = [[20, 330, 380, 220], [430, 330, 380, 220], [20, 70, 380, 220], [430, 70, 380, 220]] as const;
  const views = selected.map((item, index) => {
    const sheetIndex = Math.floor(index / 4);
    const base = spec.objects.find((object) => object.stableKey === "base")?.solid;
    const sectionPlane = item.section === "z" ? { normal: [0, 0, 1] as [number, number, number], offsetMm: Math.max(100, Number(base?.kind === "box" ? base.sizeZ : 500)) }
      : item.section === "x" ? { normal: [1, 0, 0] as [number, number, number], offsetMm: 0 }
        : item.section === "y" ? { normal: [0, 1, 0] as [number, number, number], offsetMm: 0 } : undefined;
    return {
      id: crypto.randomUUID(), key: item.key, displayLabelZh: item.label, drawingRef: item.ref, kind: item.kind,
      scaleDenominator: 100, sheetId: sheetIds[sheetIndex]!, viewportRectMm: [...rects[index % 4]!] as [number, number, number, number],
      direction: [...item.direction] as [number, number, number], right: [...item.right] as [number, number, number], up: [...item.up] as [number, number, number],
      ...(sectionPlane ? { sectionPlane } : {}), sourceTypes: [],
    };
  });
  const sheets = sheetIds.map((id, index) => ({
    id, drawingNumber: `P-${String(index + 1).padStart(2, "0")}`,
    displayLabelZh: index === 0 ? "平立剖与屋顶" : "剖面、轴测与节点",
    pageMm: [841, 594] as [number, number], viewIds: views.filter((view) => view.sheetId === id).map((view) => view.id),
  }));
  return ArtifactRequirementMatrixSchema.parse({
    schemaVersion: "1.0", id: crypto.randomUUID(), projectId: head.projectId,
    projectRevisionId: geometry.projectRevisionId, geometryRevisionId: geometry.id,
    titleZh: `${head.snapshot.buildings[0]!.name}代理成果图`, buildingDisplayNameZh: head.snapshot.buildings[0]!.name,
    issueState: "proxy-unissued", issueDate: null, revisionLabel: `P${head.snapshot.geometryRevisions.length}`,
    views, sheets, observationCandidates: [], createdAt: new Date().toISOString(),
  });
}
