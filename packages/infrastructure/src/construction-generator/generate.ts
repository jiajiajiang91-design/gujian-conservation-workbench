import { ConstructionAssembly, boxSolid, cylinderSolid } from "./builder.js";
import type { BuildingForm, GenerateInput, GenerateResult, SourcedLength } from "./types.js";

// 按分部装配构件。坐标系与几何管线一致：X 面阔、Y 进深、Z 竖向，
// 原点在台基顶面中心的地面投影，单位毫米。
//
// 每个分部只做布置，尺寸全部来自输入。输入里没有的尺寸不猜，
// 缺哪一项就在该分部记未知项并跳过对应构件。

const AXIS_TOLERANCE_MM = 2;

function sum(values: readonly SourcedLength[]): number {
  return values.reduce((total, item) => total + item.valueMm, 0);
}

// 逐间中心线的 X 坐标，整体以面阔中点为零
function bayCenters(form: BuildingForm): number[] {
  const total = sum(form.bayWidthsMm);
  let cursor = -total / 2;
  return form.bayWidthsMm.map((bay) => {
    const center = cursor + bay.valueMm / 2;
    cursor += bay.valueMm;
    return center;
  });
}

// 柱轴线的 X 坐标：逐间边界，比开间数多一条
function columnAxes(form: BuildingForm): number[] {
  const total = sum(form.bayWidthsMm);
  const axes = [-total / 2];
  let cursor = -total / 2;
  for (const bay of form.bayWidthsMm) {
    cursor += bay.valueMm;
    axes.push(cursor);
  }
  return axes;
}

// 檩位的 Y 坐标与标高：从檐向脊逐架累加，前后对称
function purlinLines(form: BuildingForm): { y: number; z: number; index: number; side: "front" | "back" | "ridge" }[] {
  const halfDepth = sum(form.stepSpansMm);
  const lines: { y: number; z: number; index: number; side: "front" | "back" | "ridge" }[] = [];
  let y = halfDepth;
  let z = form.terraceHeight.valueMm + form.columnBaseHeight.valueMm + form.columnHeight.valueMm
    + form.architraveHeight.valueMm + (form.bracketLayerHeight?.valueMm ?? 0);
  lines.push({ y, z, index: 0, side: "front" });
  form.stepSpansMm.forEach((step, index) => {
    y -= step.valueMm;
    z += form.liftHeightsMm[index]?.valueMm ?? 0;
    lines.push({ y, z, index: index + 1, side: y === 0 ? "ridge" : "front" });
  });
  const mirrored = lines
    .filter((line) => line.y !== 0)
    .map((line) => ({ ...line, y: -line.y, side: "back" as const }));
  return [...lines, ...mirrored].sort((left, right) => right.y - left.y);
}

function buildTerraceAndStairs(assembly: ConstructionAssembly, form: BuildingForm): void {
  const width = sum(form.bayWidthsMm) + form.terraceProjection.valueMm * 2;
  const depth = sum(form.stepSpansMm) * 2 + form.terraceProjection.valueMm * 2;
  assembly.add({
    stableKey: "terrace",
    componentType: "terrace",
    displayNameZh: "台基",
    materialCode: form.materials.terrace,
    solid: boxSolid({ sizeX: width, sizeY: depth, sizeZ: form.terraceHeight.valueMm, center: [0, 0, form.terraceHeight.valueMm / 2] }),
    dimensions: [["width", form.terraceHeight], ["projection", form.terraceProjection]],
  });

  const treadDepth = form.terraceProjection.valueMm / Math.max(1, form.stairTreadCount);
  const riserHeight = form.terraceHeight.valueMm / Math.max(1, form.stairTreadCount);
  for (let index = 0; index < form.stairTreadCount; index += 1) {
    const key = `stair:${index}`;
    const height = riserHeight * (index + 1);
    assembly.add({
      stableKey: key,
      componentType: "step",
      displayNameZh: `踏步第 ${index + 1} 级`,
      materialCode: form.materials.stair,
      solid: boxSolid({
        sizeX: form.stairWidth.valueMm,
        sizeY: treadDepth,
        sizeZ: height,
        center: [0, depth / 2 + treadDepth * (form.stairTreadCount - index - 0.5), height / 2],
      }),
      dimensions: [["treadDepth", form.terraceProjection], ["riserHeight", form.terraceHeight], ["width", form.stairWidth]],
      parentKey: "terrace",
    });
  }
  // 踏步逐级相接，只有最上一级贴台基。逐级都接台基会声明出实际不存在的接触。
  for (let index = 0; index < form.stairTreadCount; index += 1) {
    const isTop = index === form.stairTreadCount - 1;
    assembly.connect({
      fromKey: `stair:${index}`,
      toKey: isTop ? "terrace" : `stair:${index + 1}`,
      interfaceType: "contact",
      fromSurface: "yMin", toSurface: "yMax",
      direction: [0, -1, 0], maximumGapMm: AXIS_TOLERANCE_MM,
    });
  }
}

function buildColumnsAndArchitraves(assembly: ConstructionAssembly, form: BuildingForm): void {
  const axes = columnAxes(form);
  const halfDepth = sum(form.stepSpansMm);
  const rows: { y: number; label: string }[] = [
    { y: halfDepth, label: "前檐" },
    { y: -halfDepth, label: "后檐" },
  ];
  const baseTop = form.terraceHeight.valueMm + form.columnBaseHeight.valueMm;
  const columnTop = baseTop + form.columnHeight.valueMm;

  rows.forEach((row, rowIndex) => {
    axes.forEach((x, columnIndex) => {
      const baseKey = `column-base:${rowIndex}:${columnIndex}`;
      const columnKey = `column:${rowIndex}:${columnIndex}`;
      const baseSize = form.columnSize.valueMm * 1.6;
      assembly.add({
        stableKey: baseKey,
        componentType: "columnBase",
        displayNameZh: `${row.label}柱础 ${columnIndex + 1}`,
        materialCode: form.materials.columnBase,
        solid: boxSolid({
          sizeX: baseSize, sizeY: baseSize, sizeZ: form.columnBaseHeight.valueMm,
          center: [x, row.y, form.terraceHeight.valueMm + form.columnBaseHeight.valueMm / 2],
        }),
        dimensions: [["height", form.columnBaseHeight], ["size", form.columnSize]],
        parentKey: "terrace",
      });
      assembly.add({
        stableKey: columnKey,
        componentType: "column",
        displayNameZh: `${row.label}柱 ${columnIndex + 1}`,
        materialCode: form.materials.column,
        solid: form.columnSection === "round"
          ? cylinderSolid({
            radius: form.columnSize.valueMm / 2, height: form.columnHeight.valueMm, axis: "z",
            center: [x, row.y, baseTop + form.columnHeight.valueMm / 2],
          })
          : boxSolid({
            sizeX: form.columnSize.valueMm, sizeY: form.columnSize.valueMm, sizeZ: form.columnHeight.valueMm,
            center: [x, row.y, baseTop + form.columnHeight.valueMm / 2],
          }),
        dimensions: [["height", form.columnHeight], ["size", form.columnSize]],
      });
      assembly.connect({
        fromKey: baseKey, toKey: "terrace", interfaceType: "bearing",
        fromSurface: "zMin", toSurface: "zMax",
        direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
      });
      assembly.connect({
        fromKey: columnKey, toKey: baseKey, interfaceType: "bearing",
        fromSurface: "zMin", toSurface: "zMax",
        direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
      });
    });

    // 额枋逐间连接相邻两柱
    for (let index = 0; index < axes.length - 1; index += 1) {
      const key = `architrave:${rowIndex}:${index}`;
      const left = axes[index]!;
      const right = axes[index + 1]!;
      assembly.add({
        stableKey: key,
        componentType: "eaveBeam",
        displayNameZh: `${row.label}额枋 ${index + 1}`,
        materialCode: form.materials.architrave,
        solid: boxSolid({
          sizeX: right - left, sizeY: form.architraveThickness.valueMm, sizeZ: form.architraveHeight.valueMm,
          center: [(left + right) / 2, row.y, columnTop + form.architraveHeight.valueMm / 2],
        }),
        dimensions: [["height", form.architraveHeight], ["thickness", form.architraveThickness]],
      });
      assembly.connect({
        fromKey: key, toKey: `column:${rowIndex}:${index}`, interfaceType: "bearing",
        fromSurface: "zMin", toSurface: "zMax",
        direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
      });
    }
  });
}

function buildBrackets(assembly: ConstructionAssembly, form: BuildingForm): void {
  const layer = form.bracketLayerHeight;
  const halfDepth = sum(form.stepSpansMm);
  const architraveTop = form.terraceHeight.valueMm + form.columnBaseHeight.valueMm
    + form.columnHeight.valueMm + form.architraveHeight.valueMm;
  if (!layer) {
    assembly.addUnknown({
      key: "bracket-layer-absent",
      subjectRef: "form:bracket",
      reasonCode: "BRACKET_LAYER_NOT_DECLARED",
      descriptionZh: "形制未声明斗栱层高，本次不生成承托构件。若该建筑实有斗栱，需补测斗栱层高与攒数后重新生成。",
      requiredEvidence: ["斗栱层高实测或形制定级记录", "逐间攒数清点记录"],
      affectedRefs: ["form:bracket"],
    });
    return;
  }
  const centers = bayCenters(form);
  const module = form.modular.moduleMm;
  [{ y: halfDepth, label: "前檐" }, { y: -halfDepth, label: "后檐" }].forEach((row, rowIndex) => {
    centers.forEach((center, bayIndex) => {
      const bayWidth = form.bayWidthsMm[bayIndex]!.valueMm;
      const spacing = bayWidth / (form.bracketSetsPerBay + 1);
      for (let setIndex = 0; setIndex < form.bracketSetsPerBay; setIndex += 1) {
        const x = center - bayWidth / 2 + spacing * (setIndex + 1);
        const prefix = `bracket:${rowIndex}:${bayIndex}:${setIndex}`;
        const seatKey = `${prefix}:seat`;
        const armKey = `${prefix}:arm`;
        const blockKey = `${prefix}:block`;
        const seatHeight = layer.valueMm * 0.4;
        const armHeight = layer.valueMm * 0.35;
        const blockHeight = layer.valueMm - seatHeight - armHeight;
        assembly.add({
          stableKey: seatKey,
          componentType: "bracketSeat",
          displayNameZh: `${row.label}坐斗 ${bayIndex + 1}-${setIndex + 1}`,
          materialCode: form.materials.bracket,
          solid: boxSolid({
            sizeX: module * 3, sizeY: module * 3, sizeZ: seatHeight,
            center: [x, row.y, architraveTop + seatHeight / 2],
          }),
          dimensions: [["layerHeight", layer]],
        });
        assembly.add({
          stableKey: armKey,
          componentType: "bracketArm",
          displayNameZh: `${row.label}栱 ${bayIndex + 1}-${setIndex + 1}`,
          materialCode: form.materials.bracket,
          solid: boxSolid({
            sizeX: module * 6, sizeY: module, sizeZ: armHeight,
            center: [x, row.y, architraveTop + seatHeight + armHeight / 2],
          }),
          dimensions: [["layerHeight", layer]],
          parentKey: seatKey,
        });
        assembly.add({
          stableKey: blockKey,
          componentType: "bearingBlock",
          displayNameZh: `${row.label}散斗 ${bayIndex + 1}-${setIndex + 1}`,
          materialCode: form.materials.bracket,
          solid: boxSolid({
            sizeX: module * 1.5, sizeY: module * 1.5, sizeZ: blockHeight,
            center: [x, row.y, architraveTop + seatHeight + armHeight + blockHeight / 2],
          }),
          dimensions: [["layerHeight", layer]],
          parentKey: armKey,
        });
        assembly.connect({
          fromKey: seatKey, toKey: `architrave:${rowIndex}:${bayIndex}`, interfaceType: "bearing",
          fromSurface: "zMin", toSurface: "zMax",
          direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
        });
        assembly.connect({
          fromKey: armKey, toKey: seatKey, interfaceType: "bearing",
          fromSurface: "zMin", toSurface: "zMax",
          direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
        });
        assembly.connect({
          fromKey: blockKey, toKey: armKey, interfaceType: "bearing",
          fromSurface: "zMin", toSurface: "zMax",
          direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
        });
      }
    });
  });
}

function buildRoofFrame(assembly: ConstructionAssembly, form: BuildingForm): void {
  const width = sum(form.bayWidthsMm) + form.eaveProjection.valueMm * 2;
  const lines = purlinLines(form);
  lines.forEach((line, index) => {
    const key = `purlin:${index}`;
    assembly.add({
      stableKey: key,
      componentType: "purlin",
      displayNameZh: line.y === 0 ? "脊檩" : `${line.y > 0 ? "前" : "后"}檩 ${Math.abs(line.index)}`,
      materialCode: form.materials.purlin,
      solid: cylinderSolid({
        radius: form.purlinDiameter.valueMm / 2, height: width, axis: "x",
        center: [0, line.y, line.z + form.purlinDiameter.valueMm / 2],
      }),
      dimensions: [["diameter", form.purlinDiameter]],
    });
  });

  // 椽逐根跨相邻两檩，前后坡分别铺
  const rafterSpacing = form.rafterSpacing.valueMm;
  const rafterCount = Math.max(1, Math.floor(width / rafterSpacing));
  const sorted = [...lines].sort((left, right) => right.y - left.y);
  for (let segment = 0; segment < sorted.length - 1; segment += 1) {
    const upper = sorted[segment]!;
    const lower = sorted[segment + 1]!;
    const spanY = upper.y - lower.y;
    const spanZ = lower.z - upper.z;
    const length = Math.hypot(spanY, spanZ);
    for (let index = 0; index < rafterCount; index += 1) {
      const x = -width / 2 + rafterSpacing * (index + 0.5);
      assembly.add({
        stableKey: `rafter:${segment}:${index}`,
        componentType: "rafter",
        displayNameZh: `椽 ${segment + 1}-${index + 1}`,
        materialCode: form.materials.rafter,
        solid: boxSolid({
          sizeX: form.rafterDiameter.valueMm, sizeY: Math.abs(spanY), sizeZ: form.rafterDiameter.valueMm,
          center: [x, (upper.y + lower.y) / 2, (upper.z + lower.z) / 2 + form.purlinDiameter.valueMm],
        }),
        dimensions: [["diameter", form.rafterDiameter], ["spacing", form.rafterSpacing]],
      });
      if (length <= 0) continue;
    }
  }
}

function buildRoofSurface(assembly: ConstructionAssembly, form: BuildingForm): void {
  const width = sum(form.bayWidthsMm) + form.eaveProjection.valueMm * 2;
  const lines = [...purlinLines(form)].sort((left, right) => right.y - left.y);
  const courseWidth = form.tileCourseWidth.valueMm;
  const courseCount = Math.max(1, Math.floor(width / courseWidth));

  for (let segment = 0; segment < lines.length - 1; segment += 1) {
    const upper = lines[segment]!;
    const lower = lines[segment + 1]!;
    const centerY = (upper.y + lower.y) / 2;
    const centerZ = (upper.z + lower.z) / 2 + form.purlinDiameter.valueMm + form.rafterDiameter.valueMm;
    const spanY = Math.abs(upper.y - lower.y);
    assembly.add({
      stableKey: `roof-board:${segment}`,
      componentType: "roofBoard",
      displayNameZh: `望板 ${segment + 1}`,
      materialCode: form.materials.roofBoard,
      solid: boxSolid({
        sizeX: width, sizeY: spanY, sizeZ: form.roofBoardThickness.valueMm,
        center: [0, centerY, centerZ + form.roofBoardThickness.valueMm / 2],
      }),
      dimensions: [["thickness", form.roofBoardThickness]],
    });
    for (let course = 0; course < courseCount; course += 1) {
      const x = -width / 2 + courseWidth * (course + 0.5);
      assembly.add({
        stableKey: `pan-tile:${segment}:${course}`,
        componentType: "panTile",
        displayNameZh: `板瓦 ${segment + 1}-${course + 1}`,
        materialCode: form.materials.tile,
        solid: boxSolid({
          sizeX: courseWidth * 0.6, sizeY: spanY, sizeZ: form.tileThickness.valueMm,
          center: [x, centerY, centerZ + form.roofBoardThickness.valueMm + form.tileThickness.valueMm / 2],
        }),
        dimensions: [["courseWidth", form.tileCourseWidth], ["thickness", form.tileThickness]],
        parentKey: `roof-board:${segment}`,
      });
      assembly.add({
        stableKey: `cover-tile:${segment}:${course}`,
        componentType: "coverTile",
        displayNameZh: `筒瓦 ${segment + 1}-${course + 1}`,
        materialCode: form.materials.tile,
        solid: cylinderSolid({
          radius: courseWidth * 0.2, height: spanY, axis: "y",
          center: [x + courseWidth * 0.4, centerY, centerZ + form.roofBoardThickness.valueMm + form.tileThickness.valueMm * 1.5],
        }),
        dimensions: [["courseWidth", form.tileCourseWidth], ["thickness", form.tileThickness]],
        parentKey: `roof-board:${segment}`,
      });
    }
  }

  const ridge = lines.find((line) => line.y === 0);
  if (ridge) {
    assembly.add({
      stableKey: "ridge",
      componentType: "ridgeTile",
      displayNameZh: "正脊",
      materialCode: form.materials.ridge,
      solid: boxSolid({
        sizeX: width, sizeY: courseWidth, sizeZ: form.ridgeHeight.valueMm,
        center: [0, 0, ridge.z + form.purlinDiameter.valueMm + form.rafterDiameter.valueMm + form.ridgeHeight.valueMm / 2],
      }),
      dimensions: [["height", form.ridgeHeight]],
    });
  }
}

function buildEnclosure(assembly: ConstructionAssembly, form: BuildingForm): void {
  const width = sum(form.bayWidthsMm);
  const halfDepth = sum(form.stepSpansMm);
  const wallHeight = form.columnHeight.valueMm;
  const base = form.terraceHeight.valueMm + form.columnBaseHeight.valueMm;
  const thickness = form.columnSize.valueMm;
  const sides: { key: string; open: boolean; label: string; solid: Parameters<typeof boxSolid>[0] }[] = [
    {
      key: "wall:front", open: form.enclosure.front === "open", label: "前檐墙",
      solid: { sizeX: width, sizeY: thickness, sizeZ: wallHeight, center: [0, halfDepth, base + wallHeight / 2] },
    },
    {
      key: "wall:back", open: form.enclosure.back === "open", label: "后檐墙",
      solid: { sizeX: width, sizeY: thickness, sizeZ: wallHeight, center: [0, -halfDepth, base + wallHeight / 2] },
    },
    {
      key: "wall:left", open: form.enclosure.sides === "open", label: "左山墙",
      solid: { sizeX: thickness, sizeY: halfDepth * 2, sizeZ: wallHeight, center: [-width / 2, 0, base + wallHeight / 2] },
    },
    {
      key: "wall:right", open: form.enclosure.sides === "open", label: "右山墙",
      solid: { sizeX: thickness, sizeY: halfDepth * 2, sizeZ: wallHeight, center: [width / 2, 0, base + wallHeight / 2] },
    },
  ];
  for (const side of sides) {
    if (side.open) {
      // 敞廊是形制不是省略，如实记录该面无围护
      assembly.addUnknown({
        key: `${side.key}:open`,
        subjectRef: `form:${side.key}`,
        reasonCode: "ENCLOSURE_DECLARED_OPEN",
        descriptionZh: `${side.label}按形制判断为敞开，未生成围护构件。若实为有墙做法，需补现场照片或实测记录后重新生成。`,
        requiredEvidence: ["该面现状照片", "围护做法实测记录"],
        affectedRefs: [`form:${side.key}`],
      });
      continue;
    }
    assembly.add({
      stableKey: side.key,
      componentType: "wall",
      displayNameZh: side.label,
      materialCode: form.materials.wall,
      solid: boxSolid(side.solid),
      dimensions: [["height", form.columnHeight], ["thickness", form.columnSize]],
    });
  }
}

export function generateConstruction(input: GenerateInput): GenerateResult {
  const { form } = input;
  if (form.bayWidthsMm.length < 1) throw new Error("CONSTRUCTION_BAY_WIDTHS_REQUIRED");
  if (form.stepSpansMm.length !== form.liftHeightsMm.length) {
    throw new Error("CONSTRUCTION_LIFT_STEP_COUNT_MISMATCH");
  }
  const assembly = new ConstructionAssembly({
    keyPrefix: input.keyPrefix,
    producer: input.producer,
    formEvidenceRefs: input.formEvidenceRefs,
  });
  buildTerraceAndStairs(assembly, form);
  buildColumnsAndArchitraves(assembly, form);
  buildBrackets(assembly, form);
  buildRoofFrame(assembly, form);
  buildRoofSurface(assembly, form);
  buildEnclosure(assembly, form);
  return assembly.result();
}
