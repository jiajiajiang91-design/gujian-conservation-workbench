import { ProjectCommandService } from "@gujian/application";
import {
  AssetRecordSchema,
  EvidenceSchema,
  FactEnvelopeSchema,
  IssueSchema,
  ParseRecordSchema,
  TaskDefinitionSchema,
} from "@gujian/domain";

import { sha256Hex } from "../hash.js";
import { IndexedDbProjectRepository, LocalAuthorization } from "../indexeddb-project-repository.js";
import { ProjectPackageService } from "../project-package-service.js";
import type { DemoDrawingView, DemoProjectDefinition } from "./definitions.js";

// 演示项目包的生成路径。走真实命令服务与真实导出，不另做一套写入口，
// 因此包里带完整操作记录链，导入后与用户自己建的项目没有区别（08 演示项目定义 6）。
//
// 全过程不用 crypto.randomUUID 与当前时间：同一份输入必须得到同一份字节，
// 否则 08 第 2 节的可复现标准不成立。

// 演示项目的标识全部由 demoId 与键名确定性推出。构建脚本要引用其中的
// 资料标识（几何翻译的 evidenceRefs 指向它），因此对外暴露同一套算法，
// 不让调用方按标题去猜。
export function demoSeededUuid(namespace: string, key: string): string {
  return seededUuid(namespace, key);
}

function seededUuid(namespace: string, key: string): string {
  const hex = sha256Hex(new TextEncoder().encode(`${namespace}/${key}`)).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export interface SeededDemoProject {
  readonly projectId: string;
  readonly buildingId: string;
  readonly actorId: string;
  readonly seededAt: string;
}

export interface DemoBuildResult {
  readonly projectId: string;
  readonly buildingId: string;
  readonly packageBytes: Uint8Array;
  readonly packageSha256: string;
  readonly evidenceCount: number;
  readonly missingEvidenceCount: number;
  readonly factCount: number;
  readonly measurementCount: number;
  readonly completeMeasurementCount: number;
  readonly issueCount: number;
  readonly geometryRevisionCount: number;
  readonly geometryObjectCount: number;
}

export interface DemoBuildInput {
  readonly definition: DemoProjectDefinition;
  // 键是定义里的 filePath，值是文件字节。定义里声明了路径却没给字节视为错误，
  // 不能悄悄降级成缺失，那会让演示包比实际资料少东西而看不出来。
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly repository: IndexedDbProjectRepository;
  // 详图要声明它画的是哪些构件。构件的稳定键在定义里写不出来（要么随几何生成，
  // 要么在清单里），所以由调用方在建包时按视图解析。
  readonly resolveViewTargets?: (view: DemoDrawingView) => readonly string[];
}

// 只播种项目内容（任务书、资料、事实、问题），不导出，供完整链路继续往下跑。
export async function seedDemoProject(input: DemoBuildInput): Promise<SeededDemoProject> {
  const { definition, files, repository } = input;
  const id = (key: string) => seededUuid(definition.demoId, key);
  const evidenceRef = (key: string) => id(`evidence/${key}`);
  const commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
  const projectId = id("project");
  const buildingId = id("building");
  const actorId = id("actor");
  const at = definition.createdAt;
  const producer = { producerType: "demo" as const, fixtureId: definition.demoId };

  const head = async () => {
    const value = await repository.getProjectHead(projectId);
    if (!value) throw new Error("PROJECT_NOT_FOUND_AFTER_DEMO_COMMAND");
    return value;
  };
  const subjectRef = (subject: string) => (subject === "building" ? buildingId : subject);

  await commands.execute({
    commandType: "CreateProject",
    commandId: id("cmd/create"),
    projectId,
    actorId,
    expectedRevisionId: null,
    issuedAt: at,
    payload: {
      project: {
        id: projectId, name: definition.projectName, status: "active",
        locationText: definition.locationText, createdAt: at,
      },
      building: {
        id: buildingId, projectId, name: definition.buildingName,
        periodText: definition.periodText, addressText: definition.addressText, status: "existing",
      },
    },
  });

  // 资料入库。拿不到原件的资料照样登记为缺失，缺什么要在界面看得见。
  for (const source of definition.sources) {
    const assetId = id(`asset/${source.key}`);
    const evidenceId = evidenceRef(source.key);
    const bytes = source.filePath === null ? null : files.get(source.filePath);
    if (source.filePath !== null && !bytes) throw new Error(`DEMO_SOURCE_FILE_MISSING:${source.filePath}`);
    const asset = AssetRecordSchema.parse({
      id: assetId, projectId, fileName: source.fileName, mimeType: source.mimeType,
      byteLength: bytes?.byteLength ?? 0,
      sha256: sha256Hex(bytes ?? new Uint8Array()),
      contentStatus: bytes ? "available" : "missing", createdAt: at,
    });
    const evidence = EvidenceSchema.parse({
      id: evidenceId, projectId, assetId, evidenceType: source.evidenceType, title: source.title,
      rightsDeclaration: source.rightsDeclaration, intendedUse: source.intendedUse,
      recordedAt: source.recordedAt, relatedEntityRefs: [buildingId],
      dataStatus: bytes ? "available" : "missing",
    });
    const parseRecord = ParseRecordSchema.parse({
      id: id(`parse/${source.key}`), projectId, assetId, evidenceId,
      parser: source.parser, parserVersion: "1.0.0",
      status: bytes ? source.parseStatus : "failed",
      extractedText: bytes ? source.extractedText : null,
      warnings: bytes ? [...source.parseWarnings] : [source.absenceReasonZh ?? "原始文件未随包提供。"],
      createdAt: at,
    });
    const sessionId = id(`staging/${source.key}`);
    // 拿不到原件的资料不进暂存区：暂存区校验的是内容哈希，没有内容就没什么可校验。
    if (bytes) {
      await repository.stageAssets(
        sessionId,
        [asset],
        new Map([[assetId, new Blob([bytes as BlobPart], { type: source.mimeType })]]),
      );
    }
    await commands.execute({
      commandType: "ImportEvidence",
      commandId: id(`cmd/evidence/${source.key}`),
      projectId, actorId, expectedRevisionId: (await head()).revisionId, issuedAt: at,
      payload: { evidence, asset, parseRecord, stagingSessionId: sessionId },
    });
  }

  if (definition.facts.length) {
    await commands.execute({
      commandType: "CommitFacts",
      commandId: id("cmd/facts"),
      projectId, actorId, expectedRevisionId: (await head()).revisionId, issuedAt: at,
      payload: {
        facts: definition.facts.map((fact) => FactEnvelopeSchema.parse({
          id: id(`fact/${fact.key}`),
          subjectRef: subjectRef(fact.subject),
          field: fact.field,
          value: fact.value,
          producer,
          evidenceRefs: fact.evidenceKeys.map(evidenceRef),
          reviewStatus: fact.reviewStatus,
          dataStatus: fact.dataStatus,
        })),
      },
    });
  }

  // 尺寸只作为事实写入，不写测量记录：演示数据不是现场实测，
  // 写成测量记录会让界面把它算进实测条数（质量基准 2.3）。
  // 顺带说明：当前系统没有任何 MeasurementRecord 的写入口，
  // ProjectCommandService 的 measurements 恒为空数组。
  if (definition.measurements.length) {
    await commands.execute({
      commandType: "CommitFacts",
      commandId: id("cmd/measurements"),
      projectId, actorId, expectedRevisionId: (await head()).revisionId, issuedAt: at,
      payload: {
        facts: definition.measurements.map((item) => FactEnvelopeSchema.parse({
          id: id(`measurement-fact/${item.key}`),
          subjectRef: subjectRef(item.subject),
          field: `documentedDimension.${item.quantity.name}`,
          value: { ...item.quantity, methodZh: item.methodZh },
          producer,
          evidenceRefs: [evidenceRef(item.evidenceKey)],
          reviewStatus: "unreviewed",
          dataStatus: item.dataStatus,
        })),
      },
    });
  }

  const requirements = definition.task.artifactRequirements;
  const taskDefinition = TaskDefinitionSchema.parse({
    id: id("task"),
    name: definition.task.name,
    scope: [...definition.task.scope],
    regulationRefs: [...definition.task.regulationRefs],
    deliverables: [...definition.task.deliverables],
    responsibilities: [{ role: "projectLead", actorId }],
    automationPolicyRef: null,
    ...(requirements
      ? {
        artifactRequirements: {
          titleZh: requirements.titleZh,
          revisionLabel: requirements.revisionLabel,
          geometryTargetRoles: [...requirements.geometryTargetRoles],
          sheets: requirements.sheets.map((sheet) => ({ ...sheet, pageMm: [...sheet.pageMm] })),
          views: requirements.views.map((view) => ({
            key: view.key,
            displayLabelZh: view.displayLabelZh,
            drawingRef: view.drawingRef,
            kind: view.kind,
            scaleDenominator: view.scaleDenominator,
            sheetKey: view.sheetKey,
            viewportRectMm: [...view.viewportRectMm],
            direction: [...view.direction],
            right: [...view.right],
            up: [...view.up],
            ...(view.sectionPlane
              ? { sectionPlane: { normal: [...view.sectionPlane.normal], offsetMm: view.sectionPlane.offsetMm } }
              : {}),
            ...(view.cropBoundsMm ? { cropBoundsMm: [...view.cropBoundsMm] } : {}),
            targetStableKeys: [...(input.resolveViewTargets?.(view) ?? [])],
            sourceEvidenceRefs: view.sourceEvidenceKeys.map(evidenceRef),
          })),
        },
      }
      : {}),
    confirmedAt: definition.task.confirmed ? at : null,
  });
  await commands.execute({
    commandType: "ConfirmTaskSetup",
    commandId: id("cmd/task"),
    projectId, actorId, expectedRevisionId: (await head()).revisionId, issuedAt: at,
    payload: { taskDefinition },
  });

  // 阻断项通过规则运行写入，与系统自己跑检查产生的问题走同一条路径。
  if (definition.issues.length) {
    const ruleRunId = id("rule-run");
    await commands.execute({
      commandType: "CommitRuleEvaluation",
      commandId: id("cmd/rules"),
      projectId, actorId, expectedRevisionId: (await head()).revisionId, issuedAt: at,
      payload: {
        ruleRun: {
          id: ruleRunId, projectId, inputRevisionId: (await head()).revisionId,
          ruleSetVersion: "demo-library/1.0", status: "completed",
          producer: { producerType: "rule", ruleRunId },
          results: definition.issues.map((issue) => ({
            ruleId: issue.key,
            outcome: "issue",
            inputRefs: issue.impactEvidenceKeys.map(evidenceRef),
            issueRefs: [id(`issue/${issue.key}`)],
            message: issue.descriptionZh,
          })),
          startedAt: at, completedAt: at,
        },
        issues: definition.issues.map((issue) => IssueSchema.parse({
          id: id(`issue/${issue.key}`),
          projectId,
          issueType: issue.issueType,
          subjectRefs: [buildingId],
          description: issue.descriptionZh,
          sourceRef: ruleRunId,
          status: "open",
          impactRefs: issue.impactEvidenceKeys.map(evidenceRef),
          blocksProxyOutcome: issue.blocksProxyOutcome,
          blocksFormalEligibility: true,
          producer: { producerType: "rule", ruleRunId },
          createdAt: at,
          resolvedAt: null,
        })),
      },
    });
  }

  return { projectId, buildingId, actorId, seededAt: at };
}

// 播种加导出。不跑几何与制图，用于只需要资料与事实的场景与单元测试。
export async function buildDemoProject(input: DemoBuildInput): Promise<DemoBuildResult> {
  const seeded = await seedDemoProject(input);
  return exportDemoProject(input.repository, seeded);
}

export async function exportDemoProject(
  repository: IndexedDbProjectRepository,
  seeded: { projectId: string; buildingId: string },
): Promise<DemoBuildResult> {
  const packageBytes = await new ProjectPackageService(repository).exportZip(seeded.projectId);
  const final = await repository.getProjectHead(seeded.projectId);
  if (!final) throw new Error("PROJECT_NOT_FOUND_AFTER_DEMO_COMMAND");
  return {
    projectId: seeded.projectId,
    buildingId: seeded.buildingId,
    packageBytes,
    packageSha256: sha256Hex(packageBytes),
    evidenceCount: final.snapshot.evidences.length,
    missingEvidenceCount: final.snapshot.evidences.filter((item) => item.dataStatus === "missing").length,
    factCount: final.snapshot.facts.length,
    measurementCount: final.snapshot.measurements.length,
    completeMeasurementCount: final.snapshot.measurements.filter((item) => item.metadataStatus === "complete").length,
    issueCount: final.snapshot.issues.length,
    geometryRevisionCount: final.snapshot.geometryRevisions.length,
    geometryObjectCount: final.snapshot.geometrySpecs.at(-1)?.objects.length ?? 0,
  };
}
