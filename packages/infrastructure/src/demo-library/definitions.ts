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
}
