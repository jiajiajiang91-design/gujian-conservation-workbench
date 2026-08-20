import type { DataStatusSchema, ReviewStatusSchema } from "@gujian/domain";
import type { z } from "zod";

type DataStatus = z.infer<typeof DataStatusSchema>;
type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

// 演示项目的声明式定义。项目名、尺寸、资料清单只写在这里，
// 生成逻辑不认识任何具体项目（技术架构 8.1）。

export interface DemoLibrarySource {
  readonly key: string;
  // 相对仓库根目录的路径。留空表示该资料确实拿不到，界面照样登记为缺失。
  readonly filePath: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly evidenceType: "photo" | "document" | "drawing" | "measurementRecord" | "other";
  readonly title: string;
  readonly rightsDeclaration: string | null;
  readonly intendedUse: string | null;
  readonly recordedAt: string | null;
  readonly parser: string;
  readonly parseStatus: "parsed" | "metadataOnly" | "pending" | "failed";
  readonly extractedText: string | null;
  readonly parseWarnings: readonly string[];
  // 声明后由产品自己的解析器在构建期读文件内容，parser、正文与警告都以
  // 解析结果为准，定义里声明的对应字段被忽略。这样演示展示的解析结果
  // 就是产品真实的解析结果，不是抄进定义的副本。
  readonly parseWithProduct?: boolean;
  readonly absenceReasonZh?: string;
}

export interface DemoFact {
  readonly key: string;
  readonly subject: "building" | string;
  readonly field: string;
  readonly value: unknown;
  readonly evidenceKeys: readonly string[];
  readonly reviewStatus: ReviewStatus;
  readonly dataStatus: DataStatus;
}

export interface DemoMeasurement {
  readonly key: string;
  readonly subject: "building" | string;
  readonly quantity: { readonly name: string; readonly value: number; readonly unit: string };
  readonly evidenceKey: string;
  readonly methodZh: string;
  readonly dataStatus: DataStatus;
}

export interface DemoIssue {
  readonly key: string;
  readonly issueType: "missingEvidence" | "professionalUncertainty" | "ruleConflict" | "highRisk";
  readonly descriptionZh: string;
  readonly impactEvidenceKeys: readonly string[];
  // 演示数据一律阻断正式资格；是否连代理成果也阻断由这一项决定
  // （质量基准 2.3：演示要能走通全流程，所以默认不阻断代理成果）。
  readonly blocksProxyOutcome: boolean;
}

export interface DemoDrawingView {
  readonly key: string;
  readonly displayLabelZh: string;
  readonly drawingRef: string;
  readonly kind: "floorPlan" | "roofPlan" | "elevation" | "axonometric" | "transverseSection" | "longitudinalSection" | "detail";
  readonly scaleDenominator: number;
  readonly sheetKey: string;
  readonly viewportRectMm: readonly [number, number, number, number];
  readonly direction: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly sectionPlane?: { readonly normal: readonly [number, number, number]; readonly offsetMm: number };
  // 详图必须声明它画的是哪些构件（成果矩阵对 detail 强制要求非空构件集）。
  // 定义里按构件类型写，构建时解析成稳定键，不在定义文件里硬列几百个键。
  readonly targetComponentTypes?: readonly string[];
  // 每类最多取几个，避免详图把整座建筑都拉进来
  readonly targetPerTypeLimit?: number;
  readonly cropBoundsMm?: readonly [number, number, number, number];
  readonly sourceEvidenceKeys: readonly string[];
}

export interface DemoTask {
  readonly name: string;
  readonly scope: readonly string[];
  readonly regulationRefs: readonly string[];
  readonly deliverables: readonly string[];
  readonly confirmed: boolean;
  readonly artifactRequirements?: {
    readonly titleZh: string;
    readonly revisionLabel: string;
    readonly geometryTargetRoles: readonly string[];
    readonly views: readonly DemoDrawingView[];
    readonly sheets: readonly {
      readonly key: string;
      readonly drawingNumber: string;
      readonly displayLabelZh: string;
      readonly pageMm: readonly [number, number];
    }[];
  };
}

export interface DemoProjectDefinition {
  readonly demoId: string;
  readonly projectName: string;
  readonly buildingName: string;
  readonly locationText: string | null;
  readonly periodText: string | null;
  readonly addressText: string | null;
  readonly createdAt: string;
  // 一句话说清适用边界，随包进界面（08 演示项目定义 2）
  readonly limitationZh: string;
  readonly sources: readonly DemoLibrarySource[];
  readonly facts: readonly DemoFact[];
  readonly measurements: readonly DemoMeasurement[];
  readonly issues: readonly DemoIssue[];
  readonly task: DemoTask;
  // 形制参数。有它才能由规则推算出尺寸并驱动构件生成，
  // 08 演示项目定义表 3 的实测基准这一格也靠它才有内容。
  readonly archetype?: DemoArchetype;
  // 实测图纸驱动的木构架参数。没有形制规则可依的项目走这一条，
  // 尺寸全部来自图纸转写或图上量取，不做任何形制推算。
  readonly timberFrame?: DemoTimberFrame;
}

// 一条尺寸连同它是怎么来的。drawn 是图纸上写明的标注，scaled 是按图上量取；
// 两者精度差一个量级，界面必须分开显示，不能都算成实测。
export interface DemoSourcedDimension {
  readonly valueMm: number;
  readonly source: "drawn" | "scaled";
  readonly methodZh: string;
  // 对应 measurements 里的条目键，写明的标注才有；量取值不进尺寸事实
  readonly measurementKey?: string;
  readonly evidenceKeys: readonly string[];
}

export interface DemoPlanRect {
  readonly key: string;
  readonly displayNameZh: string;
  readonly level: "first" | "second";
  readonly fromXMm: number;
  readonly toXMm: number;
  readonly fromYMm: number;
  readonly toYMm: number;
}

interface DemoDimensionGroup {
  readonly source: "drawn" | "scaled";
  readonly methodZh: string;
  readonly evidenceKeys: readonly string[];
}

export interface DemoTimberFrame {
  readonly sourceDeclarationZh: string;
  // 键与 TimberFrameForm 的字段同名
  readonly dimensions: Readonly<Record<string, DemoSourcedDimension>>;
  readonly monitors: readonly (DemoDimensionGroup & {
    readonly key: string;
    readonly fromXMm: number;
    readonly toXMm: number;
    readonly startYMm: number;
    readonly endYMm: number;
    readonly riseMm: number;
  })[];
  // 平面上量取的矩形共用一条来源说明
  readonly planScaled: DemoSourcedDimension;
  readonly partitions: readonly DemoPlanRect[];
  readonly secondFloorDecks: readonly DemoPlanRect[];
  readonly canopies: readonly (DemoDimensionGroup & {
    readonly key: string;
    readonly displayNameZh: string;
    readonly fromXMm: number;
    readonly toXMm: number;
    readonly fromYMm: number;
    readonly toYMm: number;
    readonly elevationMm: number;
    readonly thicknessMm: number;
    readonly postXsMm: readonly number[];
    readonly postSizeMm: number;
  })[];
  readonly materials: Readonly<Record<string, string>>;
}

// 形制参数与由它驱动的构件生成配置。数值全部来自照片估算或规则推算，
// 每项在 sourceZh 里说清是哪一种，界面据此如实标注。
export interface DemoArchetype {
  readonly ruleSetId: string;
  readonly moduleMm: number;
  readonly moduleNameZh: string;
  readonly moduleSourceZh: string;
  readonly stepCount: number;
  // 逐间面阔与逐架步架，毫米
  readonly bayWidthsMm: readonly number[];
  readonly depthMm: number;
  readonly sourceDeclarationZh: string;
  // 构件生成用的其余尺寸，键与生成器的 BuildingForm 字段同名
  readonly componentDimensionsMm: Readonly<Record<string, number>>;
  readonly columnSection: "round" | "square";
  readonly bracketSetsPerBay: number;
  readonly enclosure: { readonly front: "open" | "walled"; readonly sides: "walled" | "open"; readonly back: "walled" | "open" };
  // 山面做法与飞椽都要有形制判断依据才声明。资料判不出就整项省略，
  // 生成器据此记未知项，不按常见做法默认补一种。
  readonly gable?: {
    readonly roofFormZh: string;
    readonly bargeBoardThicknessMm: number;
    readonly bargeBoardWidthMm: number;
    readonly overhangMm: number;
  };
  readonly flyRafter?: {
    readonly sectionSizeMm: number;
    readonly projectionMm: number;
    readonly eaveClosureHeightMm: number;
  };
  readonly materials: Readonly<Record<string, string>>;
  // 哪些尺寸是照片估算，其余按规则推算标注
  readonly estimatedDimensionKeys: readonly string[];
}
