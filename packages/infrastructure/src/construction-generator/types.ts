import type { ProducerRef, ProjectDrivenGeometrySpec } from "@gujian/domain";

// 形制驱动的构件生成器：输入一套已经算好的尺寸，输出逐构件几何。
//
// 生成器不做比例推算。所有比例来自规则集，推算在 archetype-derivation 完成，
// 到这里只剩具体毫米数。这样专业人员改规则就能改模型，不必改代码，
// 也保证生成器里不会出现任何没有出处的数字。
//
// 构件分部与布置逻辑与朝代无关，差别在模数体系与做法比例。清式用斗口制、
// 宋式用材份制，两者作为并列规则集表达，生成器只认算好的尺寸。

export interface ModularSystem {
  // 规则集标识，与 heritage-baseline 里的 ruleSetId 对应
  readonly ruleSetId: string;
  readonly labelZh: string;
  // 模数根的毫米值：清式取斗口，宋式取分值
  readonly moduleMm: number;
  readonly moduleNameZh: string;
  readonly sourceText: string;
}

// 一条尺寸连同它的来源。生成器不接受裸数字：每个尺寸都要说清是实测、
// 规则推算还是照片估算，否则界面无法如实标注来源。
export interface SourcedLength {
  readonly valueMm: number;
  readonly basis: "measured" | "rule" | "human" | "demo";
  // 指向推算尺寸事实或实测记录
  readonly factRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface EnclosureForm {
  // 前檐敞廊时不生成前檐墙体与门窗，这是形制不是省略
  readonly front: "open" | "walled";
  readonly sides: "walled" | "open";
  readonly back: "walled" | "open";
}

export interface BuildingForm {
  readonly modular: ModularSystem;
  // 面阔逐间，从左到右
  readonly bayWidthsMm: readonly SourcedLength[];
  // 步架逐架，从檐向脊；举高与之等长
  readonly stepSpansMm: readonly SourcedLength[];
  readonly liftHeightsMm: readonly SourcedLength[];

  readonly terraceHeight: SourcedLength;
  readonly terraceProjection: SourcedLength;
  readonly stairTreadCount: number;
  readonly stairWidth: SourcedLength;

  readonly columnBaseHeight: SourcedLength;
  readonly columnHeight: SourcedLength;
  readonly columnSize: SourcedLength;
  readonly columnSection: "round" | "square";

  readonly architraveHeight: SourcedLength;
  readonly architraveThickness: SourcedLength;

  // 无斗栱做法传 null，生成器跳过承托层并记未知项
  readonly bracketLayerHeight: SourcedLength | null;
  readonly bracketSetsPerBay: number;

  readonly purlinDiameter: SourcedLength;
  readonly rafterDiameter: SourcedLength;
  readonly rafterSpacing: SourcedLength;
  readonly roofBoardThickness: SourcedLength;
  readonly eaveProjection: SourcedLength;

  readonly tileCourseWidth: SourcedLength;
  readonly tileThickness: SourcedLength;
  readonly ridgeHeight: SourcedLength;

  readonly enclosure: EnclosureForm;
  readonly materials: Readonly<Record<ConstructionPart, string>>;
}

export type ConstructionPart =
  | "terrace"
  | "stair"
  | "columnBase"
  | "column"
  | "architrave"
  | "bracket"
  | "purlin"
  | "rafter"
  | "roofBoard"
  | "tile"
  | "ridge"
  | "wall";

export interface GenerateInput {
  readonly form: BuildingForm;
  readonly producer: ProducerRef;
  // 形制判断依据的资料，进每个构件的 evidenceRefs
  readonly formEvidenceRefs: readonly string[];
  // 稳定标识与构件号的命名空间，同一项目重复生成得到同样的 stableKey
  readonly keyPrefix: string;
}

export interface GenerateResult {
  readonly objects: ProjectDrivenGeometrySpec["objects"];
  readonly interfaces: ProjectDrivenGeometrySpec["interfaces"];
  readonly unknowns: ProjectDrivenGeometrySpec["unknowns"];
  readonly partCounts: Readonly<Record<string, number>>;
}
