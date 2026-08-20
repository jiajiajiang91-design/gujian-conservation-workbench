import { ConstructionAssembly, boxSolid, cylinderSolid, slopedBarSolid } from "./builder.js";
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
  // 檐檩坐在最下一层梁背上，梁底落在承托顶（无斗栱时落额枋顶）。
  // 每层同理：檩底等于该层梁背，瓜柱净高就是举高减该层梁高。
  const bottomBeamHeight = form.beamSectionsMm[0]?.height.valueMm ?? 0;
  let z = form.terraceHeight.valueMm + form.columnBaseHeight.valueMm + form.columnHeight.valueMm
    + form.architraveHeight.valueMm + (form.bracketLayerHeight?.valueMm ?? 0) + bottomBeamHeight;
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

// 梁的名称按所承檩数计，用汉字数目，与图纸和构件清单一致。
const SPAN_NUMERALS = ["三", "五", "七", "九", "十一", "十三"];
function beamNameZh(spans: number): string {
  const numeral = SPAN_NUMERALS[(spans - 3) / 2];
  if (!numeral) throw new Error(`BEAM_SPAN_UNSUPPORTED:${spans}`);
  return `${numeral}架梁`;
}

// 单坡檩位，自檐向脊。梁架逐层跨在对称的一对檩位之间。
function slopePurlins(form: BuildingForm): { y: number; z: number }[] {
  return purlinLines(form).filter((line) => line.y >= 0).sort((left, right) => right.y - left.y);
}

// 梁架：逐缝自下而上，第 i 层梁跨在 ±y[i] 两檩之间，梁背承檩，
// 层与层之间由瓜柱支起，最上一层由脊瓜柱承脊檩。
// 层数等于单坡步架数，三步架依次是七架梁、五架梁、三架梁。
function buildBeamFrame(assembly: ConstructionAssembly, form: BuildingForm): void {
  const slope = slopePurlins(form);
  const tiers = slope.length - 1;
  if (form.beamSectionsMm.length !== tiers) {
    throw new Error(`BEAM_TIER_COUNT_MISMATCH:${form.beamSectionsMm.length}:${tiers}`);
  }
  const axes = columnAxes(form);
  // 梁落在柱头科上；无斗栱做法直接落在柱头。
  const seatKey = (axisIndex: number, side: "front" | "back") => {
    const rowIndex = side === "front" ? 0 : 1;
    return form.bracketLayerHeight
      ? `bracket-column:${rowIndex}:${axisIndex}:block`
      : `architrave:${rowIndex}:${Math.min(axisIndex, form.bayWidthsMm.length - 1)}`;
  };

  axes.forEach((x, axisIndex) => {
    for (let tier = 0; tier < tiers; tier += 1) {
      const line = slope[tier]!;
      const section = form.beamSectionsMm[tier]!;
      const beamKey = `beam:${axisIndex}:${tier}`;
      const spans = 2 * (tiers - tier) + 1;
      assembly.add({
        stableKey: beamKey,
        componentType: "beam",
        displayNameZh: `${beamNameZh(spans)} ${axisIndex + 1}`,
        materialCode: form.materials.beam,
        solid: boxSolid({
          sizeX: section.width.valueMm,
          sizeY: line.y * 2 + section.width.valueMm,
          sizeZ: section.height.valueMm,
          center: [x, 0, line.z - section.height.valueMm / 2],
        }),
        dimensions: [["width", section.width], ["height", section.height]],
      });

      if (tier === 0) {
        // 最下一层梁底正好落在承托顶或额枋顶，两侧檐柱轴线各连一处
        for (const side of ["front", "back"] as const) {
          const support = seatKey(axisIndex, side);
          if (assembly.has(support)) {
            assembly.connect({
              fromKey: beamKey, toKey: support, interfaceType: "bearing",
              fromSurface: "zMin", toSurface: "zMax", direction: [0, 0, -1], maximumGapMm: 2,
            });
          }
        }
        continue;
      }

      // 下层梁背到本层梁底之间由瓜柱支起
      const below = slope[tier - 1]!;
      const postHeight = line.z - section.height.valueMm - below.z;
      if (postHeight <= 0) {
        throw new Error(`BEAM_TIER_CLEARANCE_INSUFFICIENT:${tier}:${Math.round(postHeight)}`);
      }
      for (const side of [1, -1]) {
        const postKey = `king-post:${axisIndex}:${tier}:${side > 0 ? "front" : "back"}`;
        assembly.add({
          stableKey: postKey,
          componentType: "kingPost",
          displayNameZh: `${side > 0 ? "前" : "后"}瓜柱 ${axisIndex + 1}-${tier}`,
          materialCode: form.materials.kingPost,
          solid: boxSolid({
            sizeX: section.width.valueMm, sizeY: section.width.valueMm, sizeZ: postHeight,
            center: [x, line.y * side, below.z + postHeight / 2],
          }),
          dimensions: [["width", section.width]],
        });
        assembly.connect({
          fromKey: postKey, toKey: `beam:${axisIndex}:${tier - 1}`, interfaceType: "bearing",
          fromSurface: "zMin", toSurface: "zMax", direction: [0, 0, -1], maximumGapMm: 2,
        });
        assembly.connect({
          fromKey: beamKey, toKey: postKey, interfaceType: "bearing",
          fromSurface: "zMin", toSurface: "zMax", direction: [0, 0, -1], maximumGapMm: 2,
        });
      }
    }

    // 脊瓜柱立在最上一层梁背上承脊檩
    const top = slope[tiers - 1]!;
    const ridge = slope[tiers]!;
    const topSection = form.beamSectionsMm[tiers - 1]!;
    const ridgePostHeight = ridge.z - top.z;
    if (ridgePostHeight <= 0) throw new Error(`RIDGE_POST_CLEARANCE_INSUFFICIENT:${Math.round(ridgePostHeight)}`);
    const ridgePostKey = `king-post:${axisIndex}:ridge`;
    assembly.add({
      stableKey: ridgePostKey,
      componentType: "kingPost",
      displayNameZh: `脊瓜柱 ${axisIndex + 1}`,
      materialCode: form.materials.kingPost,
      solid: boxSolid({
        sizeX: topSection.width.valueMm, sizeY: topSection.width.valueMm, sizeZ: ridgePostHeight,
        center: [x, 0, top.z + ridgePostHeight / 2],
      }),
      dimensions: [["width", topSection.width]],
    });
    assembly.connect({
      fromKey: ridgePostKey, toKey: `beam:${axisIndex}:${tiers - 1}`, interfaceType: "bearing",
      fromSurface: "zMin", toSurface: "zMax", direction: [0, 0, -1], maximumGapMm: 2,
    });
  });
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

  // 柱头科：立在柱轴线上，梁架落在它上面。缺了它梁就没有落脚点。
  // 平身科在下面按逐间攒数排布，两者构造相同，位置与承载对象不同。
  const rows = [{ y: halfDepth, label: "前檐" }, { y: -halfDepth, label: "后檐" }];
  const seatHeightOf = layer.valueMm * 0.4;
  const armHeightOf = layer.valueMm * 0.35;
  const blockHeightOf = layer.valueMm - seatHeightOf - armHeightOf;
  rows.forEach((row, rowIndex) => {
    columnAxes(form).forEach((x, axisIndex) => {
      const prefix = `bracket-column:${rowIndex}:${axisIndex}`;
      assembly.add({
        stableKey: `${prefix}:seat`,
        componentType: "bracketSeat",
        displayNameZh: `${row.label}柱头科坐斗 ${axisIndex + 1}`,
        materialCode: form.materials.bracket,
        solid: boxSolid({
          sizeX: module * 3, sizeY: module * 3, sizeZ: seatHeightOf,
          center: [x, row.y, architraveTop + seatHeightOf / 2],
        }),
        dimensions: [["layerHeight", layer]],
      });
      assembly.add({
        stableKey: `${prefix}:arm`,
        componentType: "bracketArm",
        displayNameZh: `${row.label}柱头科栱 ${axisIndex + 1}`,
        materialCode: form.materials.bracket,
        solid: boxSolid({
          sizeX: module * 6, sizeY: module, sizeZ: armHeightOf,
          center: [x, row.y, architraveTop + seatHeightOf + armHeightOf / 2],
        }),
        dimensions: [["layerHeight", layer]],
        parentKey: `${prefix}:seat`,
      });
      assembly.add({
        stableKey: `${prefix}:block`,
        componentType: "bearingBlock",
        displayNameZh: `${row.label}柱头科散斗 ${axisIndex + 1}`,
        materialCode: form.materials.bracket,
        solid: boxSolid({
          sizeX: module * 1.5, sizeY: module * 1.5, sizeZ: blockHeightOf,
          center: [x, row.y, architraveTop + seatHeightOf + armHeightOf + blockHeightOf / 2],
        }),
        dimensions: [["layerHeight", layer]],
        parentKey: `${prefix}:arm`,
      });
      // 坐斗压在额枋上，不是直接落柱头。端头轴线取相邻那一间的额枋。
      const bay = Math.min(axisIndex, form.bayWidthsMm.length - 1);
      assembly.connect({
        fromKey: `${prefix}:seat`, toKey: `architrave:${rowIndex}:${bay}`, interfaceType: "bearing",
        fromSurface: "zMin", toSurface: "zMax", direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
      });
      assembly.connect({
        fromKey: `${prefix}:arm`, toKey: `${prefix}:seat`, interfaceType: "bearing",
        fromSurface: "zMin", toSurface: "zMax", direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
      });
      assembly.connect({
        fromKey: `${prefix}:block`, toKey: `${prefix}:arm`, interfaceType: "bearing",
        fromSurface: "zMin", toSurface: "zMax", direction: [0, 0, -1], maximumGapMm: AXIS_TOLERANCE_MM,
      });
    });
  });

  rows.forEach((row, rowIndex) => {
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

  // 椽逐根斜跨相邻两檩，搭在檩背上。前后坡对称，逐步架分段。
  const rafterSpacing = form.rafterSpacing.valueMm;
  const rafterCount = Math.max(1, Math.floor(width / rafterSpacing));
  const sorted = [...lines].sort((left, right) => right.y - left.y);
  const purlinTop = (line: { z: number }) => line.z + form.purlinDiameter.valueMm;
  for (let segment = 0; segment < sorted.length - 1; segment += 1) {
    const upper = sorted[segment]!;
    const lower = sorted[segment + 1]!;
    for (let index = 0; index < rafterCount; index += 1) {
      const x = -width / 2 + rafterSpacing * (index + 0.5);
      assembly.add({
        stableKey: `rafter:${segment}:${index}`,
        componentType: "rafter",
        displayNameZh: `椽 ${segment + 1}-${index + 1}`,
        materialCode: form.materials.rafter,
        solid: slopedBarSolid({
          fromY: upper.y, fromZ: purlinTop(upper), toY: lower.y, toZ: purlinTop(lower),
          thickness: form.rafterDiameter.valueMm,
          widthX: form.rafterDiameter.valueMm,
          xStart: x - form.rafterDiameter.valueMm / 2,
        }),
        dimensions: [["diameter", form.rafterDiameter], ["spacing", form.rafterSpacing]],
      });
    }
  }
}

function buildRoofSurface(assembly: ConstructionAssembly, form: BuildingForm): void {
  const width = sum(form.bayWidthsMm) + form.eaveProjection.valueMm * 2;
  const lines = [...purlinLines(form)].sort((left, right) => right.y - left.y);
  const courseWidth = form.tileCourseWidth.valueMm;
  const courseCount = Math.max(1, Math.floor(width / courseWidth));
  // 坡面自檩背起算，依次叠椽、望板、瓦。同一步架内是直坡，
  // 举架的折线由逐段坡度不同形成，与檩位一致。
  const deckOf = (line: { z: number }) => line.z + form.purlinDiameter.valueMm + form.rafterDiameter.valueMm;

  for (let segment = 0; segment < lines.length - 1; segment += 1) {
    const upper = lines[segment]!;
    const lower = lines[segment + 1]!;
    assembly.add({
      stableKey: `roof-board:${segment}`,
      componentType: "roofBoard",
      displayNameZh: `望板 ${segment + 1}`,
      materialCode: form.materials.roofBoard,
      solid: slopedBarSolid({
        fromY: upper.y, fromZ: deckOf(upper), toY: lower.y, toZ: deckOf(lower),
        thickness: form.roofBoardThickness.valueMm, widthX: width, xStart: -width / 2,
      }),
      dimensions: [["thickness", form.roofBoardThickness]],
    });
    const tileBase = form.roofBoardThickness.valueMm;
    for (let course = 0; course < courseCount; course += 1) {
      const x = -width / 2 + courseWidth * course;
      assembly.add({
        stableKey: `pan-tile:${segment}:${course}`,
        componentType: "panTile",
        displayNameZh: `板瓦 ${segment + 1}-${course + 1}`,
        materialCode: form.materials.tile,
        solid: slopedBarSolid({
          fromY: upper.y, fromZ: deckOf(upper) + tileBase, toY: lower.y, toZ: deckOf(lower) + tileBase,
          thickness: form.tileThickness.valueMm,
          widthX: courseWidth * 0.6, xStart: x + courseWidth * 0.2,
        }),
        dimensions: [["courseWidth", form.tileCourseWidth], ["thickness", form.tileThickness]],
        parentKey: `roof-board:${segment}`,
      });
      // 筒瓦压在相邻两垄板瓦的接缝上，断面高度取两倍瓦厚。
      // 沿坡挤出只能沿坐标轴，半圆断面与坡向垂直，本轮按矩形断面表达，
      // 一比五十图上体现为瓦垄凸起，瓦当滴水不在本轮范围。
      assembly.add({
        stableKey: `cover-tile:${segment}:${course}`,
        componentType: "coverTile",
        displayNameZh: `筒瓦 ${segment + 1}-${course + 1}`,
        materialCode: form.materials.tile,
        solid: slopedBarSolid({
          fromY: upper.y, fromZ: deckOf(upper) + tileBase, toY: lower.y, toZ: deckOf(lower) + tileBase,
          thickness: form.tileThickness.valueMm * 2,
          widthX: courseWidth * 0.4, xStart: x - courseWidth * 0.2,
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
        center: [0, 0, ridge.z + form.purlinDiameter.valueMm + form.rafterDiameter.valueMm
          + form.roofBoardThickness.valueMm + form.tileThickness.valueMm * 2 + form.ridgeHeight.valueMm / 2],
      }),
      dimensions: [["height", form.ridgeHeight]],
    });
  }
}

// 山面：博风板与山面脊饰。屋顶形式决定山面做法，判不出就不生成。
// 补一种常见做法等于替资料下判断，与产品主张相反。
function buildGable(assembly: ConstructionAssembly, form: BuildingForm): void {
  const gable = form.gable;
  if (!gable) {
    assembly.addUnknown({
      key: "gable-form-undetermined",
      subjectRef: "form:gable",
      reasonCode: "ROOF_FORM_NOT_DETERMINED",
      descriptionZh: "资料判不出屋顶形式，山面做法随之无从确定，本次不生成博风板与山面脊饰。补齐山面照片或屋顶形式的形制定级记录后可重新生成。",
      requiredEvidence: ["山面近景照片或测绘记录", "屋顶形式的形制定级记录"],
      affectedRefs: ["form:gable"],
    });
    return;
  }
  const width = sum(form.bayWidthsMm);
  const lines = [...purlinLines(form)].sort((left, right) => right.y - left.y);
  const eave = lines[0]!;
  const ridge = lines.find((line) => line.y === 0) ?? eave;
  const deck = (line: { z: number }) => line.z + form.purlinDiameter.valueMm + form.rafterDiameter.valueMm;

  for (const side of [1, -1]) {
    const x = (side * width) / 2 + side * gable.overhang.valueMm;
    // 博风沿两坡各一条，随举架折线走
    for (let segment = 0; segment < lines.length - 1; segment += 1) {
      const upper = lines[segment]!;
      const lower = lines[segment + 1]!;
      assembly.add({
        stableKey: `barge-board:${side > 0 ? "east" : "west"}:${segment}`,
        componentType: "gableBoard",
        displayNameZh: `${side > 0 ? "东" : "西"}博风板 ${segment + 1}`,
        materialCode: form.materials.gable,
        solid: slopedBarSolid({
          fromY: upper.y, fromZ: deck(upper), toY: lower.y, toZ: deck(lower),
          thickness: gable.bargeBoardWidth.valueMm,
          widthX: gable.bargeBoardThickness.valueMm,
          xStart: x - (side > 0 ? 0 : gable.bargeBoardThickness.valueMm),
        }),
        dimensions: [["thickness", gable.bargeBoardThickness], ["width", gable.bargeBoardWidth]],
      });
    }
    assembly.add({
      stableKey: `gable-ridge-cap:${side > 0 ? "east" : "west"}`,
      componentType: "gableRidgeCap",
      displayNameZh: `${side > 0 ? "东" : "西"}山面脊饰`,
      materialCode: form.materials.ridge,
      solid: boxSolid({
        sizeX: gable.bargeBoardThickness.valueMm * 2,
        sizeY: form.tileCourseWidth.valueMm,
        sizeZ: form.ridgeHeight.valueMm,
        center: [x, 0, deck(ridge) + form.roofBoardThickness.valueMm + form.ridgeHeight.valueMm / 2],
      }),
      dimensions: [["height", form.ridgeHeight]],
    });
  }
}

// 飞椽与檐口封闭。有没有飞椽由资料说了算，判不出就记未知项。
function buildEaveDetail(assembly: ConstructionAssembly, form: BuildingForm): void {
  const fly = form.flyRafter;
  if (!fly) {
    assembly.addUnknown({
      key: "fly-rafter-undetermined",
      subjectRef: "form:eave",
      reasonCode: "FLY_RAFTER_NOT_DETERMINED",
      descriptionZh: "资料判不出檐口是否用飞椽，本次不生成飞椽与檐口封闭构件。补齐檐口近景照片或檐部做法记录后可重新生成。",
      requiredEvidence: ["檐口近景照片", "檐部做法的形制定级记录"],
      affectedRefs: ["form:eave"],
    });
    return;
  }
  const width = sum(form.bayWidthsMm) + form.eaveProjection.valueMm * 2;
  const spacing = form.rafterSpacing.valueMm;
  const count = Math.max(1, Math.floor(width / spacing));
  const lines = [...purlinLines(form)].sort((left, right) => right.y - left.y);
  const eave = lines[0]!;
  const next = lines[1] ?? eave;
  const deck = (line: { z: number }) => line.z + form.purlinDiameter.valueMm + form.rafterDiameter.valueMm;
  // 飞椽压在檐椽之上，沿同一坡向再挑出一段
  const run = eave.y - next.y;
  const rise = deck(eave) - deck(next);
  const length = Math.hypot(run, rise);
  const unitY = length > 0 ? run / length : 1;
  const unitZ = length > 0 ? rise / length : 0;

  for (let index = 0; index < count; index += 1) {
    const x = -width / 2 + spacing * (index + 0.5);
    assembly.add({
      stableKey: `fly-rafter:${index}`,
      componentType: "flyRafter",
      displayNameZh: `飞椽 ${index + 1}`,
      materialCode: form.materials.flyRafter,
      solid: slopedBarSolid({
        fromY: eave.y + unitY * fly.projection.valueMm,
        fromZ: deck(eave) + form.rafterDiameter.valueMm + unitZ * fly.projection.valueMm,
        toY: eave.y - unitY * fly.projection.valueMm,
        toZ: deck(eave) + form.rafterDiameter.valueMm - unitZ * fly.projection.valueMm,
        thickness: fly.sectionSize.valueMm,
        widthX: fly.sectionSize.valueMm,
        xStart: x - fly.sectionSize.valueMm / 2,
      }),
      dimensions: [["section", fly.sectionSize], ["projection", fly.projection]],
    });
  }
  assembly.add({
    stableKey: "eave-closure",
    componentType: "eaveClosure",
    displayNameZh: "檐口封闭",
    materialCode: form.materials.flyRafter,
    solid: boxSolid({
      sizeX: width, sizeY: fly.sectionSize.valueMm, sizeZ: fly.eaveClosureHeight.valueMm,
      center: [
        0,
        eave.y + unitY * fly.projection.valueMm,
        deck(eave) + form.rafterDiameter.valueMm + unitZ * fly.projection.valueMm + fly.eaveClosureHeight.valueMm / 2,
      ],
    }),
    dimensions: [["height", fly.eaveClosureHeight], ["section", fly.sectionSize]],
  });
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
  buildBeamFrame(assembly, form);
  buildRoofFrame(assembly, form);
  buildRoofSurface(assembly, form);
  buildGable(assembly, form);
  buildEaveDetail(assembly, form);
  buildEnclosure(assembly, form);
  return assembly.result();
}
