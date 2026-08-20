import type { ProjectHead } from "@gujian/application";
import { ProjectDrivenGeometrySpecSchema, type ProjectDrivenGeometrySpec } from "@gujian/domain";

import { generateConstruction } from "../construction-generator/index.js";
import type { BuildingForm, SourcedLength } from "../construction-generator/index.js";
import { recordHash } from "../hash.js";
import type { DemoArchetype } from "./definitions.js";

// 形制参数到构件几何的桥接：把演示定义里的形制参数与推算尺寸装成
// 生成器的输入，再把生成结果封成一份合法 GeometrySpec。
//
// 这里不做任何比例推算。步架由通进深与步架数均分，举高由规则集系数算出，
// 其余尺寸直接取定义里的值，并按 estimatedDimensionKeys 标注是估算还是推算。

export interface ArchetypeGeometryInput {
  readonly head: ProjectHead;
  readonly archetype: DemoArchetype;
  readonly liftRatios: readonly number[];
  readonly fixtureId: string;
  readonly formEvidenceRefs: readonly string[];
  readonly keyPrefix: string;
}

function requireDimension(archetype: DemoArchetype, key: string): number {
  const value = archetype.componentDimensionsMm[key];
  if (value === undefined) throw new Error(`ARCHETYPE_DIMENSION_MISSING:${key}`);
  return value;
}

export function buildArchetypeGeometrySpec(input: ArchetypeGeometryInput): ProjectDrivenGeometrySpec {
  const { archetype, head } = input;
  const estimated = new Set(archetype.estimatedDimensionKeys);
  const evidenceRefs = [...input.formEvidenceRefs];

  // 照片估算与规则推算要分开标。把估算值显示成推算值等于抹掉不确定性。
  const sourced = (key: string, valueMm: number): SourcedLength => ({
    valueMm,
    basis: estimated.has(key) ? "demo" : "rule",
    factRefs: [`archetype:${archetype.ruleSetId}:${key}`],
    evidenceRefs,
  });

  const stepSpanMm = archetype.depthMm / 2 / archetype.stepCount;
  const stepSpans = Array.from({ length: archetype.stepCount }, () => sourced("stepSpan", stepSpanMm));
  // 举高逐架取规则集系数。系数档数不足时缺的架不生成，与形制派生的裁剪口径一致。
  const liftHeights = Array.from({ length: archetype.stepCount }, (_unused, index) => {
    const ratio = input.liftRatios[index];
    if (ratio === undefined) throw new Error(`ARCHETYPE_LIFT_RATIO_MISSING:${index + 1}`);
    return sourced(`lift${index + 1}`, stepSpanMm * ratio);
  });

  const form: BuildingForm = {
    modular: {
      ruleSetId: archetype.ruleSetId,
      labelZh: archetype.moduleNameZh,
      moduleMm: archetype.moduleMm,
      moduleNameZh: archetype.moduleNameZh,
      sourceText: archetype.moduleSourceZh,
    },
    bayWidthsMm: archetype.bayWidthsMm.map((value, index) => sourced(`bayWidth${index + 1}`, value)),
    stepSpansMm: stepSpans,
    liftHeightsMm: liftHeights,
    terraceHeight: sourced("terraceHeight", requireDimension(archetype, "terraceHeight")),
    terraceProjection: sourced("terraceProjection", requireDimension(archetype, "terraceProjection")),
    stairTreadCount: requireDimension(archetype, "stairTreadCount"),
    stairWidth: sourced("stairWidth", requireDimension(archetype, "stairWidth")),
    columnBaseHeight: sourced("columnBaseHeight", requireDimension(archetype, "columnBaseHeight")),
    columnHeight: sourced("columnHeight", requireDimension(archetype, "columnHeight")),
    columnSize: sourced("columnSize", requireDimension(archetype, "columnSize")),
    columnSection: archetype.columnSection,
    architraveHeight: sourced("architraveHeight", requireDimension(archetype, "architraveHeight")),
    architraveThickness: sourced("architraveThickness", requireDimension(archetype, "architraveThickness")),
    bracketLayerHeight: archetype.componentDimensionsMm.bracketLayerHeight === undefined
      ? null
      : sourced("bracketLayerHeight", archetype.componentDimensionsMm.bracketLayerHeight),
    bracketSetsPerBay: archetype.bracketSetsPerBay,
    // 梁架逐层截面：底层取形制参数给的值，往上每层各减一个模数。
    // 递减幅度是做法比例，规则集里目前没有带出处的梁截面条目，
    // 因此整组标为估算，与 sourceDeclarationZh 的声明一致。
    beamSectionsMm: Array.from({ length: archetype.stepCount }, (_unused, tier) => {
      const module = archetype.moduleMm;
      const width = requireDimension(archetype, "beamWidth") - module * tier;
      const height = requireDimension(archetype, "beamHeight") - module * tier;
      if (width <= 0 || height <= 0) throw new Error(`ARCHETYPE_BEAM_SECTION_EXHAUSTED:${tier + 1}`);
      // 来源随底层取值判定：底层是估算，逐层递减出来的也是估算。
      const tiered = (baseKey: string, valueMm: number): SourcedLength => ({
        ...sourced(baseKey, valueMm),
        factRefs: [`archetype:${archetype.ruleSetId}:${baseKey}:${tier + 1}`],
      });
      return { width: tiered("beamWidth", width), height: tiered("beamHeight", height) };
    }),
    purlinDiameter: sourced("purlinDiameter", requireDimension(archetype, "purlinDiameter")),
    rafterDiameter: sourced("rafterDiameter", requireDimension(archetype, "rafterDiameter")),
    rafterSpacing: sourced("rafterSpacing", requireDimension(archetype, "rafterSpacing")),
    roofBoardThickness: sourced("roofBoardThickness", requireDimension(archetype, "roofBoardThickness")),
    eaveProjection: sourced("eaveProjection", requireDimension(archetype, "eaveProjection")),
    tileCourseWidth: sourced("tileCourseWidth", requireDimension(archetype, "tileCourseWidth")),
    tileThickness: sourced("tileThickness", requireDimension(archetype, "tileThickness")),
    ridgeHeight: sourced("ridgeHeight", requireDimension(archetype, "ridgeHeight")),
    enclosure: archetype.enclosure,
    // 山面与飞椽由形制判断记录声明。判不出的项传 null，生成器记未知项，
    // 不按常见做法默认补一种（08 演示项目定义第 8 节：不隐藏来源、不把推算显示为实测）。
    gable: archetype.gable
      ? {
        roofFormZh: archetype.gable.roofFormZh,
        bargeBoardThickness: sourced("bargeBoardThickness", archetype.gable.bargeBoardThicknessMm),
        bargeBoardWidth: sourced("bargeBoardWidth", archetype.gable.bargeBoardWidthMm),
        overhang: sourced("gableOverhang", archetype.gable.overhangMm),
      }
      : null,
    flyRafter: archetype.flyRafter
      ? {
        sectionSize: sourced("flyRafterSection", archetype.flyRafter.sectionSizeMm),
        projection: sourced("flyRafterProjection", archetype.flyRafter.projectionMm),
        eaveClosureHeight: sourced("eaveClosureHeight", archetype.flyRafter.eaveClosureHeightMm),
      }
      : null,
    materials: archetype.materials as BuildingForm["materials"],
  };

  const generated = generateConstruction({
    form,
    producer: { producerType: "demo", fixtureId: input.fixtureId },
    formEvidenceRefs: evidenceRefs,
    keyPrefix: input.keyPrefix,
  });

  const base = {
    schemaVersion: "2.0" as const,
    id: crypto.randomUUID(),
    projectId: head.projectId,
    projectRevisionId: head.revisionId,
    buildingId: head.snapshot.buildings[0]!.id,
    inputHash: "0".repeat(64),
    coordinateSystem: {
      name: "项目局部坐标", axisOrder: "XYZ" as const, upAxis: "Z" as const,
      lengthUnit: "mm" as const, origin: [0, 0, 0] as [number, number, number],
    },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects: generated.objects,
    interfaces: generated.interfaces,
    unknowns: generated.unknowns,
    createdAt: new Date().toISOString(),
  };
  return ProjectDrivenGeometrySpecSchema.parse({ ...base, inputHash: recordHash(base) });
}
