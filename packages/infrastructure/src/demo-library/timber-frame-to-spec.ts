import type { ProjectHead } from "@gujian/application";
import { ProjectDrivenGeometrySpecSchema, type ProjectDrivenGeometrySpec } from "@gujian/domain";

import { deterministicUuid } from "../construction-generator/builder.js";
import { recordHash } from "../hash.js";
import { generateTimberFrame } from "../timber-frame-builder/index.js";
import type { CanopyForm, MonitorForm, SourcedDimension, TimberFrameForm } from "../timber-frame-builder/index.js";
import { demoSeededUuid } from "./build-demo-project.js";
import type { DemoSourcedDimension, DemoTimberFrame } from "./definitions.js";

// 实测图纸到构件几何的桥接。与 archetype-to-form 并列：那一条把形制参数
// 装成生成器输入，这一条把图纸上转写与量取到的尺寸装成生成器输入。
// 两条都不在这里做推算，桥接只负责把来源标注带下去。

export interface TimberFrameGeometryInput {
  readonly head: ProjectHead;
  readonly demoId: string;
  readonly timberFrame: DemoTimberFrame;
  readonly fixtureId: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
}

function required(timberFrame: DemoTimberFrame, name: string): DemoSourcedDimension {
  const value = timberFrame.dimensions[name];
  if (!value) throw new Error(`TIMBER_FRAME_DIMENSION_MISSING:${name}`);
  return value;
}

export function buildTimberFrameGeometrySpec(input: TimberFrameGeometryInput): ProjectDrivenGeometrySpec {
  const { head, timberFrame } = input;
  const evidenceRef = (key: string) => demoSeededUuid(input.demoId, `evidence/${key}`);
  const factRef = (key: string) => demoSeededUuid(input.demoId, `measurement-fact/${key}`);

  const convert = (name: string): SourcedDimension => {
    const declared = required(timberFrame, name);
    return {
      valueMm: declared.valueMm,
      source: declared.source,
      methodZh: declared.methodZh,
      evidenceRefs: declared.evidenceKeys.map(evidenceRef),
      factRefs: declared.measurementKey ? [factRef(declared.measurementKey)] : [],
    };
  };
  // 气窗与顶棚的位置尺寸整组同一来源，逐条重复声明只会让定义更难核对
  const grouped = (
    valueMm: number, group: { readonly source: "drawn" | "scaled"; readonly methodZh: string; readonly evidenceKeys: readonly string[] },
  ): SourcedDimension => ({
    valueMm, source: group.source, methodZh: group.methodZh,
    evidenceRefs: group.evidenceKeys.map(evidenceRef), factRefs: [],
  });

  const monitors: MonitorForm[] = timberFrame.monitors.map((item) => ({
    key: item.key,
    fromX: grouped(item.fromXMm, item),
    toX: grouped(item.toXMm, item),
    startY: grouped(item.startYMm, item),
    endY: grouped(item.endYMm, item),
    rise: grouped(item.riseMm, item),
  }));
  const canopies: CanopyForm[] = timberFrame.canopies.map((item) => ({
    key: item.key,
    displayNameZh: item.displayNameZh,
    fromX: grouped(item.fromXMm, item),
    toX: grouped(item.toXMm, item),
    fromY: grouped(item.fromYMm, item),
    toY: grouped(item.toYMm, item),
    elevation: grouped(item.elevationMm, item),
    thickness: grouped(item.thicknessMm, item),
    postXs: item.postXsMm.map((value) => grouped(value, item)),
    postSize: grouped(item.postSizeMm, item),
  }));

  const form: TimberFrameForm = {
    width: convert("width"),
    depth: convert("depth"),
    wallThickness: convert("wallThickness"),
    eaveElevation: convert("eaveElevation"),
    ridgeElevation: convert("ridgeElevation"),
    secondFloorElevation: convert("secondFloorElevation"),
    floorAboveGrade: convert("floorAboveGrade"),
    floorStructureDepth: convert("floorStructureDepth"),
    roofThickness: convert("roofThickness"),
    eaveOverhang: convert("eaveOverhang"),
    gableOverhang: convert("gableOverhang"),
    girderDepth: convert("girderDepth"),
    pierSize: convert("pierSize"),
    pierSpacing: convert("pierSpacing"),
    monitors,
    canopies,
    planScaled: {
      valueMm: timberFrame.planScaled.valueMm,
      source: timberFrame.planScaled.source,
      methodZh: timberFrame.planScaled.methodZh,
      evidenceRefs: timberFrame.planScaled.evidenceKeys.map(evidenceRef),
      factRefs: [],
    },
    partitionThickness: convert("partitionThickness"),
    partitions: timberFrame.partitions,
    secondFloorDecks: timberFrame.secondFloorDecks,
    materials: timberFrame.materials as TimberFrameForm["materials"],
  };

  const generated = generateTimberFrame({
    form,
    producer: { producerType: "demo", fixtureId: input.fixtureId },
    evidenceRefs: head.snapshot.evidences.map((item) => item.id),
    keyPrefix: input.keyPrefix,
  });

  const base = {
    schemaVersion: "2.0" as const,
    id: deterministicUuid(`${input.keyPrefix}:spec`),
    projectId: head.projectId,
    projectRevisionId: head.revisionId,
    buildingId: head.snapshot.buildings[0]!.id,
    inputHash: "0".repeat(64),
    coordinateSystem: {
      name: "建筑局部坐标：X 沿总宽，Y 沿总长自西端起算，Z 自楼面标高起算",
      axisOrder: "XYZ" as const, upAxis: "Z" as const,
      lengthUnit: "mm" as const, origin: [0, 0, 0] as [number, number, number],
    },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects: generated.objects,
    interfaces: generated.interfaces,
    unknowns: generated.unknowns,
    createdAt: input.createdAt,
  };
  return ProjectDrivenGeometrySpecSchema.parse({ ...base, inputHash: recordHash(base) });
}
