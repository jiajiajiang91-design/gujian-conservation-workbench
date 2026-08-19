import type { DemoDrawingView, DemoFact, DemoProjectDefinition } from "./definitions.js";

// 团队构造样板的演示定义由已验收的 r2 几何清单现算，不把数值抄进源码。
// 抄一遍等于多一份会漂移的副本，而清单本身就是这批数据的权威。
//
// 08 演示项目定义 4.1 要求实测基准这一格放形制参数表：模数基参、开间进深、
// 举架系数，带具体数值。参数化项目的基准就是这些参数。
// 其中模数基参在 r2 数据里没有任何声明，按产品自身原则记为缺项，不倒推。

export interface T0bManifestEntity {
  readonly key: string;
  readonly componentType: string;
  readonly bounds: readonly [readonly [number, number, number], readonly [number, number, number]];
}

export interface T0bManifest {
  readonly entities: readonly T0bManifestEntity[];
  readonly dimensionFacts?: readonly { readonly stableKey: string; readonly value: number; readonly unit: string; readonly factBasis?: string }[];
}

const RIGHTS = "团队自建的参数化古建局部构造样板，成果与源数据均归本项目团队所有。";

const center = (entity: T0bManifestEntity, axis: 0 | 1 | 2) =>
  (entity.bounds[0][axis] + entity.bounds[1][axis]) / 2;

const round1 = (value: number) => Math.round(value * 10) / 10;

function distinctSorted(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value)))].sort((left, right) => left - right);
}

// 柱网由柱心坐标算出，不另取来源
function columnGrid(manifest: T0bManifest): { widthMm: number; depthMm: number; xs: number[]; ys: number[] } {
  const columns = manifest.entities.filter((entity) => entity.componentType === "column");
  if (!columns.length) throw new Error("T0B_MANIFEST_NO_COLUMN");
  const xs = distinctSorted(columns.map((entity) => center(entity, 0)));
  const ys = distinctSorted(columns.map((entity) => center(entity, 1)));
  return { widthMm: xs[xs.length - 1]! - xs[0]!, depthMm: ys[ys.length - 1]! - ys[0]!, xs, ys };
}

// 举架系数由檩位算出：相邻两檩的高差除以水平距离。
// 这是从已验收几何反算出来的实际系数，不是照抄某本书的推荐值。
export function liftRatiosFromPurlins(manifest: T0bManifest): { spanMm: number; riseMm: number; ratio: number }[] {
  const purlins = manifest.entities
    .filter((entity) => entity.componentType === "purlin")
    .map((entity) => ({ y: center(entity, 1), z: center(entity, 2) }))
    .filter((item) => item.y <= 0.5)
    .sort((left, right) => left.y - right.y);
  if (purlins.length < 2) throw new Error("T0B_MANIFEST_PURLIN_TOO_FEW");
  const steps: { spanMm: number; riseMm: number; ratio: number }[] = [];
  for (let index = 0; index < purlins.length - 1; index += 1) {
    const lower = purlins[index]!;
    const upper = purlins[index + 1]!;
    const spanMm = round1(upper.y - lower.y);
    const riseMm = round1(upper.z - lower.z);
    if (spanMm <= 0) continue;
    steps.push({ spanMm, riseMm, ratio: Math.round((riseMm / spanMm) * 1000) / 1000 });
  }
  return steps;
}

function facts(manifest: T0bManifest): DemoFact[] {
  const grid = columnGrid(manifest);
  const lifts = liftRatiosFromPurlins(manifest);
  const evidenceKeys = ["geometry-manifest"];
  const fact = (key: string, field: string, value: unknown): DemoFact => ({
    key, subject: "building", field, value, evidenceKeys,
    reviewStatus: "unreviewed", dataStatus: "available",
  });

  const dimensionFacts = (manifest.dimensionFacts ?? []).map((item) => fact(
    `component-dimension-${item.stableKey.toLowerCase()}`,
    item.stableKey,
    `${round1(item.value)} ${item.unit}`,
  ));

  return [
    fact("module-base", "moduleBaseZh", "源数据未声明斗口或材份，模数基参缺项"),
    fact("bay-width", "bayWidthMm", grid.widthMm),
    fact("bay-depth", "bayDepthMm", grid.depthMm),
    fact("column-axes-x", "columnAxesXMm", grid.xs.join("、")),
    fact("column-axes-y", "columnAxesYMm", grid.ys.join("、")),
    fact("purlin-count", "purlinCount", manifest.entities.filter((entity) => entity.componentType === "purlin").length),
    ...lifts.map((step, index) => fact(
      `lift-ratio-${index + 1}`,
      `liftRatio${index + 1}`,
      `${step.ratio}（步架 ${step.spanMm} mm，举高 ${step.riseMm} mm）`,
    )),
    ...dimensionFacts,
  ];
}

// 成果要求沿用已验收成果本来的图种与版面，视口按实测图面尺寸配。
//
// 三条约束同时满足：印刷区（contracts.py 要求 x 不小于 10、y 不小于 20，
// 右边距 10、上边距 35）；图面装得下（宽留 8 mm、高留 12 mm）；
// 标注避开图签（图签占页面右下 221 × 30 mm，尺寸线与图名放在图形正下方）。
//
// 实测图面：底层与屋顶平面 168 × 145.2、南立面 168 × 159.5（均 1:50），
// 轴测 110.3 × 103.6（1:100），横剖 96.8 × 95.7、纵剖 112 × 95.7（均 1:75），
// 承托详图 195 × 92（1:20）。
function views(): DemoDrawingView[] {
  return [
    {
      key: "floor", displayLabelZh: "底层平面图", drawingRef: "D-01-1", kind: "floorPlan",
      scaleDenominator: 50, sheetKey: "sheet-a2",
      viewportRectMm: [15, 215, 275, 165], direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
      // 平面图是水平剖切，不是俯视投影。没有剖切面时画出来的是屋顶，
      // 与同一张图上的屋顶平面完全一样，等于少一张图。
      // 剖切标高取台明顶面（600）之上 1200 mm，按建筑制图惯例。
      sectionPlane: { normal: [0, 0, 1], offsetMm: 1800 },
      sourceEvidenceKeys: ["geometry-manifest"],
    },
    {
      key: "roof", displayLabelZh: "屋顶平面图", drawingRef: "D-01-2", kind: "roofPlan",
      scaleDenominator: 50, sheetKey: "sheet-a2",
      viewportRectMm: [305, 215, 275, 165], direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
      sourceEvidenceKeys: ["geometry-manifest"],
    },
    {
      key: "south", displayLabelZh: "南立面图", drawingRef: "D-01-3", kind: "elevation",
      scaleDenominator: 50, sheetKey: "sheet-a2",
      viewportRectMm: [15, 40, 275, 175], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1],
      sourceEvidenceKeys: ["geometry-manifest"],
    },
    {
      key: "axon", displayLabelZh: "轴测图", drawingRef: "D-01-4", kind: "axonometric",
      scaleDenominator: 100, sheetKey: "sheet-a2",
      viewportRectMm: [305, 40, 275, 175],
      direction: [0.5773502691896258, 0.5773502691896258, -0.5773502691896258],
      right: [0.7071067811865476, -0.7071067811865476, 0],
      up: [0.4082482904638631, 0.4082482904638631, 0.8164965809277261],
      sourceEvidenceKeys: ["geometry-manifest"],
    },
    {
      key: "transverse", displayLabelZh: "横剖面图", drawingRef: "D-02-1", kind: "transverseSection",
      scaleDenominator: 75, sheetKey: "sheet-a3",
      viewportRectMm: [15, 140, 190, 122], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1],
      // 剖切面落在柱缝上（柱心 x = 正负 2400）。切在两缝之间只能切到檩与瓦，
      // 柱、斗栱、瓜柱一根都切不到，质量基准 3.5 要的一榀构造链就断了。
      sectionPlane: { normal: [1, 0, 0], offsetMm: -2400 },
      sourceEvidenceKeys: ["geometry-manifest"],
    },
    {
      key: "longitudinal", displayLabelZh: "纵剖面图", drawingRef: "D-02-2", kind: "longitudinalSection",
      scaleDenominator: 75, sheetKey: "sheet-a3",
      viewportRectMm: [215, 140, 190, 122], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1],
      // 纵向的缝在 y = 0（tieBeam 与中间瓜柱所在），保持原位
      sectionPlane: { normal: [0, 1, 0], offsetMm: 0 },
      sourceEvidenceKeys: ["geometry-manifest"],
    },
    {
      key: "support-detail", displayLabelZh: "檐下承托组合详图", drawingRef: "D-02-3", kind: "detail",
      scaleDenominator: 20, sheetKey: "sheet-a3",
      viewportRectMm: [15, 40, 390, 94], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1],
      // 详图取另一条柱缝，与横剖面不同面，否则成果矩阵按重复详图拒收。
      sectionPlane: { normal: [1, 0, 0], offsetMm: 2400 },
      // 裁剪框是 [uMin, vMin, uMax, vMax]，u 沿 right、v 沿 up，与 shapely 的
      // box 参数序一致。这里截前后两处檐下承托，标高 3600 到 5200。
      cropBoundsMm: [-2700, 3600, 2700, 5200],
      targetComponentTypes: ["column", "columnBase", "bracketSeat", "bracketArm", "bearingBlock", "purlin", "eaveBeam"],
      targetPerTypeLimit: 4,
      sourceEvidenceKeys: ["geometry-manifest"],
    },
  ];
}

export function buildT0bDefinition(manifest: T0bManifest): DemoProjectDefinition {
  const grid = columnGrid(manifest);
  const lifts = liftRatiosFromPurlins(manifest);
  return {
    demoId: "t0b-construction-sample",
    projectName: "团队构造样板演示",
    buildingName: "古建局部构造样板",
    locationText: null,
    periodText: null,
    addressText: null,
    createdAt: "2026-08-19T00:00:00Z",
    limitationZh: "参数化构造样板，不是任何一座真实建筑的实测结果，尺寸不得用于修缮设计。",
    sources: [
      {
        key: "geometry-manifest",
        filePath: "文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v3-outputs/r2-geometry/geometry-manifest.json",
        fileName: "geometry-manifest.json",
        mimeType: "application/json",
        evidenceType: "measurementRecord",
        title: "构造样板几何清单：逐构件类型、尺寸、材料与接口",
        rightsDeclaration: RIGHTS,
        intendedUse: "构件清单、三维模型与图纸的唯一几何来源",
        recordedAt: null,
        parser: "json-structured",
        parseStatus: "parsed",
        extractedText: null,
        parseWarnings: [],
      },
      {
        key: "source-meshes",
        filePath: "文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v3-outputs/r2-geometry/source-meshes.ndjson.gz",
        fileName: "source-meshes.ndjson.gz",
        mimeType: "application/gzip",
        evidenceType: "other",
        title: "构造样板逐构件源网格",
        rightsDeclaration: RIGHTS,
        intendedUse: "构件翻译的形状输入。缺它每个构件退化成轴对齐包围盒",
        recordedAt: null,
        parser: "ndjson-mesh",
        parseStatus: "parsed",
        extractedText: null,
        parseWarnings: [],
      },
    ],
    facts: facts(manifest),
    measurements: [],
    issues: [
      {
        key: "module-base-undeclared",
        issueType: "missingEvidence",
        descriptionZh: "源数据没有声明斗口或材份，模数基参无从核对。举架系数与开间进深由几何反算得到，可复核；模数基参不倒推，保持缺项。",
        impactEvidenceKeys: ["geometry-manifest"],
        blocksProxyOutcome: false,
      },
      {
        key: "not-a-real-building",
        issueType: "professionalUncertainty",
        descriptionZh: "本样板是团队自建的参数化构造，不对应任何一座真实建筑，构造做法未经现场核实。它证明成果链路的构造深度，不能作为形制依据引用。",
        impactEvidenceKeys: ["geometry-manifest"],
        blocksProxyOutcome: false,
      },
    ],
    task: {
      name: "古建局部构造样板制作",
      scope: ["逐构件核对构造关系", "按成果目录生成成组图纸"],
      regulationRefs: ["成果须注明来源；未经责任人员签发不得作为正式测绘成果使用"],
      deliverables: [
        `平面与立面 1:50、剖面 1:75、承托组合详图 1:20`,
        `柱网 ${grid.widthMm} × ${grid.depthMm} mm，${lifts.length} 档举架`,
        "三维模型（IFC 与 GLB）、成组图纸（DXF、SVG、PDF）、检查报告",
      ],
      confirmed: true,
      artifactRequirements: {
        titleZh: "古建局部构造样板成组图纸",
        revisionLabel: "D1",
        geometryTargetRoles: ["column", "roofBoard", "panTile"],
        sheets: [
          { key: "sheet-a2", drawingNumber: "D-01", displayLabelZh: "总体与立面", pageMm: [594, 420] },
          { key: "sheet-a3", drawingNumber: "D-02", displayLabelZh: "剖面与承托组合", pageMm: [420, 297] },
        ],
        views: views(),
      },
    },
  };
}

// 详图的构件集：按构件类型在清单里取前若干个，构建时解析成稳定键。
export function resolveViewTargets(manifest: T0bManifest, view: DemoDrawingView): string[] {
  if (!view.targetComponentTypes?.length) return [];
  const limit = view.targetPerTypeLimit ?? 4;
  const byType = new Map<string, string[]>();
  for (const entity of manifest.entities) {
    byType.set(entity.componentType, [...(byType.get(entity.componentType) ?? []), entity.key]);
  }
  return view.targetComponentTypes.flatMap((type) => (byType.get(type) ?? []).slice(0, limit));
}
