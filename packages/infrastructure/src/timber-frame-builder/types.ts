import type { ProducerRef, ProjectDrivenGeometrySpec } from "@gujian/domain";

// 实测图纸驱动的木构架生成器。与 construction-generator 并列而不是复用：
// 那一条从形制参数按规则推算尺寸，只对有形制规则可依的中国官式建筑成立。
// 本条不做任何形制推算，输入是从实测图纸转写或量取到的具体尺寸，
// 图纸没给的部位一律记未知项，不按常见做法补。
//
// 08 演示项目定义 4.2 对 Dai Loy 的定位就是这一条：验证工程流程与制图质量，
// 不验证中国古建构件识别。

// 一条尺寸连同它是怎么来的。
// drawn 图纸上写明的标注，scaled 按图上量取。两者精度差一个量级，
// 不能混在一起显示：写明的标注精确到英寸，量取的只到十毫米级。
export interface SourcedDimension {
  readonly valueMm: number;
  readonly source: "drawn" | "scaled";
  // 指向哪一份资料、图上什么位置。量取的还要写清用什么基准校准。
  readonly methodZh: string;
  readonly evidenceRefs: readonly string[];
  readonly factRefs: readonly string[];
}

export interface MonitorForm {
  readonly key: string;
  // 平面上的矩形范围，自西北角起算。气窗不一定骑在屋脊上，
  // 位置以平面量取为准，不按对称假定摆正。
  readonly fromX: SourcedDimension;
  readonly toX: SourcedDimension;
  readonly startY: SourcedDimension;
  readonly endY: SourcedDimension;
  // 高出屋脊
  readonly rise: SourcedDimension;
}

// 平面上量取的矩形：隔墙与局部楼板。整组共用一条来源说明，
// 逐条重复写只会让定义更难核对。
export interface PlanRect {
  readonly key: string;
  readonly displayNameZh: string;
  readonly level: "first" | "second";
  readonly fromXMm: number;
  readonly toXMm: number;
  readonly fromYMm: number;
  readonly toYMm: number;
}

export interface CanopyForm {
  readonly key: string;
  readonly displayNameZh: string;
  // 顶棚在平面上的范围，建筑局部坐标
  readonly fromX: SourcedDimension;
  readonly toX: SourcedDimension;
  readonly fromY: SourcedDimension;
  readonly toY: SourcedDimension;
  readonly elevation: SourcedDimension;
  readonly thickness: SourcedDimension;
  // 柱位的 X 坐标；空数组表示这一顶棚不由独立柱承托
  readonly postXs: readonly SourcedDimension[];
  readonly postSize: SourcedDimension;
}

export interface TimberFrameForm {
  // 建筑外墙外皮围成的矩形
  readonly width: SourcedDimension;
  readonly depth: SourcedDimension;
  readonly wallThickness: SourcedDimension;

  readonly eaveElevation: SourcedDimension;
  readonly ridgeElevation: SourcedDimension;
  readonly secondFloorElevation: SourcedDimension;
  readonly floorAboveGrade: SourcedDimension;

  readonly floorStructureDepth: SourcedDimension;
  readonly roofThickness: SourcedDimension;
  readonly eaveOverhang: SourcedDimension;
  readonly gableOverhang: SourcedDimension;

  readonly girderDepth: SourcedDimension;
  readonly pierSize: SourcedDimension;
  readonly pierSpacing: SourcedDimension;

  readonly monitors: readonly MonitorForm[];
  readonly canopies: readonly CanopyForm[];

  // 平面量取的来源说明，隔墙与局部楼板共用
  readonly planScaled: SourcedDimension;
  readonly partitionThickness: SourcedDimension;
  readonly partitions: readonly PlanRect[];
  // 二层楼板按房间范围分块。图上标了 OPEN BELOW 的部分不铺板。
  readonly secondFloorDecks: readonly PlanRect[];

  readonly materials: Readonly<Record<TimberFramePart, string>>;
}

export type TimberFramePart =
  | "pier"
  | "girder"
  | "floorStructure"
  | "wall"
  | "gableWall"
  | "partition"
  | "roofPlane"
  | "monitorWall"
  | "monitorRoof"
  | "canopy"
  | "canopyPost";

export interface TimberFrameGenerateInput {
  readonly form: TimberFrameForm;
  readonly producer: ProducerRef;
  readonly evidenceRefs: readonly string[];
  readonly keyPrefix: string;
}

export interface TimberFrameGenerateResult {
  readonly objects: ProjectDrivenGeometrySpec["objects"];
  readonly interfaces: ProjectDrivenGeometrySpec["interfaces"];
  readonly unknowns: ProjectDrivenGeometrySpec["unknowns"];
  readonly partCounts: Readonly<Record<string, number>>;
}
