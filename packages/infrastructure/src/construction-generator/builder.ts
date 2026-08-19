import type { ProjectDrivenGeometrySpec } from "@gujian/domain";

import { sha256Hex } from "../hash.js";
import type { SourcedLength } from "./types.js";

// 构件装配的共用工具：稳定标识、确定性 ID、solid 与参数的构造。
// 同一份输入重复生成必须得到同样的 stableKey 与 ID，否则项目包不可复现。

type GeometryObject = ProjectDrivenGeometrySpec["objects"][number];
type GeometryInterface = ProjectDrivenGeometrySpec["interfaces"][number];
type UnknownValue = ProjectDrivenGeometrySpec["unknowns"][number];

export function deterministicUuid(seed: string): string {
  const hex = sha256Hex(new TextEncoder().encode(seed)).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

// 毫米值统一保留到 0.1 mm。几何管线的建模容差是 0.01 mm，
// 再细的小数只会让哈希对不上，没有工程意义。
export function exact(valueMm: number): string {
  const rounded = Math.round(valueMm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export class ConstructionAssembly {
  readonly #keyPrefix: string;
  readonly #producer: GeometryObject["producer"];
  readonly #formEvidenceRefs: readonly string[];
  readonly #objects: GeometryObject[] = [];
  readonly #interfaces: GeometryInterface[] = [];
  readonly #unknowns: UnknownValue[] = [];
  readonly #counts = new Map<string, number>();
  readonly #idByKey = new Map<string, string>();

  constructor(input: {
    keyPrefix: string;
    producer: GeometryObject["producer"];
    formEvidenceRefs: readonly string[];
  }) {
    this.#keyPrefix = input.keyPrefix;
    this.#producer = input.producer;
    this.#formEvidenceRefs = input.formEvidenceRefs;
  }

  idFor(stableKey: string): string {
    return deterministicUuid(`${this.#keyPrefix}:object:${stableKey}`);
  }

  has(stableKey: string): boolean {
    return this.#idByKey.has(stableKey);
  }

  // 一个构件的尺寸参数。basis 与 factRefs 直接来自输入的 SourcedLength，
  // 生成器不改写来源，界面据此如实显示是实测、推算还是估算。
  #parameters(stableKey: string, entries: readonly [string, SourcedLength][]): GeometryObject["parameters"] {
    return entries.map(([name, length]) => ({
      id: deterministicUuid(`${this.#keyPrefix}:param:${stableKey}:${name}`),
      name,
      basis: length.basis,
      factRefs: [...length.factRefs],
      evidenceRefs: [...length.evidenceRefs],
      valueType: "length" as const,
      exactValue: exact(length.valueMm),
      unit: "mm" as const,
    }));
  }

  add(input: {
    stableKey: string;
    componentType: string;
    displayNameZh: string;
    materialCode: string;
    solid: GeometryObject["solid"];
    dimensions: readonly [string, SourcedLength][];
    parentKey?: string;
    conceptRef?: string;
    unknownKeys?: readonly string[];
  }): string {
    const id = this.idFor(input.stableKey);
    if (this.#idByKey.has(input.stableKey)) throw new Error(`CONSTRUCTION_DUPLICATE_KEY:${input.stableKey}`);
    this.#idByKey.set(input.stableKey, id);
    const factRefs = [...new Set(input.dimensions.flatMap(([, length]) => length.factRefs))];
    const evidenceRefs = [...new Set([
      ...this.#formEvidenceRefs,
      ...input.dimensions.flatMap(([, length]) => length.evidenceRefs),
    ])];
    this.#objects.push({
      id,
      stableKey: input.stableKey,
      parentId: input.parentKey ? this.idFor(input.parentKey) : null,
      componentType: input.componentType,
      ...(input.conceptRef ? { conceptRef: input.conceptRef } : {}),
      displayNameZh: input.displayNameZh,
      materialCode: input.materialCode,
      solid: input.solid,
      parameters: this.#parameters(input.stableKey, input.dimensions),
      producer: this.#producer,
      factRefs,
      evidenceRefs,
      unknownRefs: (input.unknownKeys ?? []).map((key) => deterministicUuid(`${this.#keyPrefix}:unknown:${key}`)),
    });
    this.#counts.set(input.componentType, (this.#counts.get(input.componentType) ?? 0) + 1);
    return id;
  }

  // 只携带竖向承重链接口。长构件的多点接触与瓦件搭接由几何检查按面判定，
  // 逐条声明会产出上万条无法逐一核对的记录，与既有转换器的取舍一致。
  connect(input: {
    fromKey: string;
    toKey: string;
    interfaceType: GeometryInterface["interfaceType"];
    fromSurface: string;
    toSurface: string;
    direction: readonly [number, number, number];
    maximumGapMm: number;
    factRefs?: readonly string[];
    evidenceRefs?: readonly string[];
  }): void {
    if (!this.#idByKey.has(input.fromKey) || !this.#idByKey.has(input.toKey)) {
      throw new Error(`CONSTRUCTION_INTERFACE_TARGET_MISSING:${input.fromKey}->${input.toKey}`);
    }
    this.#interfaces.push({
      id: deterministicUuid(`${this.#keyPrefix}:interface:${input.fromKey}->${input.toKey}`),
      fromObjectId: this.idFor(input.fromKey),
      toObjectId: this.idFor(input.toKey),
      interfaceType: input.interfaceType,
      fromSurface: input.fromSurface,
      toSurface: input.toSurface,
      direction: [...input.direction] as [number, number, number],
      maximumGapMm: input.maximumGapMm,
      maximumUnexpectedOverlapMm3: 1e6,
      minimumDeclaredOverlapMm3: null,
      factRefs: [...(input.factRefs ?? [])],
      evidenceRefs: [...new Set([...this.#formEvidenceRefs, ...(input.evidenceRefs ?? [])])],
    });
  }

  // 生成不出来或没有出处的部位记结构化未知项，不用默认值糊过去。
  addUnknown(input: {
    key: string;
    subjectRef: string;
    reasonCode: string;
    descriptionZh: string;
    requiredEvidence: readonly string[];
    affectedRefs: readonly string[];
  }): void {
    this.#unknowns.push({
      id: deterministicUuid(`${this.#keyPrefix}:unknown:${input.key}`),
      subjectRef: input.subjectRef,
      reasonCode: input.reasonCode,
      description: input.descriptionZh,
      requiredEvidence: [...input.requiredEvidence],
      affectedRefs: [...input.affectedRefs],
      evidenceRefs: [...this.#formEvidenceRefs],
      blocksProxyOutcome: false,
      blocksFormalEligibility: true,
    });
  }

  result() {
    return {
      objects: this.#objects,
      interfaces: this.#interfaces,
      unknowns: this.#unknowns,
      partCounts: Object.fromEntries([...this.#counts.entries()].sort()),
    };
  }
}

export function boxSolid(input: {
  sizeX: number; sizeY: number; sizeZ: number; center: readonly [number, number, number];
}): ProjectDrivenGeometrySpec["objects"][number]["solid"] {
  return {
    kind: "box",
    sizeX: exact(input.sizeX), sizeY: exact(input.sizeY), sizeZ: exact(input.sizeZ),
    centerMm: [input.center[0], input.center[1], input.center[2]],
  };
}

export function cylinderSolid(input: {
  radius: number; height: number; axis: "x" | "y" | "z"; center: readonly [number, number, number];
}): ProjectDrivenGeometrySpec["objects"][number]["solid"] {
  return {
    kind: "cylinder",
    radius: exact(input.radius), height: exact(input.height), axis: input.axis,
    centerMm: [input.center[0], input.center[1], input.center[2]],
  };
}
