import { ConstructionAssembly, boxSolid, extrudedProfileSolid } from "../construction-generator/builder.js";
import type { SourcedLength } from "../construction-generator/types.js";
import type {
  CanopyForm, MonitorForm, PlanRect, SourcedDimension,
  TimberFrameForm, TimberFrameGenerateInput, TimberFrameGenerateResult,
} from "./types.js";

// 图纸标注是实测来源；图上量取是人工在图面上按已知标注校准后读出的，
// 精度只到十毫米级，与实测分开标，界面据此如实显示。
function sourced(dimension: SourcedDimension): SourcedLength {
  return {
    valueMm: dimension.valueMm,
    basis: dimension.source === "drawn" ? "measured" : "human",
    factRefs: [...dimension.factRefs],
    evidenceRefs: [...dimension.evidenceRefs],
  };
}

function mm(dimension: SourcedDimension): number {
  return dimension.valueMm;
}

// 屋面斜率由脊高与檐口高反算。图纸没有标注坡度，这是唯一能得出坡度的途径，
// 因此坡度本身也是量取结果，随檐口高一起记未知项。
function roofSlope(form: TimberFrameForm): number {
  return (mm(form.ridgeElevation) - mm(form.eaveElevation)) / (mm(form.width) / 2);
}

function pierRowCount(form: TimberFrameForm): number {
  return Math.max(2, Math.round(mm(form.depth) / mm(form.pierSpacing)) + 1);
}

function buildFoundation(assembly: ConstructionAssembly, form: TimberFrameForm): void {
  const width = mm(form.width);
  const depth = mm(form.depth);
  const girder = mm(form.girderDepth);
  const structure = mm(form.floorStructureDepth);
  const pier = mm(form.pierSize);
  const grade = -mm(form.floorAboveGrade);
  const girderTop = -structure;
  const girderBottom = girderTop - girder;

  // 承台梁按纵向三道：两侧外墙下与中轴。剖面 B-B 只能看出楼板下有通长梁，
  // 具体道数与截面读不出，道数与截面都记未知项。
  const girderXs = [pier / 2, width / 2, width - pier / 2];
  for (const [index, x] of girderXs.entries()) {
    assembly.add({
      stableKey: `foundation/girder-${index + 1}`,
      componentType: "foundationGirder",
      displayNameZh: `承台梁 ${index + 1}`,
      materialCode: form.materials.girder,
      solid: boxSolid({ sizeX: pier, sizeY: depth, sizeZ: girder, center: [x, depth / 2, girderBottom + girder / 2] }),
      dimensions: [["girderDepthMm", sourced(form.girderDepth)], ["girderLengthMm", sourced(form.depth)]],
      unknownKeys: ["foundationLayout"],
    });
  }

  const rows = pierRowCount(form);
  const step = depth / (rows - 1);
  for (let row = 0; row < rows; row += 1) {
    const y = row === 0 ? pier / 2 : row === rows - 1 ? depth - pier / 2 : row * step;
    for (const [index, x] of girderXs.entries()) {
      assembly.add({
        stableKey: `foundation/pier-${row + 1}-${index + 1}`,
        componentType: "foundationPier",
        displayNameZh: `木桩 ${row + 1}-${index + 1}`,
        materialCode: form.materials.pier,
        solid: boxSolid({ sizeX: pier, sizeY: pier, sizeZ: girderBottom - grade, center: [x, y, (girderBottom + grade) / 2] }),
        dimensions: [["pierSizeMm", sourced(form.pierSize)], ["pierHeightMm", sourced(form.floorAboveGrade)]],
        unknownKeys: ["foundationLayout"],
      });
      assembly.connect({
        fromKey: `foundation/pier-${row + 1}-${index + 1}`,
        toKey: `foundation/girder-${index + 1}`,
        interfaceType: "bearing", fromSurface: "zMax", toSurface: "zMin",
        direction: [0, 0, 1], maximumGapMm: 2,
      });
    }
  }
}

function buildFloors(assembly: ConstructionAssembly, form: TimberFrameForm): void {
  const width = mm(form.width);
  const depth = mm(form.depth);
  const structure = mm(form.floorStructureDepth);
  const wall = mm(form.wallThickness);

  assembly.add({
    stableKey: "floor/first",
    componentType: "floorStructure",
    displayNameZh: "首层楼板结构",
    materialCode: form.materials.floorStructure,
    solid: boxSolid({ sizeX: width, sizeY: depth, sizeZ: structure, center: [width / 2, depth / 2, -structure / 2] }),
    dimensions: [
      ["widthMm", sourced(form.width)], ["depthMm", sourced(form.depth)],
      ["structureDepthMm", sourced(form.floorStructureDepth)],
    ],
  });

  // 二层楼板按二层平面上的房间范围分块。标了 OPEN BELOW 的中部不铺板，
  // 挑空边界图上没有画线，按房间隔墙取。
  for (const deck of form.secondFloorDecks) {
    const rect = clampRect(deck, width, depth, wall);
    assembly.add({
      stableKey: `floor/second/${deck.key}`,
      componentType: "floorStructure",
      displayNameZh: deck.displayNameZh,
      materialCode: form.materials.floorStructure,
      solid: boxSolid({
        sizeX: rect.toX - rect.fromX, sizeY: rect.toY - rect.fromY, sizeZ: structure,
        center: [
          (rect.fromX + rect.toX) / 2, (rect.fromY + rect.toY) / 2,
          mm(form.secondFloorElevation) - structure / 2,
        ],
      }),
      dimensions: [
        ["elevationMm", sourced(form.secondFloorElevation)],
        ["structureDepthMm", sourced(form.floorStructureDepth)],
        ...planDimensions(form, rect),
      ],
      unknownKeys: ["secondFloorVoid"],
    });
  }
}

function clampRect(rect: PlanRect, width: number, depth: number, wall: number) {
  return {
    fromX: Math.max(rect.fromXMm, wall), toX: Math.min(rect.toXMm, width - wall),
    fromY: Math.max(rect.fromYMm, wall), toY: Math.min(rect.toYMm, depth - wall),
  };
}

function planDimensions(
  form: TimberFrameForm, rect: { fromX: number; toX: number; fromY: number; toY: number },
): [string, SourcedLength][] {
  const at = (valueMm: number): SourcedLength => ({ ...sourced(form.planScaled), valueMm });
  return [["fromXMm", at(rect.fromX)], ["toXMm", at(rect.toX)], ["fromYMm", at(rect.fromY)], ["toYMm", at(rect.toY)]];
}

// 室内隔墙。位置按平面量取，构造与门窗洞口没有记录，按单层实体建。
function buildPartitions(assembly: ConstructionAssembly, form: TimberFrameForm): void {
  const width = mm(form.width);
  const depth = mm(form.depth);
  const wall = mm(form.wallThickness);
  const secondFloor = mm(form.secondFloorElevation);
  const structure = mm(form.floorStructureDepth);
  for (const partition of form.partitions) {
    const rect = clampRect(partition, width, depth, wall);
    const bottom = partition.level === "first" ? 0 : secondFloor;
    // 二层隔墙顶到屋面底，高度随所在位置的坡面变化，取矩形中点算，
    // 一律取檐口高会矮到不成房间，一律取脊高会穿出屋面。
    const midX = (rect.fromX + rect.toX) / 2;
    const underRoof = mm(form.ridgeElevation) - roofSlope(form) * Math.abs(midX - width / 2);
    const top = partition.level === "first" ? secondFloor - structure : underRoof;
    assembly.add({
      stableKey: `partition/${partition.key}`,
      componentType: "partition",
      displayNameZh: partition.displayNameZh,
      materialCode: form.materials.partition,
      solid: boxSolid({
        sizeX: rect.toX - rect.fromX, sizeY: rect.toY - rect.fromY, sizeZ: top - bottom,
        center: [(rect.fromX + rect.toX) / 2, (rect.fromY + rect.toY) / 2, (bottom + top) / 2],
      }),
      dimensions: [["thicknessMm", sourced(form.partitionThickness)], ...planDimensions(form, rect)],
      unknownKeys: ["partitionAssembly", "openings"],
    });
  }
}

function buildWalls(assembly: ConstructionAssembly, form: TimberFrameForm): void {
  const width = mm(form.width);
  const depth = mm(form.depth);
  const wall = mm(form.wallThickness);
  const eave = mm(form.eaveElevation);
  const ridge = mm(form.ridgeElevation);

  const longWalls = [
    { key: "wall/north", nameZh: "北侧外墙", x: wall / 2 },
    { key: "wall/south", nameZh: "南侧外墙", x: width - wall / 2 },
  ];
  for (const item of longWalls) {
    assembly.add({
      stableKey: item.key,
      componentType: "exteriorWall",
      displayNameZh: item.nameZh,
      materialCode: form.materials.wall,
      solid: boxSolid({ sizeX: wall, sizeY: depth, sizeZ: eave, center: [item.x, depth / 2, eave / 2] }),
      dimensions: [
        ["thicknessMm", sourced(form.wallThickness)], ["lengthMm", sourced(form.depth)],
        ["heightMm", sourced(form.eaveElevation)],
      ],
      unknownKeys: ["wallAssembly", "openings"],
    });
    assembly.connect({
      fromKey: item.key, toKey: "floor/first",
      interfaceType: "bearing", fromSurface: "zMin", toSurface: "zMax",
      direction: [0, 0, -1], maximumGapMm: 2,
    });
  }

  const gableWalls = [
    { key: "wall/west", nameZh: "西侧山墙", originY: wall },
    { key: "wall/east", nameZh: "东侧山墙", originY: depth },
  ];
  for (const item of gableWalls) {
    assembly.add({
      stableKey: item.key,
      componentType: "exteriorWall",
      displayNameZh: item.nameZh,
      materialCode: form.materials.wall,
      solid: boxSolid({
        sizeX: width - 2 * wall, sizeY: wall, sizeZ: eave,
        center: [width / 2, item.originY - wall / 2, eave / 2],
      }),
      dimensions: [
        ["thicknessMm", sourced(form.wallThickness)], ["lengthMm", sourced(form.width)],
        ["heightMm", sourced(form.eaveElevation)],
      ],
      unknownKeys: ["wallAssembly", "openings"],
    });
    // 山尖三角形。挤出面为 XZ，沿 -Y 出料，起点取该端外皮。
    assembly.add({
      stableKey: `${item.key}-gable`,
      componentType: "gableWall",
      displayNameZh: `${item.nameZh}山尖`,
      materialCode: form.materials.gableWall,
      solid: extrudedProfileSolid({
        profileMm: [[wall, eave], [width - wall, eave], [width / 2, ridge]],
        depth: wall, axis: "y", origin: [0, item.originY, 0],
      }),
      dimensions: [["eaveElevationMm", sourced(form.eaveElevation)], ["ridgeElevationMm", sourced(form.ridgeElevation)]],
      parentKey: item.key,
      unknownKeys: ["wallAssembly"],
    });
    assembly.connect({
      fromKey: `${item.key}-gable`, toKey: item.key,
      interfaceType: "bearing", fromSurface: "zMin", toSurface: "zMax",
      direction: [0, 0, -1], maximumGapMm: 2,
    });
  }
}

function buildRoof(assembly: ConstructionAssembly, form: TimberFrameForm): void {
  const width = mm(form.width);
  const depth = mm(form.depth);
  const ridge = mm(form.ridgeElevation);
  const eave = mm(form.eaveElevation);
  const thickness = mm(form.roofThickness);
  const eaveOut = mm(form.eaveOverhang);
  const gableOut = mm(form.gableOverhang);
  const slope = roofSlope(form);
  // 沿坡面法向叠厚度，法向 z 分量取正，构造永远长在坡面之上
  const unit = Math.hypot(1, slope);
  const offsetX = (-slope / unit) * thickness;
  const offsetZ = (1 / unit) * thickness;

  const planes = [
    { key: "roof/north", nameZh: "北坡屋面", eaveX: -eaveOut, sign: 1 },
    { key: "roof/south", nameZh: "南坡屋面", eaveX: width + eaveOut, sign: -1 },
  ];
  for (const plane of planes) {
    const eaveZ = ridge - slope * Math.abs(width / 2 - plane.eaveX);
    const lower: [number, number] = [plane.eaveX, eaveZ];
    const upper: [number, number] = [width / 2, ridge];
    assembly.add({
      stableKey: plane.key,
      componentType: "roofPlane",
      displayNameZh: plane.nameZh,
      materialCode: form.materials.roofPlane,
      solid: extrudedProfileSolid({
        profileMm: [
          lower, upper,
          [upper[0] + offsetX * plane.sign, upper[1] + offsetZ],
          [lower[0] + offsetX * plane.sign, lower[1] + offsetZ],
        ],
        depth: depth + 2 * gableOut, axis: "y", origin: [0, depth + gableOut, 0],
      }),
      dimensions: [
        ["ridgeElevationMm", sourced(form.ridgeElevation)], ["eaveElevationMm", sourced(form.eaveElevation)],
        ["thicknessMm", sourced(form.roofThickness)], ["overhangMm", sourced(form.eaveOverhang)],
      ],
      unknownKeys: ["roofFraming", "roofSlope", "roofSheeting"],
    });
    // 屋面与墙顶不声明接口。斜板没有与墙顶平行的语义面，zMin 取到的是
    // 檐口端面，按面判距离必然超差。斜面搭接由几何检查按面判定，
    // 与既有生成器对长构件多点接触的取舍一致。
  }
}

function buildMonitor(assembly: ConstructionAssembly, form: TimberFrameForm, monitor: MonitorForm): void {
  const width = mm(form.width);
  const ridge = mm(form.ridgeElevation);
  const wall = mm(form.wallThickness);
  const slope = roofSlope(form);
  const fromX = mm(monitor.fromX);
  const toX = mm(monitor.toX);
  const monitorWidth = toX - fromX;
  const centerX = (fromX + toX) / 2;
  const rise = mm(monitor.rise);
  const fromY = mm(monitor.startY);
  const toY = mm(monitor.endY);
  // 下缘取气窗两侧壁处坡面的较低者再下沉一段，保证与屋面交接不留缝；
  // 上缘高出屋脊 rise。气窗不一定骑在屋脊上，位置按平面量取。
  const roofZ = (x: number) => ridge - slope * Math.abs(x - width / 2);
  const base = Math.min(roofZ(fromX), roofZ(toX)) - 150;
  const top = ridge + rise;
  const dimensions: readonly [string, SourcedLength][] = [
    ["fromXMm", sourced(monitor.fromX)], ["toXMm", sourced(monitor.toX)],
    ["riseMm", sourced(monitor.rise)],
    ["startYMm", sourced(monitor.startY)], ["endYMm", sourced(monitor.endY)],
  ];

  const walls = [
    { suffix: "north", sizeX: wall, sizeY: toY - fromY, x: fromX + wall / 2, y: (fromY + toY) / 2 },
    { suffix: "south", sizeX: wall, sizeY: toY - fromY, x: toX - wall / 2, y: (fromY + toY) / 2 },
    { suffix: "west", sizeX: monitorWidth - 2 * wall, sizeY: wall, x: centerX, y: fromY + wall / 2 },
    { suffix: "east", sizeX: monitorWidth - 2 * wall, sizeY: wall, x: centerX, y: toY - wall / 2 },
  ];
  for (const item of walls) {
    assembly.add({
      stableKey: `${monitor.key}/wall-${item.suffix}`,
      componentType: "monitorWall",
      displayNameZh: `采光气窗侧壁`,
      materialCode: form.materials.monitorWall,
      solid: boxSolid({ sizeX: item.sizeX, sizeY: item.sizeY, sizeZ: top - base, center: [item.x, item.y, (base + top) / 2] }),
      dimensions,
      unknownKeys: ["monitorAssembly"],
    });
  }
  assembly.add({
    stableKey: `${monitor.key}/roof`,
    componentType: "monitorRoof",
    displayNameZh: "采光气窗顶",
    materialCode: form.materials.monitorRoof,
    solid: boxSolid({
      sizeX: monitorWidth, sizeY: toY - fromY, sizeZ: mm(form.roofThickness),
      center: [centerX, (fromY + toY) / 2, top + mm(form.roofThickness) / 2],
    }),
    dimensions,
    unknownKeys: ["monitorAssembly"],
  });
  for (const item of walls) {
    assembly.connect({
      fromKey: `${monitor.key}/roof`, toKey: `${monitor.key}/wall-${item.suffix}`,
      interfaceType: "bearing", fromSurface: "zMin", toSurface: "zMax",
      direction: [0, 0, -1], maximumGapMm: 2,
    });
  }
}

function buildCanopy(assembly: ConstructionAssembly, form: TimberFrameForm, canopy: CanopyForm): void {
  const fromX = mm(canopy.fromX);
  const toX = mm(canopy.toX);
  const fromY = mm(canopy.fromY);
  const toY = mm(canopy.toY);
  const elevation = mm(canopy.elevation);
  const thickness = mm(canopy.thickness);
  const dimensions: readonly [string, SourcedLength][] = [
    ["spanXMm", sourced(canopy.toX)], ["spanYMm", sourced(canopy.toY)],
    ["elevationMm", sourced(canopy.elevation)],
  ];

  assembly.add({
    stableKey: `${canopy.key}/deck`,
    componentType: "canopy",
    displayNameZh: canopy.displayNameZh,
    materialCode: form.materials.canopy,
    solid: boxSolid({
      sizeX: toX - fromX, sizeY: toY - fromY, sizeZ: thickness,
      center: [(fromX + toX) / 2, (fromY + toY) / 2, elevation + thickness / 2],
    }),
    dimensions,
    unknownKeys: ["canopyFraming"],
  });

  const post = mm(canopy.postSize);
  for (const [index, x] of canopy.postXs.entries()) {
    const key = `${canopy.key}/post-${index + 1}`;
    assembly.add({
      stableKey: key,
      componentType: "canopyPost",
      displayNameZh: `${canopy.displayNameZh}柱 ${index + 1}`,
      materialCode: form.materials.canopyPost,
      solid: boxSolid({ sizeX: post, sizeY: post, sizeZ: elevation, center: [mm(x), fromY + post / 2, elevation / 2] }),
      dimensions: [["postSizeMm", sourced(canopy.postSize)], ["postHeightMm", sourced(canopy.elevation)]],
      unknownKeys: ["canopyFraming"],
    });
    assembly.connect({
      fromKey: `${canopy.key}/deck`, toKey: key,
      interfaceType: "bearing", fromSurface: "zMin", toSurface: "zMax",
      direction: [0, 0, -1], maximumGapMm: 2,
    });
  }
}

// 图纸读不出的部位。每一条写清缺什么资料才能定，不给默认值。
function registerUnknowns(assembly: ConstructionAssembly, form: TimberFrameForm): void {
  const affected = ["building"];
  const entries: readonly {
    key: string; reasonCode: string; descriptionZh: string; requiredEvidence: readonly string[];
  }[] = [
    {
      key: "foundationLayout",
      reasonCode: "FOUNDATION_LAYOUT_NOT_DOCUMENTED",
      descriptionZh: "木桩与承台梁的道数、间距与截面在 1/4 英寸比例的实测图上量不准，现按剖面 B-B 可见的通长梁与等距桩排布，桩位不代表实际位置。",
      requiredEvidence: ["基础平面图", "现场基础测量记录"],
    },
    {
      key: "wallAssembly",
      reasonCode: "WALL_ASSEMBLY_NOT_DOCUMENTED",
      descriptionZh: "外墙只在图上画出墙线，骨架尺寸、板材厚度与内外饰面分层没有记录，墙体按单层实体建。",
      requiredEvidence: ["墙身构造详图", "现场剖验记录"],
    },
    {
      key: "openings",
      reasonCode: "OPENINGS_NOT_DIMENSIONED",
      descriptionZh: "门窗洞口在平面与立面上有位置，但没有标注尺寸，本模型未开洞。",
      requiredEvidence: ["门窗表", "标注洞口尺寸的立面图"],
    },
    {
      key: "secondFloorVoid",
      reasonCode: "SECOND_FLOOR_VOID_NOT_DIMENSIONED",
      descriptionZh: "二层平面标了 OPEN BELOW 挑空，但挑空边界没有画线也没有标注尺寸，本模型按房间隔墙取边界。楼梯洞口同样未标注，二层楼板未开洞。",
      requiredEvidence: ["标注挑空范围与楼梯洞口的二层平面图"],
    },
    {
      key: "partitionAssembly",
      reasonCode: "PARTITION_ASSEMBLY_NOT_DOCUMENTED",
      descriptionZh: "室内隔墙的位置按平面量取，厚度取平面上两条墙线的间距，骨架与板材没有记录，按单层实体建。楼梯只在平面上有位置，踏步尺寸没有标注，未建模。",
      requiredEvidence: ["隔墙构造详图", "楼梯详图", "现场隔墙测量记录"],
    },
    {
      key: "roofSlope",
      reasonCode: "ROOF_SLOPE_DERIVED_FROM_SCALED_EAVE",
      descriptionZh: `屋面坡度图上没有标注，现按脊高标注 ${form.ridgeElevation.valueMm} mm 与量取的檐口高 ${form.eaveElevation.valueMm} mm 反算，坡度随檐口高的量取误差变化。`,
      requiredEvidence: ["标注坡度或檐口标高的剖面图"],
    },
    {
      key: "roofFraming",
      reasonCode: "ROOF_FRAMING_NOT_DOCUMENTED",
      descriptionZh: "椽、檩、屋架的截面与间距没有记录，屋面按整片构造层建，未表达构架。",
      requiredEvidence: ["屋架详图", "现场屋面构造记录"],
    },
    {
      key: "roofSheeting",
      reasonCode: "ROOF_SHEETING_SPEC_UNKNOWN",
      descriptionZh: "图纸材料表写明屋面为压型金属板，板型、厚度与搭接方式未记录。",
      requiredEvidence: ["屋面板规格记录", "现场取样记录"],
    },
    {
      key: "monitorAssembly",
      reasonCode: "MONITOR_ASSEMBLY_NOT_DOCUMENTED",
      descriptionZh: "采光气窗的平面位置与宽度按图上量取，构造做法与开启方式没有记录。",
      requiredEvidence: ["气窗详图", "现场气窗测量记录"],
    },
    {
      key: "canopyFraming",
      reasonCode: "CANOPY_FRAMING_NOT_DOCUMENTED",
      descriptionZh: "覆盖步道与覆盖巷道的顶棚标高、柱位按图上量取，梁柱截面与连接做法没有记录。",
      requiredEvidence: ["顶棚构造详图", "现场顶棚测量记录"],
    },
  ];
  for (const entry of entries) {
    assembly.addUnknown({
      key: entry.key,
      subjectRef: "building",
      reasonCode: entry.reasonCode,
      descriptionZh: entry.descriptionZh,
      requiredEvidence: entry.requiredEvidence,
      affectedRefs: affected,
    });
  }
}

export function generateTimberFrame(input: TimberFrameGenerateInput): TimberFrameGenerateResult {
  const { form } = input;
  if (mm(form.ridgeElevation) <= mm(form.eaveElevation)) throw new Error("TIMBER_FRAME_RIDGE_NOT_ABOVE_EAVE");
  if (mm(form.secondFloorElevation) >= mm(form.eaveElevation)) throw new Error("TIMBER_FRAME_SECOND_FLOOR_ABOVE_EAVE");

  const assembly = new ConstructionAssembly({
    keyPrefix: input.keyPrefix,
    producer: input.producer,
    formEvidenceRefs: input.evidenceRefs,
  });
  registerUnknowns(assembly, form);
  buildFoundation(assembly, form);
  buildFloors(assembly, form);
  buildWalls(assembly, form);
  buildPartitions(assembly, form);
  buildRoof(assembly, form);
  for (const monitor of form.monitors) buildMonitor(assembly, form, monitor);
  for (const canopy of form.canopies) buildCanopy(assembly, form, canopy);
  return assembly.result();
}
