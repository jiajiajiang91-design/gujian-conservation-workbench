import {
  Activity, Archive, Bot, Boxes, Building2, ChevronRight, CircleStop, ClipboardList,
  Download, FileJson, FolderKanban, Images, Link2, PackageOpen, PanelRightClose,
  PanelRightOpen, Play, Plus, Ruler, Search, ShieldCheck, Trash2, Upload, X, FileCheck2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ProjectHead, ProjectSummary } from "@gujian/application";
import type { ArtifactRecord, Decision, ModelRun, RuleRun } from "@gujian/domain";

import type { ModelRunProgress } from "./model-run-client";
import type { CadJobProgress } from "./cad-job-client";
import { GlbViewer } from "./GlbViewer";
import {
  cadJobs, createLocalProject, deliveries, drawingJobs, evidenceIngestion, listLocalProjects, localActorId,
  modelRuns, projectPackages, projectRepository,
  projectCommands, workflow,
} from "./workbench";
import { buildArtifactMatrix } from "./artifact-matrix-builder";
import { commitGeometryFacts } from "./geometry-fact-service";
import { commitDocumentedDimensionChain } from "./document-dimension-service";
import { geometryPrerequisites } from "./geometry-spec-builder";
import {
  buildArtifactSetView,
  buildHumanInterventionView,
  buildModelRunCostView,
  buildProjectDashboardSummary,
  buildProvenanceGraphView,
} from "./query-models";
import {
  compareWithMeasuredFacts, conceptLabel, deriveArchetypeExpectations, resolveVocabulary,
  IndexedDbProjectRepository, ProjectPackageService, openWorkbenchDatabase,
} from "@gujian/infrastructure";
import { ArchetypeSpecSchema, type ArchetypeSpec } from "@gujian/domain";

import { AssistantExecutors, type ModificationProposal } from "./assistant/action-executors";
import { AssistantClient } from "./assistant/assistant-client";
import { ChatPanel } from "./assistant/ChatPanel";
import { runClientOp } from "./assistant/client-op-adapter";
import { buildWorkspaceSnapshot } from "./assistant/workspace-snapshot";

const stages = [
  { id: "tasks", label: "任务要求", icon: ClipboardList },
  { id: "evidence", label: "项目资料" },
  { id: "measurements", label: "测量与尺寸依据", icon: Ruler },
  { id: "objects", label: "对象与构件", icon: Boxes },
  { id: "conditions", label: "现状记录" },
  { id: "issues", label: "问题队列" },
  { id: "geometry", label: "三维模型" },
  { id: "sheetStyle", label: "图纸样式" },
  { id: "drawings", label: "成组图纸" },
  { id: "checks", label: "检查与资格", icon: ShieldCheck },
  { id: "package", label: "代理交付" },
  { id: "candidates", label: "模型运行与费用", icon: Activity },
] as const;
export const LENGTH_INPUT_STEP = "any";
const OBSERVATION_LABELS = {
  visibleCondition: "可见状态", damage: "残损", material: "材料", state: "整体状态",
} as const;
// 界面只出现日常语言：来源、状态一律用中文，不显示英文枚举值
const PRODUCER_LABELS: Record<string, string> = {
  model: "AI 识别", human: "人工确认", rule: "自动核对", demo: "示例资料",
};
const REVIEW_LABELS: Record<string, string> = {
  unreviewed: "待确认", confirmed: "已确认", rejected: "已驳回", superseded: "已被替代",
};
const DATA_STATUS_LABELS: Record<string, string> = {
  available: "可用", unverified: "未核验", missing: "缺失", unknown: "待确认",
};
const BLOCKER_LABELS: Record<string, string> = {
  UNVERIFIED_DIMENSION_CANDIDATES: "尺寸尚未核验",
  MEASUREMENT_METADATA_MISSING: "测量记录缺测量人、时间或方法",
  GEOMETRY_EVIDENCE_FACTS_MISSING: "缺少支撑三维模型的实测数据",
  missingEvidence: "资料不足",
  ruleConflict: "数据对不上",
  professionalUncertainty: "需专业判断",
  highRisk: "存在高风险项",
};
// 恢复检验用的独立数据库，与本机项目库分开，用完即删
const ROUNDTRIP_VERIFY_DB = "gujian-roundtrip-verify";
const PARSE_STATUS_LABELS: Record<string, string> = {
  parsed: "已读取文字内容", failed: "无法自动读取", metadataOnly: "仅登记，未读取内容", pending: "读取中",
};
const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  photo: "照片", document: "文档", drawing: "图纸", measurement: "测量记录", other: "其他",
};
const ISSUE_TYPE_LABELS: Record<string, string> = {
  missingEvidence: "缺资料", professionalUncertainty: "需专业判断",
  ruleConflict: "数据对不上", highRisk: "高风险",
};
const LIFT_RATIO_SET_LABELS: Record<string, string> = {
  "qing-gongcheng-zuofa": "清工程做法举架系数",
  "liang-drawings": "梁思成图纸举架系数",
};
const DRAWING_KIND_LABELS: Record<string, string> = {
  floorPlan: "平面", roofPlan: "屋顶平面", elevation: "立面",
  transverseSection: "横剖", longitudinalSection: "纵剖", axonometric: "轴测", detail: "详图",
};
type StageId = typeof stages[number]["id"];

interface ServerStatus {
  ready: boolean;
  model: string;
  modelConfigured: boolean;
}

interface RoundTripReceipt {
  jsonSha256: string;
  jsonBytes: number;
  jsonEvidenceCount: number;
  jsonMissingAssetCount: number;
  zipSha256: string;
  zipBytes: number;
  projectId: string;
  sourceRevisionId: string;
  importedRevisionId: string;
  evidenceCount: number;
  ruleRunCount: number;
  decisionCount: number;
  geometryRevisionCount: number;
  artifactCount: number;
  checkRunCount: number;
  deliveryCount: number;
}

export function App() {
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectHead | null>(null);
  const [projectModelRuns, setProjectModelRuns] = useState<readonly ModelRun[]>([]);
  const [projectRuleRuns, setProjectRuleRuns] = useState<readonly RuleRun[]>([]);
  const [projectDecisions, setProjectDecisions] = useState<readonly Decision[]>([]);
  const [projectArtifacts, setProjectArtifacts] = useState<readonly ArtifactRecord[]>([]);
  const [projectCheckRuns, setProjectCheckRuns] = useState<readonly import("@gujian/domain").CheckRun[]>([]);
  const [projectDeliveryEvaluations, setProjectDeliveryEvaluations] = useState<readonly import("@gujian/domain").DeliveryEvaluation[]>([]);
  const [projectDeliveries, setProjectDeliveries] = useState<readonly import("@gujian/domain").DeliveryDraft[]>([]);
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({});
  const [activeStage, setActiveStage] = useState<StageId>("evidence");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelRunProgress | null>(null);
  const [cadProgress, setCadProgress] = useState<CadJobProgress | null>(null);
  const [drawingProgress, setDrawingProgress] = useState<string | null>(null);
  const [geometryBlob, setGeometryBlob] = useState<Blob | null>(null);
  const [selectedGeometryEntityId, setSelectedGeometryEntityId] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [roundTripReceipt, setRoundTripReceipt] = useState<RoundTripReceipt | null>(null);
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  const [pendingProposal, setPendingProposal] = useState<ModificationProposal | null>(null);
  const [projectArchetypes, setProjectArchetypes] = useState<readonly ArchetypeSpec[]>([]);
  const assistantChatClient = useMemo(() => new AssistantClient(), []);
  const vocabulary = useMemo(() => resolveVocabulary(), []);
  const typeLabel = (componentType: string, conceptRef?: string) =>
    conceptLabel(vocabulary, conceptRef ?? componentType) ?? componentType;
  const assistantExecutors = useMemo(
    () => new AssistantExecutors({ commands: projectCommands, workflow, actorId: localActorId }),
    [],
  );
  const [drawingPreviewUrls, setDrawingPreviewUrls] = useState<readonly { id: string; kind: "svg" | "pdf"; label: string; url: string }[]>([]);
  // 证据半区（05 界面与交互形态 §三）：中栏右半区显示选中资料原件，数据与证据并置
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<{ evidenceId: string; url: string; mimeType: string; fileName: string } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const evidenceInput = useRef<HTMLInputElement>(null);

  const refresh = async () => setProjects(await listLocalProjects());
  const loadProject = async (projectId: string) => {
    setRoundTripReceipt(null);
    setError(null);
    const head = await projectRepository.getProjectHead(projectId);
    const [runs, rules, decisions, artifacts, checks, deliveryEvaluations, deliveryRecords] = await Promise.all([
      projectRepository.getProjectModelRuns(projectId),
      projectRepository.getProjectRuleRuns(projectId),
      projectRepository.getProjectDecisions(projectId),
      projectRepository.getProjectArtifacts(projectId),
      projectRepository.getProjectCheckRuns(projectId),
      projectRepository.getProjectDeliveryEvaluations(projectId),
      projectRepository.getProjectDeliveries(projectId),
    ]);
    setSelected(head);
    setProjectModelRuns(runs);
    setProjectRuleRuns(rules);
    setProjectDecisions(decisions);
    setProjectArtifacts(artifacts);
    setProjectCheckRuns(checks);
    setProjectDeliveryEvaluations(deliveryEvaluations);
    setProjectDeliveries(deliveryRecords);
    setProjectArchetypes(await projectRepository.getProjectArchetypeSpecs(projectId));
  };

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(String(reason)));
    void fetch("/api/status")
      .then(async (response) => response.ok ? response.json() as Promise<ServerStatus> : Promise.reject(new Error("SERVER_STATUS_FAILED")))
      .then(setServerStatus)
      .catch(() => setServerStatus(null));
  }, []);

  const filtered = useMemo(
    () => projects.filter((project) => `${project.name}${project.buildingName}`.toLowerCase().includes(query.toLowerCase())),
    [projects, query],
  );
  const parsedEvidenceCount = selected?.snapshot.parseRecords.filter((record) => record.status === "parsed" && record.extractedText?.trim()).length ?? 0;
  const modelRunning = modelProgress && !["succeeded", "failed", "cancelled"].includes(modelProgress.phase);
  const confirmedTask = selected?.snapshot.taskDefinitions.find((task) => task.confirmedAt !== null) ?? null;
  const openIssues = selected?.snapshot.issues.filter((issue) => issue.status === "open") ?? [];
  const geometryRevision = selected?.snapshot.geometryRevisions.at(-1) ?? null;
  // 已有版本时取其绑定的 spec；否则取项目包导入的最新 spec（existingGeometrySpec 首次生成路径）
  const geometrySpec = selected
    ? (geometryRevision
      ? selected.snapshot.geometrySpecs.find((item) => item.id === geometryRevision.geometrySpecId) ?? null
      : selected.snapshot.geometrySpecs.at(-1) ?? null)
    : null;
  const selectedGeometryEntity = geometrySpec?.objects.find((item) => item.id === selectedGeometryEntityId) ?? null;
  const latestCheckRun = projectCheckRuns
    .filter((item) => item.geometryRevisionId === geometryRevision?.id)
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
    .at(-1) ?? null;
  const latestCheckedArtifactIds = new Set(latestCheckRun?.artifactRefs ?? []);
  const drawingArtifacts = projectArtifacts.filter((item) => item.geometryRevisionId === geometryRevision?.id && latestCheckedArtifactIds.has(item.id));
  const latestDeliveryEvaluationIds = new Set(projectDeliveryEvaluations
    .filter((item) => item.geometryRevisionId === geometryRevision?.id && latestCheckRun && item.checkRunRefs.includes(latestCheckRun.id))
    .map((item) => item.id));
  const latestDelivery = projectDeliveries
    .filter((item) => item.geometryRevisionId === geometryRevision?.id && latestDeliveryEvaluationIds.has(item.evaluationId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1) ?? null;
  const latestBlockedDelivery = projectDeliveryEvaluations
    .filter((item) => item.outcome === "blocked")
    .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt))
    .at(-1) ?? null;
  // 项目自带 GeometrySpec 时走 existingGeometrySpec 重绑路径，不要求逐构件事实
  const geometryGate = selected
    ? (selected.snapshot.geometrySpecs.length ? { ready: true, missing: [] as string[] } : geometryPrerequisites(selected))
    : null;
  const readModelInput = selected ? {
    head: selected,
    modelRuns: projectModelRuns,
    ruleRuns: projectRuleRuns,
    decisions: projectDecisions,
    artifacts: projectArtifacts,
    checks: projectCheckRuns,
    evaluations: projectDeliveryEvaluations,
    deliveries: projectDeliveries,
  } : null;
  const dashboard = readModelInput ? buildProjectDashboardSummary(readModelInput) : null;
  const artifactSetView = readModelInput ? buildArtifactSetView(readModelInput) : null;
  const modelCostView = buildModelRunCostView(projectModelRuns);
  const humanInterventions = readModelInput ? buildHumanInterventionView(readModelInput) : null;
  const provenance = readModelInput ? buildProvenanceGraphView(readModelInput, selectedGeometryEntity) : null;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!geometryRevision) return setGeometryBlob(null);
      const glb = geometryRevision.assets.find((asset) => asset.kind === "glb");
      if (!glb) return setGeometryBlob(null);
      const stored = await projectRepository.getAsset(glb.assetId);
      if (!cancelled) setGeometryBlob(stored.content);
    };
    void load().catch(() => setGeometryBlob(null));
    return () => { cancelled = true; };
  }, [geometryRevision?.id]);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const load = async () => {
      const previewArtifacts = drawingArtifacts.filter((artifact): artifact is ArtifactRecord & { kind: "svg" | "pdf" } => artifact.kind === "svg" || artifact.kind === "pdf");
      const resolved = await Promise.all(previewArtifacts.slice(0, 6).map(async (artifact) => {
        const stored = await projectRepository.getAsset(artifact.assetId);
        const url = URL.createObjectURL(stored.content);
        urls.push(url);
        return { id: artifact.id, kind: artifact.kind, label: artifact.fileName, url };
      }));
      if (!cancelled) setDrawingPreviewUrls(resolved);
    };
    void load().catch(() => setDrawingPreviewUrls([]));
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [drawingArtifacts.map((artifact) => artifact.id).join("|")]);

  // 选中资料后读取原件生成预览地址；切换或卸载时释放
  useEffect(() => {
    if (!activeEvidenceId) { setEvidencePreview(null); return; }
    let cancelled = false;
    let created: string | null = null;
    const evidence = selected?.snapshot.evidences.find((item) => item.id === activeEvidenceId);
    const load = async () => {
      if (!evidence) return;
      const stored = await projectRepository.getAsset(evidence.assetId);
      if (cancelled) return;
      created = URL.createObjectURL(stored.content);
      setEvidencePreview({ evidenceId: evidence.id, url: created, mimeType: stored.record.mimeType, fileName: stored.record.fileName });
    };
    void load().catch(() => setEvidencePreview(null));
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [activeEvidenceId, selected?.projectId]);

  const chooseProject = async (projectId: string) => {
    setError(null);
    setModelProgress(null);
    setActiveEvidenceId(null);
    await loadProject(projectId);
  };

  const generateDemoGeometry = async () => {
    if (!selected) return;
    setError(null);
    setCadProgress(null);
    try {
      const outcome = await cadJobs.startGeometry(
        selected,
        localActorId(),
        setCadProgress,
        geometrySpec ? { mode: "existingGeometrySpec", geometrySpecId: geometrySpec.id } : { mode: "derivedFromFacts" },
      );
      setSelected(outcome.head);
      await refresh();
      setNotice("三维模型已生成。成果尚未经专业复核签发，不能用于正式交付");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "几何作业失败");
    }
  };

  const confirmGeometryFacts = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    try {
      const head = await commitGeometryFacts({
        head: selected, actorId: localActorId(), repository: projectRepository, commands: projectCommands,
        values: {
          components: JSON.parse(String(data.get("geometryComponents") ?? "[]")),
          interfaces: JSON.parse(String(data.get("geometryInterfaces") ?? "[]")),
        },
      });
      setSelected(head); await refresh(); setNotice("控制尺寸已作为人工确认事实写入；来源仍指向当前项目资料");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "控制尺寸确认失败"); }
  };

  const generateDrawings = async () => {
    if (!selected || !geometryRevision || !geometrySpec) return;
    setError(null); setDrawingProgress("queued");
    try {
      const matrix = buildArtifactMatrix(selected, geometryRevision, geometrySpec);
      const outcome = await drawingJobs.generate(selected, localActorId(), geometryRevision, matrix, setDrawingProgress);
      setSelected(outcome.head); await loadProject(selected.projectId); await refresh(); setNotice("成组图纸已生成，各图与同一版三维模型一致");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "图纸作业失败"); }
  };

  const createProxyDelivery = async () => {
    if (!selected || !geometryRevision || !latestCheckRun || !drawingArtifacts.length) return;
    setError(null);
    try {
      const outcome = await deliveries.createProxyDraft(selected, localActorId(), geometryRevision, drawingArtifacts, latestCheckRun);
      setSelected(outcome.head); await loadProject(selected.projectId); await refresh(); setNotice("交付草案已建立。尚未签发，不能用于正式交付或施工");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "代理交付草案建立失败"); }
  };

  const recordBlockedDelivery = async () => {
    if (!selected) return;
    setError(null);
    try {
      await deliveries.recordBlockedEvaluation(selected, localActorId());
      await loadProject(selected.projectId);
      await refresh();
      setNotice("已记录本次无法正式交付的原因。系统没有生成空成果，也没有用默认数据补齐");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "记录失败"); }
  };

  const downloadArtifact = async (artifact: ArtifactRecord) => {
    const asset = await projectRepository.getAsset(artifact.assetId);
    const url = URL.createObjectURL(asset.content);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.fileName; anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const head = await createLocalProject({
        name: String(data.get("name") ?? "").trim(),
        buildingName: String(data.get("buildingName") ?? "").trim(),
        locationText: String(data.get("locationText") ?? "").trim(),
      });
      await refresh();
      const evaluated = await workflow.evaluate(head, localActorId());
      setSelected(evaluated);
      setProjectModelRuns([]);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(head.projectId));
      setProjectDecisions([]);
      setProjectArtifacts([]); setProjectCheckRuns([]); setProjectDeliveryEvaluations([]); setProjectDeliveries([]);
      setActiveStage("evidence");
      setShowCreate(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败");
    }
  };

  const downloadProject = async (type: "json" | "zip") => {
    if (!selected) return;
    const bytes = type === "json"
      ? await projectPackages.exportJson(selected.projectId)
      : await projectPackages.exportZip(selected.projectId);
    const blob = new Blob([bytes as BlobPart], { type: type === "json" ? "application/json" : "application/zip" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.snapshot.project.name}.${type === "json" ? "project.json" : "gujian.zip"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出 ${type.toUpperCase()} 项目包`);
  };

  const buildAssistantSnapshot = () => buildWorkspaceSnapshot({
    projectId: selected?.projectId ?? null,
    currentStage: activeStage,
    openIssueCount: openIssues.length,
    entityCount: geometrySpec?.objects.length ?? selected?.snapshot.entities.length ?? 0,
    geometryRevisionCount: selected?.snapshot.geometryRevisions.length ?? 0,
    artifactCount: projectArtifacts.length,
    deliveryCount: projectDeliveries.length,
    serverModelConfigured: serverStatus?.modelConfigured ?? false,
    unparsedEvidenceCount: Math.max(0, (selected?.snapshot.evidences.length ?? 0) - parsedEvidenceCount),
  });

  const handleAssistantClientOp = (input: { clientOp: string; actionName: string; args: unknown }) => runClientOp({
    executors: assistantExecutors,
    getHead: () => selected,
    getOpenDockItems: () => openIssues.length,
    knownRefs: () => [
      ...(geometrySpec?.objects.flatMap((object) => [object.stableKey, object.displayNameZh]) ?? []),
      ...(selected?.snapshot.entities.map((entity) => entity.name) ?? []),
    ],
    measurements: () => (selected?.snapshot.measurements ?? [])
      .filter((measurement) => measurement.quantity.normalizedUnit === "mm")
      .map((measurement) => ({
        part: measurement.subjectRef,
        valueMm: Number(measurement.quantity.normalizedValue),
        measured: measurement.metadataStatus === "complete",
      })),
    switchStage: (stageId) => {
      if (stages.some((stage) => stage.id === stageId)) setActiveStage(stageId as StageId);
    },
    advanceStage: () => {
      const index = stages.findIndex((stage) => stage.id === activeStage);
      const next = stages[index + 1];
      if (!next) return null;
      setActiveStage(next.id);
      return next.label;
    },
    jobProgressSummary: () => {
      const lines = [
        modelProgress && "助手正在识别资料",
        cadProgress && "正在生成三维模型",
        drawingProgress && `图纸作业：${drawingProgress}`,
      ].filter(Boolean);
      return lines.length ? lines.join("；") : "当前没有进行中的作业";
    },
    startGeometryJob: async () => { await generateDemoGeometry(); },
    startDrawingJob: async () => { await generateDrawings(); },
    startModelJob: async () => { await runModel(); },
    exportPackage: async (format) => { await downloadProject(format === "json" ? "json" : "zip"); },
    runDataCheck: async () => {
      if (!selected) return;
      await assistantExecutors.runDataCheck(selected);
      await loadProject(selected.projectId);
    },
    presentProposal: setPendingProposal,
  }, input);

  const registerArchetype = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const splitDims = (name: string) => String(data.get(name) ?? "").split(/[，,\s]+/).filter(Boolean);
    try {
      const commandId = crypto.randomUUID();
      const archetypeSpec = ArchetypeSpecSchema.parse({
        id: crypto.randomUUID(),
        projectId: selected.projectId,
        buildingRef: selected.snapshot.buildings[0]!.id,
        baseParams: { D: String(data.get("baseD") ?? "300") },
        bayDimensions: [
          { direction: "x", valuesMm: splitDims("bayX") },
          { direction: "y", valuesMm: splitDims("bayY") },
        ],
        liftRatioSetRef: String(data.get("liftRatioSetRef") || "qing-gongcheng-zuofa"),
        stepCount: Number(data.get("stepCount")),
        pillarNet: String(data.get("pillarNet") ?? "").trim(),
        fangNet: String(data.get("fangNet") ?? "").trim() || null,
        sourceDeclaration: String(data.get("sourceDeclaration") ?? "").trim() || "形制判断，来源未注明",
        producer: { producerType: "human", actorId: localActorId(), actionRef: { commandId } },
        createdAt: new Date().toISOString(),
      });
      await projectCommands.execute({
        commandType: "CommitArchetypeSpec", commandId, projectId: selected.projectId, actorId: localActorId(),
        expectedRevisionId: selected.revisionId, issuedAt: archetypeSpec.createdAt,
        payload: { archetypeSpec },
      });
      // 应然值派生留痕：派生结果作为规则运行记录（producer=rule），含计算值、容差与出处
      const afterSpec = await projectRepository.getProjectHead(selected.projectId);
      const derivation = deriveArchetypeExpectations(archetypeSpec);
      const ruleRunId = crypto.randomUUID();
      const derivedAt = new Date().toISOString();
      await projectCommands.execute({
        commandType: "CommitRuleEvaluation", commandId: crypto.randomUUID(), projectId: selected.projectId,
        actorId: localActorId(), expectedRevisionId: afterSpec!.revisionId, issuedAt: derivedAt,
        payload: {
          ruleRun: {
            id: ruleRunId, projectId: selected.projectId, inputRevisionId: afterSpec!.revisionId,
            ruleSetVersion: derivation.ruleSetVersion, status: "completed",
            producer: { producerType: "rule", ruleRunId },
            results: derivation.expected.map((item) => ({
              ruleId: `archetype-expected-${item.dimension}`,
              outcome: "passed" as const,
              inputRefs: [archetypeSpec.id],
              issueRefs: [],
              message: item.status === "computed"
                ? `应然 ${item.dimension} ${item.valueMm} mm（不覆盖实测，不作正式标注依据）`
                : `应然 ${item.dimension} 按实计，无实测记录时保持未知`,
              ...(item.valueMm !== null ? { computedValueText: `${item.valueMm} mm` } : {}),
              ...(item.toleranceText ? { toleranceText: item.toleranceText } : {}),
              sourceText: item.sourceText,
            })),
            startedAt: derivedAt, completedAt: derivedAt,
          },
          issues: [],
        },
      });
      await loadProject(selected.projectId);
      setNotice("形制模板已登记，应然值派生完成并入规则运行记录");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "形制模板登记失败");
    }
  };

  const adoptProposal = async () => {
    if (!selected || !pendingProposal) return;
    try {
      await assistantExecutors.commitConfirmedModification(selected, pendingProposal);
      setPendingProposal(null);
      await loadProject(selected.projectId);
      setNotice("修改建议已确认生效");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "修改建议生效失败");
    }
  };

  const importProject = async (file: File) => {
    setError(null);
    try {
      const projectId = await projectPackages.import(new Uint8Array(await file.arrayBuffer()), file.name, localActorId());
      await refresh();
      await loadProject(projectId);
      setActiveStage("evidence");
      setNotice("项目包已校验并导入本地库");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目包导入失败");
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };

  const clearLibrary = async () => {
    if (!window.confirm("清空本地项目库？请先导出需要保留的项目包。")) return;
    await projectRepository.clearAllData();
    setSelected(null);
    setProjectModelRuns([]);
    setProjectRuleRuns([]);
    setProjectDecisions([]);
    setProjectArtifacts([]); setProjectCheckRuns([]); setProjectDeliveries([]);
    await refresh();
    setNotice("本机项目已清空");
  };

  const verifyEmptyLibraryRoundTrip = async () => {
    if (!selected) return;
    setError(null);
    setRoundTripReceipt(null);
    let verifyDatabase: IDBDatabase | null = null;
    const expected = {
      projectId: selected.projectId,
      revisionId: selected.revisionId,
      evidenceIds: selected.snapshot.evidences.map((item) => item.id).sort(),
      assetIds: selected.snapshot.evidences.map((item) => item.assetId).sort(),
      geometryRevisionIds: selected.snapshot.geometryRevisions.map((item) => item.id).sort(),
      artifactIds: projectArtifacts.map((item) => item.id).sort(),
      checkRunIds: projectCheckRuns.map((item) => item.id).sort(),
      deliveryIds: projectDeliveries.map((item) => item.id).sort(),
    };
    try {
      const [jsonBytes, zipBytes] = await Promise.all([
        projectPackages.exportJson(selected.projectId),
        projectPackages.exportZip(selected.projectId),
      ]);
      const sha256 = async (bytes: Uint8Array) => {
        const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      };
      const [jsonSha256, zipSha256] = await Promise.all([sha256(jsonBytes), sha256(zipBytes)]);
      // JSON is validated without mutating the source library. Only the ZIP
      // path performs the destructive empty-library round trip.
      const parsedJson = projectPackages.parseWithContents(jsonBytes, "roundtrip.project.json");
      const jsonData = parsedJson.data;
      const jsonMissingAssetCount = jsonData.assets.filter((asset) => asset.contentStatus === "missing").length;
      if (
        jsonData.snapshot.project.id !== expected.projectId
        || jsonData.sourceRevision.id !== expected.revisionId
        || jsonData.snapshot.evidences.length !== expected.evidenceIds.length
        || jsonMissingAssetCount !== jsonData.assets.length
        || parsedJson.contents.size !== 0
      ) {
        throw new Error("JSON_ROUNDTRIP_IDENTITY_MISMATCH");
      }

      const parsedZip = projectPackages.parseWithContents(zipBytes, "roundtrip.gujian.zip");
      if (
        parsedZip.data.snapshot.project.id !== expected.projectId
        || parsedZip.contents.size !== parsedZip.data.assets.length
      ) {
        throw new Error("ZIP_ROUNDTRIP_ASSET_CONTENT_MISSING");
      }

      // 恢复检验在独立数据库进行，本机项目库全程只读，不受影响
      verifyDatabase = await openWorkbenchDatabase(ROUNDTRIP_VERIFY_DB);
      const verifyRepository = new IndexedDbProjectRepository(verifyDatabase);
      const verifyPackages = new ProjectPackageService(verifyRepository);
      const importedProjectId = await verifyPackages.import(zipBytes, "roundtrip.gujian.zip", localActorId());
      const importedHead = await verifyRepository.getProjectHead(importedProjectId);
      if (!importedHead) throw new Error("ROUNDTRIP_PROJECT_MISSING");
      const importedEvidenceIds = importedHead.snapshot.evidences.map((item) => item.id).sort();
      const importedAssetIds = importedHead.snapshot.evidences.map((item) => item.assetId).sort();
      const importedArtifacts = await verifyRepository.getProjectArtifacts(importedProjectId);
      const importedChecks = await verifyRepository.getProjectCheckRuns(importedProjectId);
      const importedDeliveries = await verifyRepository.getProjectDeliveries(importedProjectId);
      if (
        importedHead.projectId !== expected.projectId
        || !importedHead.snapshot.adoptedRecordRefs.some((ref) => ref.startsWith("revision:"))
        || JSON.stringify(importedEvidenceIds) !== JSON.stringify(expected.evidenceIds)
        || JSON.stringify(importedAssetIds) !== JSON.stringify(expected.assetIds)
        || JSON.stringify(importedHead.snapshot.geometryRevisions.map((item) => item.id).sort()) !== JSON.stringify(expected.geometryRevisionIds)
        || JSON.stringify(importedArtifacts.map((item) => item.id).sort()) !== JSON.stringify(expected.artifactIds)
        || JSON.stringify(importedChecks.map((item) => item.id).sort()) !== JSON.stringify(expected.checkRunIds)
        || JSON.stringify(importedDeliveries.map((item) => item.id).sort()) !== JSON.stringify(expected.deliveryIds)
      ) {
        throw new Error("ROUNDTRIP_IDENTITY_MISMATCH");
      }
      const [rules, decisions] = await Promise.all([
        verifyRepository.getProjectRuleRuns(importedProjectId),
        verifyRepository.getProjectDecisions(importedProjectId),
      ]);
      const importedAssets = await verifyRepository.getProjectAssets(importedProjectId);
      if (importedAssets.some(({ record, content }) => record.contentStatus !== "available" || content === null)) {
        throw new Error("ZIP_ROUNDTRIP_ASSET_CONTENT_MISSING");
      }
      setRoundTripReceipt({
        jsonSha256,
        jsonBytes: jsonBytes.byteLength,
        jsonEvidenceCount: jsonData.snapshot.evidences.length,
        jsonMissingAssetCount,
        zipSha256,
        zipBytes: zipBytes.byteLength,
        projectId: importedProjectId,
        sourceRevisionId: expected.revisionId,
        importedRevisionId: importedHead.revisionId,
        evidenceCount: importedHead.snapshot.evidences.length,
        ruleRunCount: rules.length,
        decisionCount: decisions.length,
        geometryRevisionCount: importedHead.snapshot.geometryRevisions.length,
        artifactCount: importedArtifacts.length,
        checkRunCount: importedChecks.length,
        deliveryCount: importedDeliveries.length,
      });
      setNotice("检验通过：导出的项目在独立环境中完整恢复，本机项目未改动");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出与恢复检验未通过");
    } finally {
      // 验证库用完即删，失败路径同样清理，不留残库
      verifyDatabase?.close();
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(ROUNDTRIP_VERIFY_DB);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
  };

  const uploadEvidenceFiles = async (files: readonly File[]) => {
    if (!selected) return;
    setError(null);
    try {
      let current = selected;
      for (const file of files) {
        const updated = await evidenceIngestion.ingest(current, localActorId(), file);
        current = await workflow.evaluate(updated, localActorId());
      }
      setSelected(current);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(current.projectId));
      await refresh();
      setNotice(files.length === 1
        ? `资料“${files[0]!.name}”已保存并建立来源关系`
        : `${files.length} 份原始资料已保存并逐份建立来源关系`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资料上传失败");
    } finally {
      if (evidenceInput.current) evidenceInput.current.value = "";
    }
  };

  const downloadEvidence = async (assetId: string) => {
    const asset = await projectRepository.getAsset(assetId);
    const url = URL.createObjectURL(asset.content);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = asset.record.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const runModel = async () => {
    if (!selected) return;
    setError(null);
    setModelProgress(null);
    try {
      const outcome = await modelRuns.runEvidenceSummary(selected, localActorId(), setModelProgress);
      const evaluated = await workflow.evaluate(outcome.head, localActorId());
      setSelected(evaluated);
      setProjectModelRuns(await projectRepository.getProjectModelRuns(selected.projectId));
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(selected.projectId));
      setActiveStage("candidates");
      setNotice(outcome.candidate ? "助手已给出识别结果，请在待确认区逐条核对" : "本次识别没有产生可用结果");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型运行失败");
    }
  };

  const confirmTaskSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const split = (value: FormDataEntryValue | null) => String(value ?? "").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean);
    try {
      const updated = await workflow.confirmTaskSetup(selected, localActorId(), {
        taskName: String(data.get("taskName") ?? "").trim(),
        scope: split(data.get("scope")),
        regulationRefs: split(data.get("regulations")),
        deliverables: split(data.get("deliverables")),
        artifactRequirements: {
          titleZh: String(data.get("drawingTitle") ?? "").trim(),
          revisionLabel: String(data.get("drawingRevision") ?? "").trim(),
          geometryTargetRoles: split(data.get("geometryTargetRoles")),
          sheets: JSON.parse(String(data.get("drawingSheets") ?? "[]")),
          views: JSON.parse(String(data.get("drawingViews") ?? "[]")),
        },
      });
      setSelected(updated);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(selected.projectId));
      await refresh();
      setNotice("任务范围、规范和责任角色已一次确认");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务设置失败");
    }
  };

  const replaceTaskSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !confirmedTask) return;
    const data = new FormData(event.currentTarget);
    const split = (value: FormDataEntryValue | null) => String(value ?? "").split(/[，\n]/).map((item) => item.trim()).filter(Boolean);
    try {
      const updated = await workflow.replaceTaskDefinition(selected, localActorId(), {
        taskName: String(data.get("taskName") ?? "").trim(),
        scope: split(data.get("scope")),
        regulationRefs: split(data.get("regulations")),
        deliverables: split(data.get("deliverables")),
        artifactRequirements: {
          titleZh: String(data.get("drawingTitle") ?? "").trim(),
          revisionLabel: String(data.get("drawingRevision") ?? "").trim(),
          geometryTargetRoles: split(data.get("geometryTargetRoles")),
          sheets: JSON.parse(String(data.get("drawingSheets") ?? "[]")),
          views: JSON.parse(String(data.get("drawingViews") ?? "[]")),
        },
      });
      setSelected(updated);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(selected.projectId));
      await refresh();
      setNotice("任务成果要求已建立新版本；旧任务定义保留在审计链中。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "任务成果要求更新失败"); }
  };

  const decideCandidate = async (issueId: string, candidateId: string, outcome: "accepted" | "rejected") => {
    if (!selected) return;
    const typedReason = decisionReasons[issueId]?.trim() ?? "";
    if (outcome === "rejected" && !typedReason) {
      setError("驳回候选时需要填写理由");
      return;
    }
    try {
      const updated = await workflow.decideCandidate(selected, localActorId(), {
        candidateId,
        issueId,
        outcome,
        reason: outcome === "accepted"
          ? "接受为已核对的模型候选；不转为现场实测或正式事实。"
          : typedReason,
      });
      setSelected(updated);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(selected.projectId));
      setProjectDecisions(await projectRepository.getProjectDecisions(selected.projectId));
      setDecisionReasons((current) => ({ ...current, [issueId]: "" }));
      await refresh();
      setNotice(outcome === "accepted" ? "候选已接受，仍保持模型来源" : "候选已驳回并记录理由");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "候选处理失败");
    }
  };

  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const decideIssueOption = async (issueId: string, outcome: "accepted" | "rejected") => {
    if (!selected) return;
    const selectedOptionId = selectedOptions[issueId] ?? null;
    const typedReason = decisionReasons[issueId]?.trim() ?? "";
    if (outcome === "accepted" && !selectedOptionId) {
      setError("请先选择一个方案再确认");
      return;
    }
    if (outcome === "rejected" && !typedReason) {
      setError("暂不选择时需要填写理由");
      return;
    }
    try {
      const updated = await workflow.decideIssueOption(selected, localActorId(), {
        issueId, outcome, selectedOptionId, reason: typedReason || null,
      });
      setSelected(updated);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(selected.projectId));
      setProjectDecisions(await projectRepository.getProjectDecisions(selected.projectId));
      setDecisionReasons((current) => ({ ...current, [issueId]: "" }));
      setNotice(outcome === "accepted" ? "方案已选定并记录出处，问题关闭" : "已记录暂不选择的理由");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "方案决定失败");
    }
  };

  // 现状记录（05 表 2）：人工判断必须绑定资料，无证据不允许记录
  const recordObservation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const evidenceRef = String(data.get("evidenceRef") ?? "").trim();
    if (!evidenceRef) { setError("现状记录必须指向一份项目资料"); return; }
    const commandId = crypto.randomUUID();
    try {
      await projectCommands.execute({
        commandType: "CommitObservations",
        commandId, projectId: selected.projectId, actorId: localActorId(),
        expectedRevisionId: selected.revisionId, issuedAt: new Date().toISOString(),
        payload: { observations: [{
          id: crypto.randomUUID(),
          subjectRef: String(data.get("subjectRef") ?? "").trim() || selected.snapshot.buildings[0]!.id,
          observationType: String(data.get("observationType") ?? "visibleCondition") as "visibleCondition" | "material" | "damage" | "state",
          text: String(data.get("text") ?? "").trim(),
          producer: { producerType: "human", actorId: localActorId(), actionRef: { commandId } },
          evidenceRefs: [evidenceRef],
          dataStatus: "available",
        }] },
      });
      const head = await projectRepository.getProjectHead(selected.projectId);
      if (head) setSelected(await workflow.evaluate(head, localActorId()));
      form.reset();
      setNotice("现状记录已写入当前版本，来源指向所选资料");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "现状记录写入失败");
    }
  };

  const confirmDocumentedDimensionChain = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const segmentWidthsMm = String(data.get("segmentWidthsMm") ?? "")
      .split(/[，,\s]+/).map(Number).filter((value) => Number.isFinite(value));
    try {
      const committed = await commitDocumentedDimensionChain({
        head: selected, actorId: localActorId(), repository: projectRepository, commands: projectCommands,
        totalWidthMm: Number(data.get("totalWidthMm")), segmentWidthsMm,
        measurementMetadataComplete: data.get("measurementMetadataComplete") === "on",
        evidenceRefs: selected.snapshot.evidences.map((item) => item.id),
      });
      const evaluated = await workflow.evaluate(committed, localActorId());
      setSelected(evaluated);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(selected.projectId));
      await refresh();
      setNotice("文档尺寸链已转写，规则已自动核对差值和测量元数据");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "尺寸链转写失败");
    }
  };

  // 应然与实测超容差的差异即现状记录候选（架构 v1.4 §5.7）
  const archetypeDifferences = (() => {
    const archetype = projectArchetypes.at(-1);
    if (!archetype || !selected) return [];
    return compareWithMeasuredFacts(deriveArchetypeExpectations(archetype), selected.snapshot.facts)
      .filter((item) => item.withinTolerance === false);
  })();

  // 引用一律显示资料名称，不显示内部编号
  const evidenceTitle = (ref: string) => {
    const evidence = selected?.snapshot.evidences.find((item) => item.id === ref || ref.endsWith(item.id));
    return evidence?.title ?? "关联资料";
  };
  // 字段名转成测绘人员熟悉的说法
  const factFieldLabel = (field: string) => {
    const named: Record<string, string> = {
      "documentedDimension.totalWidthMm": "资料记载总尺寸",
      "documentedDimension.segmentWidthsMm": "资料记载分段尺寸",
      "documentedDimension.measurementMetadataComplete": "测量记录完整性",
      "roofFrame.totalDepthMm": "通进深",
      "roofFrame.stepCount": "步架数",
    };
    if (named[field]) return named[field];
    const measured = field.match(/^archetype\.measured\.(.+)$/);
    if (measured) return `${measured[1]}（实测）`;
    return field;
  };

  // 数据来源构成（05 表 7）：实测依据、AI 推测、人工确认分别可见
  const basisCounts = (() => {
    const counts = { model: 0, human: 0, rule: 0, demo: 0 };
    for (const fact of selected?.snapshot.facts ?? []) {
      const type = fact.producer.producerType as keyof typeof counts;
      if (type in counts) counts[type] += 1;
    }
    return counts;
  })();

  // 当前状态条（05 表 3）：说明系统正在做什么与进度，不用静态文案顶替
  const currentStatusText = (() => {
    if (!selected) return "选中项目后，可在这里对助手下达操作指令。";
    if (modelRunning && modelProgress) return "助手正在识别资料，稍后给出结果";
    if (cadProgress && !["succeeded", "failed", "cancelled"].includes(cadProgress.phase)) return "正在生成三维模型";
    const openCount = dashboard?.openIssueCount ?? 0;
    if (openCount > 0) return `有 ${openCount} 项等你处理，其余部分照常推进`;
    return `当前在${stages.find((item) => item.id === activeStage)?.label ?? "工作区"}，没有需要你处理的事项`;
  })();

  // 待办（05 图 1 左栏）：按原因分条列出，不合并成一个数字
  const pendingItems = (() => {
    const open = selected?.snapshot.issues.filter((issue) => issue.status === "open") ?? [];
    const groups: { label: string; count: number; hint: string; stage: StageId }[] = [
      { label: "存疑构件", count: open.filter((i) => i.issueType === "professionalUncertainty").length, hint: "非唯一专业选择，需要人工判断", stage: "issues" },
      { label: "缺现场事实", count: open.filter((i) => i.issueType === "missingEvidence").length, hint: "补资料或补录后规则自动复检", stage: "evidence" },
      { label: "规则冲突", count: open.filter((i) => i.issueType === "ruleConflict").length, hint: "尺寸链或规则核对不通过", stage: "issues" },
    ];
    return groups.filter((item) => item.count > 0);
  })();

  // 任务进度状态（05 图 1 左栏）：只按当前项目已有数据判断，不预设完成度
  const stageStates: Record<StageId, { label: string; tone: "done" | "active" | "idle" }> = {
    tasks: confirmedTask ? { label: "已确认", tone: "done" } : { label: "待确认", tone: "active" },
    evidence: selected?.snapshot.evidences.length ? { label: `${selected.snapshot.evidences.length} 份`, tone: "done" } : { label: "无资料", tone: "idle" },
    measurements: selected?.snapshot.facts.length ? { label: `${selected.snapshot.facts.length} 项事实`, tone: "done" } : { label: "无事实", tone: "idle" },
    objects: geometrySpec?.objects.length ? { label: `${geometrySpec.objects.length} 个对象`, tone: "done" } : { label: "无对象", tone: "idle" },
    conditions: selected?.snapshot.observations.length ? { label: `${selected.snapshot.observations.length} 条记录`, tone: "done" } : { label: "无记录", tone: "idle" },
    issues: dashboard?.openIssueCount ? { label: `${dashboard.openIssueCount} 项待办`, tone: "active" } : { label: "无待办", tone: "done" },
    geometry: geometryRevision ? { label: "已生成", tone: "done" } : { label: "未生成", tone: "idle" },
    sheetStyle: confirmedTask?.artifactRequirements
      ? { label: `${confirmedTask.artifactRequirements.sheets.length} 张图幅`, tone: "done" }
      : { label: "未设置", tone: "idle" },
    drawings: drawingArtifacts.length ? { label: `${drawingArtifacts.length} 项产物`, tone: "done" } : { label: "未生成", tone: "idle" },
    checks: latestCheckRun ? { label: "已检查", tone: "done" } : { label: "未检查", tone: "idle" },
    package: latestDelivery ? { label: "已建草案", tone: "done" } : { label: "未建立", tone: "idle" },
    candidates: projectModelRuns.length ? { label: `${projectModelRuns.length} 次运行`, tone: "done" } : { label: "未运行", tone: "idle" },
  };

  // 证据在中栏内联展示：选中资料后原件显示在数据下方，中栏不再拆分为并列子栏
  const renderEvidenceView = (emptyHint: string) => (
    <aside className="stage-evidence" aria-label="资料原件">
      <header>
        <strong>资料原件</strong>
        {evidencePreview && <small>{evidencePreview.fileName}</small>}
      </header>
      {selected && selected.snapshot.evidences.length > 1 && (
        <div className="evidence-switch">
          {selected.snapshot.evidences.map((evidence) => (
            <button key={evidence.id} type="button" className={activeEvidenceId === evidence.id ? "active" : ""}
              onClick={() => setActiveEvidenceId(evidence.id)}>{evidence.title}</button>
          ))}
        </div>
      )}
      {evidencePreview ? (
        evidencePreview.mimeType.startsWith("image/")
          ? <img src={evidencePreview.url} alt={`${evidencePreview.fileName} 原件`} />
          : evidencePreview.mimeType === "application/pdf"
            ? <object data={evidencePreview.url} type="application/pdf" aria-label={`${evidencePreview.fileName} 原件`} />
            : <div className="panel-empty">该类型（{evidencePreview.mimeType}）无法在页内显示，可下载原文件核对。</div>
      ) : <div className="panel-empty">{selected?.snapshot.evidences.length ? emptyHint : "上传资料后在此并置显示原件。"}</div>}
    </aside>
  );

  return (
    <main className={`app-shell ${assistantCollapsed ? "assistant-collapsed" : ""}`}>
      <section className="catalog-panel">
        <header>
          <div className="brand-mark" aria-hidden="true">建</div>
          <h1>古建保护成果工作台</h1>
        </header>
        <div className="left-body">
        {selected && (
          <div className="active-project">
            <p className="panel-label">项目</p>
            <h2>{selected.snapshot.buildings[0]?.name}</h2>
            <small>{confirmedTask?.name ?? selected.snapshot.project.name}</small>
            <small>{selected.snapshot.project.locationText ?? "地点尚未记录"}</small>
            <button type="button" onClick={() => { setSelected(null); setActiveEvidenceId(null); }}>← 返回项目列表</button>
          </div>
        )}
        {selected && (
          <div>
            <p className="panel-label">任务进度</p>
            <nav className="stage-list" aria-label="任务进度">
              {stages.map((stage) => {
                const state = stageStates[stage.id];
                return (
                  <button className={`stage-row ${activeStage === stage.id ? "active" : ""}`} key={stage.id} type="button" onClick={() => setActiveStage(stage.id)}>
                    <span className={`stage-state ${state.tone}`} aria-hidden="true" />
                    <strong>{stage.label}</strong>
                    <small>{state.label}</small>
                  </button>
                );
              })}
            </nav>
          </div>
        )}
        {selected && pendingItems.length > 0 && (
          <div>
            <p className="panel-label">待办 {pendingItems.reduce((sum, item) => sum + item.count, 0)}</p>
            <div className="pending-list">
              {pendingItems.map((item) => (
                <button key={item.label} type="button" onClick={() => setActiveStage(item.stage)}>
                  <strong>{item.label} {item.count}</strong>
                  <small>{item.hint}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {selected && dashboard && <div className="stage-qualification"><ShieldCheck size={13} /><span>{dashboard.qualificationLabel}</span></div>}
        {!selected && <>
        <button className="new-project" type="button" onClick={() => setShowCreate(true)}><Plus size={15} /> 新建项目</button>
        <button className="secondary-action" type="button" onClick={() => importInput.current?.click()}><Upload size={14} /> 导入 JSON / ZIP</button>
        <input
          ref={importInput}
          className="sr-only"
          type="file"
          accept=".json,.zip,application/json,application/zip"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProject(file); }}
        />
        <label className="search-field">
          <Search size={15} />
          <span className="sr-only">搜索项目</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或建筑" />
        </label>
        <div className="project-list" aria-label="项目列表">
          {filtered.map((project) => (
            <button className="project-card" key={project.projectId} type="button" onClick={() => void chooseProject(project.projectId)}>
              
              <strong>{project.name}</strong>
              <small>{project.buildingName}</small>
              <div className="project-card-status">
                <span>{project.status === "active" ? "进行中" : "已归档"}</span>
                <time>{project.updatedAt.slice(0, 10)}</time>
              </div>
            </button>
          ))}
          {!filtered.length && <p className="empty-list">还没有项目。先建立一份可追溯的项目档案。</p>}
        </div>
        </>}
        </div>
        <footer><span>项目保存在本机</span><button type="button" onClick={() => void clearLibrary()}><Trash2 size={12} /> 清空本机项目</button></footer>
      </section>
      <section className="workspace-shell">
        <div className="topbar">
          {/* 三种状态的可见区分（05 表 7）：每条数据标明来源，此处给出全项目构成 */}
          <div>
            <span className="status-dot" />
            <span className="muted">{serverStatus?.modelConfigured ? "在线识别已连接" : "等待服务端密钥"}</span>
            {selected && <><span className="basis-tag measured">实测依据 {basisCounts.human}</span>
            <span className="basis-tag inferred">AI 推测 {basisCounts.model}</span>
            <span className="basis-tag ruled">规则推导 {basisCounts.rule}</span>
            <span className="basis-tag demo">示例资料 {basisCounts.demo}</span></>}
          </div>
          <div>
            {selected && <button className="panel-toggle" type="button" onClick={() => void downloadProject("json")} aria-label="导出项目记录"><FileJson size={14} /></button>}
            {selected && <button className="panel-toggle" type="button" onClick={() => void downloadProject("zip")} aria-label="导出完整项目包"><PackageOpen size={14} /></button>}
            <button className="panel-toggle" type="button" onClick={() => setAssistantCollapsed((value) => !value)} aria-label={assistantCollapsed ? "展开助手与来源面板" : "收起助手与来源面板"}>
              {assistantCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
            </button>
          </div>
        </div>
        {selected ? (
          <div className="project-workspace">
            <nav className="stage-tabs" aria-label="工作区视图">
              {stages.map((stage) => (
                <button className={activeStage === stage.id ? "active" : ""} key={stage.id} type="button" onClick={() => setActiveStage(stage.id)}>
                  {stage.label}
                </button>
              ))}
            </nav>
            <div className="project-stage-layout">
            <div className="stage-content">

            {activeStage === "tasks" && (
              <section className="evidence-board task-overview-board">
                <header className="board-heading"><div><h3>任务要求与成果目录</h3></div><button className="quiet-link" type="button" onClick={() => setActiveStage("issues")}>在问题流程中更新</button></header>
                <div className="pane-body">
                {confirmedTask ? <>
                  <div className="summary-grid">
                    <article><span>任务</span><strong>{confirmedTask.name}</strong><small>{confirmedTask.scope.join(" · ")}</small></article>
                    <article><span>成果要求</span><strong>{confirmedTask.artifactRequirements?.views.length ?? 0} 个视图</strong><small>{confirmedTask.artifactRequirements?.sheets.length ?? 0} 张图纸 · 修订 {confirmedTask.artifactRequirements?.revisionLabel ?? "未定"}</small></article>
                    <article><span>规范依据</span><strong>{confirmedTask.regulationRefs.length} 项</strong><small>{confirmedTask.regulationRefs.join(" · ") || "尚未登记"}</small></article>
                  </div>
                  <div className="requirements-table" role="table" aria-label="成果目录">
                    {confirmedTask.artifactRequirements?.views.map((view) => <div role="row" key={view.key}><span>{view.drawingRef}</span><strong>{view.displayLabelZh}</strong><span>1:{view.scaleDenominator}</span><span>{view.sheetKey}</span></div>)}
                  </div>
                </> : <div className="panel-empty">尚未确认任务要求。系统会在问题队列中保留一次必要人工节点，不会用默认图种或版式补齐。</div>}
                </div>
              </section>
            )}

            {activeStage === "evidence" && (
              <section className="evidence-board">
                <header className="board-heading">
                  <div><h3>原始资料与解析记录</h3></div>
                  <button className="upload-evidence" type="button" onClick={() => evidenceInput.current?.click()}><Upload size={14} /> 上传原始资料</button>
                  <input ref={evidenceInput} className="sr-only" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) void uploadEvidenceFiles(files); }} />
                </header>
                <div className="pane-body">
                    <div className="evidence-list">
                      {selected.snapshot.evidences.map((evidence) => {
                        const parse = selected.snapshot.parseRecords.find((record) => record.evidenceId === evidence.id);
                        return (
                          <article className={`evidence-card ${activeEvidenceId === evidence.id ? "active" : ""}`} key={evidence.id}
                            onClick={() => setActiveEvidenceId(evidence.id)}>
                            <span className="evidence-type">{EVIDENCE_TYPE_LABELS[evidence.evidenceType] ?? evidence.evidenceType}</span>
                            <div><strong>{evidence.title}</strong><small>{parse ? PARSE_STATUS_LABELS[parse.status] ?? "尚未读取" : "尚未读取"}</small></div>
                            <span className={`data-status ${evidence.dataStatus}`}>{evidence.dataStatus === "available" ? "可用" : evidence.dataStatus}</span>
                            <button type="button" onClick={(event) => { event.stopPropagation(); void downloadEvidence(evidence.assetId); }}>原文件</button>
                          </article>
                        );
                      })}
                      {!selected.snapshot.evidences.length && (
                        <div className="evidence-empty"><div className="trace-spine" aria-hidden="true"><span /><span /><span /><span /></div><p>上传任务书、照片、测量记录或已有图纸。文件本体、证据记录和解析结果会一起进入项目版本。</p></div>
                      )}
                    </div>
                  {renderEvidenceView("选择左侧资料查看原件。")}
                </div>
              </section>
            )}

            {activeStage === "measurements" && (
              <section className="evidence-board">
                <header className="board-heading"><div><h3>测量记录、事实与缺失影响</h3></div><span className="board-count">{selected.snapshot.measurements.length + selected.snapshot.facts.length} 条记录</span></header>
                <div className="pane-body">
                {projectArchetypes.length ? (() => {
                  const archetype = projectArchetypes[projectArchetypes.length - 1]!;
                  const derivation = deriveArchetypeExpectations(archetype);
                  const comparisons = compareWithMeasuredFacts(derivation, selected.snapshot.facts);
                  return (
                    <div className="archetype-comparison">
                      <h4>按形制推算的尺寸与实测对照</h4>
                      <p>采用{LIFT_RATIO_SET_LABELS[derivation.ruleSetId] ?? derivation.ruleSetId}，柱位 {derivation.layout.pillarCount} 处，枋连接 {derivation.layout.fangCount} 处。推算值只作核对参考，实测记录始终优先，也不能作为图纸标注依据。</p>
                      <div className="record-table">
                        {comparisons.map((item) => (
                          <article key={item.dimension}>
                            <strong>{item.dimension}</strong>
                            <span>推算 {item.valueMm !== null ? `${item.valueMm} mm` : "按实际测量"}{item.toleranceText ? `，允许偏差 ${item.toleranceText}` : ""}</span>
                            <span>实测 {item.measuredMm !== null ? `${item.measuredMm} mm` : "尚无实测记录"}</span>
                            <small>{item.deltaMm !== null ? `相差 ${item.deltaMm} mm${item.withinTolerance === null ? "" : item.withinTolerance ? "，在允许偏差内" : "，超出允许偏差，建议记入现状"}` : "缺实测，无法比较"}</small>
                            <small>{item.sourceText}</small>
                          </article>
                        ))}
                      </div>
                    </div>
                  );
                })() : (
                  <form className="task-setup archetype-form" onSubmit={(event) => void registerArchetype(event)}>
                    <div><span className="node-label">人工节点</span><h4>登记形制，用于核对实测</h4><p>填写开间、进深和举架做法后，系统按形制推算各处尺寸，供你与实测比对。实测记录始终优先，差异较大的项会提示记入现状。</p></div>
                    <label>逐间面阔 mm（逗号分隔）<input name="bayX" required placeholder="例如 4800" /></label>
                    <label>逐间进深 mm（逗号分隔）<input name="bayY" required placeholder="例如 1800,1800" /></label>
                    <label>步架数<input name="stepCount" type="number" min="1" max="20" required placeholder="七檩填 3" /></label>
                    <label>斗口或材宽 mm<input name="baseD" type="number" min="1" step="any" required placeholder="例如 380" /></label>
                    <label>举架做法
                      <select name="liftRatioSetRef" defaultValue="qing-gongcheng-zuofa">
                        <option value="qing-gongcheng-zuofa">清工程做法举架系数</option>
                        <option value="liang-drawings">梁思成图纸举架系数</option>
                      </select>
                    </label>
                    <label>柱位（列/行，逗号分隔）<input name="pillarNet" required placeholder="例如 0/0,0/1,1/0,1/1" /></label>
                    <label>枋连接的两根柱（可选）<input name="fangNet" placeholder="例如 0/0#1/0,0/1#1/1" /></label>
                    <label>形制判断依据<input name="sourceDeclaration" required placeholder="例如 现场踏勘并对照同期实例" /></label>
                    <button type="submit">登记并推算尺寸</button>
                  </form>
                )}
                <div className="record-table">
                  {selected.snapshot.measurements.map((measurement) => <article key={measurement.id}><span className={`producer-badge ${measurement.producer.producerType}`}>{PRODUCER_LABELS[measurement.producer.producerType]}</span><strong>{measurement.quantity.originalText} {measurement.quantity.originalUnit}</strong><small>{measurement.metadataStatus === "complete" ? "已记录测量人、时间和方法" : "缺测量人、时间或方法"}</small><small>{evidenceTitle(measurement.originalEvidenceRef)}</small></article>)}
                  {selected.snapshot.facts.map((fact) => <article key={fact.id}><span className={`producer-badge ${fact.producer.producerType}`}>{PRODUCER_LABELS[fact.producer.producerType]}</span><strong>{factFieldLabel(fact.field)}</strong><small>{REVIEW_LABELS[fact.reviewStatus] ?? fact.reviewStatus} · {DATA_STATUS_LABELS[fact.dataStatus] ?? fact.dataStatus}</small><small>{fact.evidenceRefs.map(evidenceTitle).join("、") || "未指明资料"}</small></article>)}
                  {!selected.snapshot.measurements.length && !selected.snapshot.facts.length && <div className="panel-empty">还没有可用的尺寸。尺寸缺失时，依赖它的成果不会生成，系统也不会用默认值补齐。</div>}
                </div>
                  {renderEvidenceView("选择资料查看手写草图或测量记录原件。")}
                </div>
              </section>
            )}

            {activeStage === "objects" && (
              <section className="evidence-board">
                <header className="board-heading"><div><h3>对象、构件与稳定标识</h3></div><span className="board-count">{geometrySpec?.objects.length ?? selected.snapshot.entities.length} 个对象</span></header>
                <div className="pane-body">
                <div className="object-table">
                  {(geometrySpec?.objects ?? []).map((object) => <button type="button" key={object.id} onClick={() => { setSelectedGeometryEntityId(object.id); setActiveStage("geometry"); }}><span>{object.displayNameZh}</span><small>{typeLabel(object.componentType, object.conceptRef)}</small><small>{PRODUCER_LABELS[object.producer.producerType]}</small><strong>{object.unknownRefs.length ? `${object.unknownRefs.length} 项待确认` : "来源已记录"}</strong></button>)}
                  {!geometrySpec?.objects.length && selected.snapshot.entities.map((entity) => <article key={entity.id}><strong>{entity.name}</strong><span>{entity.entityType}</span></article>)}
                  {!geometrySpec?.objects.length && !selected.snapshot.entities.length && <div className="panel-empty">还没有构件。构件只能来自本项目的资料，或本项目已核对过的三维模型。</div>}
                </div>
                  {renderEvidenceView("选择资料查看构件对应的照片。")}
                </div>
              </section>
            )}

            {activeStage === "conditions" && (
              <section className="evidence-board">
                <header className="board-heading"><div><h3>空间关系、构造连接与可见残损</h3></div><span className="board-count">{selected.snapshot.observations.length} 条记录</span></header>
                <div className="pane-body">
                    <div className="record-table">
                      {selected.snapshot.relations.map((relation) => (
                        <article key={relation.id}>
                          <span className={`producer-badge ${relation.producer.producerType}`}>{PRODUCER_LABELS[relation.producer.producerType]}</span>
                          <strong>{relation.relationType}</strong>
                          <small>{relation.fromRef} 至 {relation.toRef}</small>
                          <small>{relation.evidenceRefs.map(evidenceTitle).join("、") || "未指明资料"}</small>
                        </article>
                      ))}
                      {selected.snapshot.observations.map((observation) => (
                        <article key={observation.id}>
                          <span className={`producer-badge ${observation.producer.producerType}`}>{PRODUCER_LABELS[observation.producer.producerType]}</span>
                          <strong>{OBSERVATION_LABELS[observation.observationType]}</strong>
                          <small>{observation.text}</small>
                          <small>{observation.evidenceRefs.map(evidenceTitle).join("、")}</small>
                        </article>
                      ))}
                      {!selected.snapshot.relations.length && !selected.snapshot.observations.length && (
                        <div className="panel-empty">还没有现状记录。构件之间的关系由助手识别、再由人工确认；残损情况需要对照资料逐条记录，不能凭推断填写。</div>
                      )}
                    </div>
                    {archetypeDifferences.length > 0 && (
                      <div className="inline-warning">有 {archetypeDifferences.length} 项实测尺寸超出按形制推算的允许偏差，建议记入现状：{archetypeDifferences.map((item) => item.dimension).join("、")}。</div>
                    )}
                    <form className="task-setup" onSubmit={(event) => void recordObservation(event)}>
                      <div><span className="node-label">人工节点</span><h4>记录一条现状判断</h4><p>只记录当前资料上可见的内容。不可见部位记为待复查，不写推断结论。</p></div>
                      <label>判断类型
                        <select name="observationType" defaultValue="visibleCondition">
                          <option value="visibleCondition">可见状态</option>
                          <option value="damage">残损</option>
                          <option value="material">材料</option>
                          <option value="state">整体状态</option>
                        </select>
                      </label>
                      <label>对象（留空即整栋建筑）<input name="subjectRef" placeholder="构件稳定标识或对象 id" /></label>
                      <label>依据资料
                        <select name="evidenceRef" required defaultValue={activeEvidenceId ?? ""}>
                          <option value="" disabled>选择一份资料</option>
                          {selected.snapshot.evidences.map((evidence) => <option key={evidence.id} value={evidence.id}>{evidence.title}</option>)}
                        </select>
                      </label>
                      <label>判断内容<textarea name="text" required placeholder="例如：西侧檐柱柱脚可见糟朽，范围约柱高下部三分之一" /></label>
                      <button type="submit" disabled={!selected.snapshot.evidences.length}>记录并绑定来源</button>
                    </form>
                  {renderEvidenceView("选择资料查看对应部位照片。")}
                </div>
              </section>
            )}

            {activeStage === "candidates" && (
              <section className="evidence-board candidate-board">
                <header className="board-heading">
                  <div><h3>AI 候选与真实运行记录</h3></div>
                  <button className="upload-evidence" type="button" disabled={!parsedEvidenceCount || Boolean(modelRunning) || !serverStatus?.modelConfigured} onClick={() => void runModel()}>
                    <Play size={14} /> {modelRunning ? "运行中" : "生成资料候选"}
                  </button>
                </header>
                <div className="pane-body">
                <div className="transmission-note"><ShieldCheck size={15} /><span>只把本项目已识别出的文字发给助手核对。照片、图纸等原文件保存在本机，不会上传。</span></div>
                {!serverStatus?.modelConfigured && <p className="inline-warning">服务端尚未配置 KIMI_API_KEY，真实运行按钮已锁定。</p>}
                {!parsedEvidenceCount && <p className="inline-warning">先上传一份可解析的 UTF-8 文本或 JSON 资料。</p>}
                <div className="candidate-list">
                  {selected.snapshot.candidates.map((candidate) => (
                    <article className="candidate-card" key={candidate.id}>
                      <div className="candidate-meta"><span className="producer-badge model">模型</span><span>{candidate.reviewStatus === "unreviewed" ? "待处理" : candidate.reviewStatus}</span></div>
                      <h4>{candidate.structured?.summary ?? "模型返回了未结构化候选"}</h4>
                      {!!candidate.structured?.findings.length && <div><strong>资料发现</strong><ul>{candidate.structured.findings.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                      {!!candidate.structured?.missingInformation.length && <div><strong>缺失信息</strong><ul>{candidate.structured.missingInformation.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                    </article>
                  ))}
                  {!selected.snapshot.candidates.length && <div className="panel-empty">助手的识别结果只进入待确认区，需要你确认后才写入项目。</div>}
                </div>
                {!!modelCostView.rows.length && <div className="run-ledger"><strong>运行账本与用量</strong>{modelCostView.rows.map((run) => <span key={run.runId}><b>{run.provider} / {run.model}</b><i>{run.status} · attempt {run.attempts}</i><em>{run.totalTokens ?? "—"} tokens · {run.costLabel}</em></span>)}<small>累计 {modelCostView.totalTokens} tokens；没有可靠单价依据，因此不估算费用。</small></div>}
                </div>
              </section>
            )}

            {activeStage === "issues" && (
              <section className="evidence-board issue-board">
                <header className="board-heading">
                  <div><h3>问题队列与必要人工节点</h3></div>
                  <span className="issue-count">{openIssues.length} 个待处理</span>
                </header>
                <div className="pane-body">
                <div className="provenance-legend" aria-label="来源图例">
                  <span className="producer-badge model">模型候选</span>
                  <span className="producer-badge rule">规则结果</span>
                  <span className="producer-badge human">人工决定</span>
                  <span className="producer-badge demo">演示数据</span>
                </div>
                {humanInterventions && <div className="human-node-summary"><article><strong>{humanInterventions.missingFieldFacts.length}</strong><span>现场事实缺失</span></article><article><strong>{humanInterventions.professionalChoices.length}</strong><span>非唯一专业选择</span></article><article><strong>{humanInterventions.groupedReviewRefs.length}</strong><span>成组审核 / 交付</span></article><small>规则确定项自动执行，不增加逐项确认。</small></div>}
                {!confirmedTask ? (
                  <form className="task-setup" onSubmit={(event) => void confirmTaskSetup(event)}>
                    <div><span className="node-label">人工节点</span><h4>确认任务要求</h4><p>成果范围、适用规范和责任人只在任务开始时确认一次。之后能自动判断的检查会直接执行，不再逐项打扰你。</p></div>
                    <label>任务名称<input name="taskName" required defaultValue="资料整理与成果核对" /></label>
                    <label>任务范围（每行一项）<textarea name="scope" required defaultValue={"整理原始资料\n核对构件\n处理资料缺失\n导出成果"} /></label>
                    <label>适用规范或项目约定<textarea name="regulations" defaultValue="资料需注明来源，可追溯到原件" /></label>
                    <label>成果目录（每行一项）<textarea name="deliverables" required placeholder="按本次任务要求逐行填写，不套用模板" /></label>
                    <label>图纸标题<input name="drawingTitle" required /></label>
                    <label>修订标记<input name="drawingRevision" required placeholder="例如 P1" /></label>
                    <label>需要出图的构件类型（每行一项）<textarea name="geometryTargetRoles" required placeholder="例如 柱、墙、屋面；缺一项该图就不生成" /></label>
                    <label>图幅设置<textarea name="drawingSheets" required placeholder='逐张图填写图号、图名和图幅尺寸，例如：[{"key":"sheet-1","drawingNumber":"P-01","displayLabelZh":"平面与立面","pageMm":[841,594]}]' /></label>
                    <label>视图设置<textarea name="drawingViews" required placeholder="逐个视图填写图种、比例、所在图幅、在图上的位置、朝向和对应构件。详图还需指明依据的资料，缺依据则不生成" /></label>
                    <button type="submit">确认任务要求，开始整理资料</button>
                  </form>
                ) : (
                  <>
                    <div className="task-summary"><span className="node-label complete">任务要求已确认</span><strong>{confirmedTask.name}</strong><small>{confirmedTask.scope.join(" · ")}</small></div>
                    <details className="task-setup">
                      <summary>更新当前版本的成果要求</summary>
                      <form onSubmit={(event) => void replaceTaskSetup(event)}>
                        <label>任务名称<input name="taskName" required defaultValue={confirmedTask.name} /></label>
                        <label>任务范围<textarea name="scope" required defaultValue={confirmedTask.scope.join("\n")} /></label>
                        <label>适用规范<textarea name="regulations" defaultValue={confirmedTask.regulationRefs.join("\n")} /></label>
                        <label>成果目录<textarea name="deliverables" required defaultValue={confirmedTask.deliverables.join("\n")} /></label>
                        <label>图纸标题<input name="drawingTitle" required defaultValue={confirmedTask.artifactRequirements?.titleZh ?? ""} /></label>
                        <label>修订标记<input name="drawingRevision" required defaultValue={confirmedTask.artifactRequirements?.revisionLabel ?? "P1"} /></label>
                        <label>几何目标角色<textarea name="geometryTargetRoles" required defaultValue={confirmedTask.artifactRequirements?.geometryTargetRoles.join("\n") ?? ""} /></label>
                        <label>图纸结构 JSON<textarea name="drawingSheets" required defaultValue={JSON.stringify(confirmedTask.artifactRequirements?.sheets ?? [], null, 2)} /></label>
                        <label>视图结构 JSON<textarea name="drawingViews" required defaultValue={JSON.stringify(confirmedTask.artifactRequirements?.views ?? [], null, 2)} /></label>
                        <button type="submit">保存新任务版本</button>
                      </form>
                    </details>
                  </>
                )}
                <div className="issue-list">
                  {openIssues.filter((issue) => issue.sourceRef !== "rule:task-setup-required").map((issue) => {
                    const candidate = selected.snapshot.candidates.find((item) => issue.subjectRefs.includes(item.id));
                    const canDecide = issue.sourceRef === "rule:model-candidate-review" && candidate?.reviewStatus === "unreviewed";
                    return (
                      <article className="issue-card" key={issue.id}>
                        <div className="issue-meta"><span className={`issue-severity ${issue.issueType}`}>{ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType}</span><span className="producer-badge rule">自动核对</span></div>
                        <h4>{issue.description}</h4>
                        {issue.options?.length ? (
                          <div className="decision-actions option-decision">
                            <p>下面几种做法都有依据。选定一种并写明理由，后续版本仍可改。</p>
                            {issue.options.map((option) => (
                              <label className="option-row" key={option.optionId}>
                                <input
                                  type="radio"
                                  name={`issue-option-${issue.id}`}
                                  checked={selectedOptions[issue.id] === option.optionId}
                                  onChange={() => setSelectedOptions((current) => ({ ...current, [issue.id]: option.optionId }))}
                                />
                                <span><strong>{option.labelZh}</strong><small>{option.valueText}</small><em>{option.sourceText}</em></span>
                              </label>
                            ))}
                            <label>理由或备注<textarea value={decisionReasons[issue.id] ?? ""} onChange={(event) => setDecisionReasons((current) => ({ ...current, [issue.id]: event.target.value }))} placeholder="选定时可选填；暂不选择时必填" /></label>
                            <div>
                              <button type="button" className="accept-decision" onClick={() => void decideIssueOption(issue.id, "accepted")}>选定该方案</button>
                              <button type="button" className="reject-decision" onClick={() => void decideIssueOption(issue.id, "rejected")}>暂不选择</button>
                            </div>
                          </div>
                        ) : canDecide ? (
                          <div className="decision-actions">
                            <p>这是非唯一的专业取舍，需要一次人工决定。接受只改变候选核对状态，不改变数据来源。</p>
                            <label>驳回理由<textarea value={decisionReasons[issue.id] ?? ""} onChange={(event) => setDecisionReasons((current) => ({ ...current, [issue.id]: event.target.value }))} placeholder="仅在驳回时必填" /></label>
                            <div>
                              <button type="button" className="accept-decision" onClick={() => void decideCandidate(issue.id, candidate.id, "accepted")}>接受为已核对候选</button>
                              <button type="button" className="reject-decision" onClick={() => void decideCandidate(issue.id, candidate.id, "rejected")}>驳回候选</button>
                            </div>
                          </div>
                        ) : (
                          <p className="auto-guidance">{issue.issueType === "missingEvidence" ? "补充或更换资料后，规则会自动复检，不需要手动确认。" : "由对应候选处理动作关闭。"}</p>
                        )}
                      </article>
                    );
                  })}
                  {!openIssues.filter((issue) => issue.sourceRef !== "rule:task-setup-required").length && confirmedTask && <div className="panel-empty">当前没有需要人工处理的异常。自动规则已完成。</div>}
                </div>
                {!!selected.snapshot.evidences.length && (
                  <form className="task-setup dimension-chain-form" onSubmit={(event) => void confirmDocumentedDimensionChain(event)}>
                    <div><span className="node-label">事实转写</span><h4>文档尺寸链核对</h4><p>只转写当前项目资料中的数值。系统自动计算差值；人工转写不等于现场测量。</p></div>
                    <label>总尺寸 mm<input name="totalWidthMm" type="number" min="1" step="any" required /></label>
                    <label>分段尺寸 mm<textarea name="segmentWidthsMm" required placeholder="例如：4200, 3600, 3600" /></label>
                    <label className="check-label"><input name="measurementMetadataComplete" type="checkbox" />资料已明确测量人、时间、方法和原始记录</label>
                    <button type="submit">转写并自动核对</button>
                  </form>
                )}
                <div className="workflow-ledgers">
                  <section><strong>规则运行</strong>{projectRuleRuns.slice(-4).reverse().map((run) => <span key={run.id}><b className="producer-badge rule">规则</b>{run.ruleSetVersion} · {run.results.filter((result) => result.outcome === "issue").length} 项异常</span>)}</section>
                  <section><strong>人工决定</strong>{projectDecisions.slice(-4).reverse().map((decision) => {
                    const issue = selected.snapshot.issues.find((item) => item.id === decision.issueId);
                    const candidate = selected.snapshot.candidates.find((item) => decision.impactRefs.includes(item.id));
                    const target = candidate
                      ? `模型候选 ${candidate.taskType}`
                      : decision.selectedOptionId ? `所选方案 ${decision.selectedOptionId}` : issue?.sourceRef ?? "项目";
                    return (
                      <span key={decision.id}>
                        <b className="producer-badge human">人工</b>{decision.outcome} · {decision.decidedAt.slice(0, 19).replace("T", " ")}
                        <small>对象：{target}{issue ? ` · 问题：${issue.description.slice(0, 24)}` : ""}</small>
                      </span>
                    );
                  })}{!projectDecisions.length && <small>尚无人工决定</small>}</section>
                </div>
                </div>
              </section>
            )}

            {activeStage === "geometry" && (
              <section className="evidence-board geometry-board">
                <header className="board-heading">
                  <div><h3>项目驱动三维模型</h3></div>
                  <button className="upload-evidence" type="button" disabled={!geometryGate?.ready || Boolean(cadProgress && !["succeeded", "failed", "cancelled"].includes(cadProgress.phase))} onClick={() => void generateDemoGeometry()}>
                    <Play size={14} /> {geometryRevision ? "生成新代理版本" : "生成代理几何"}
                  </button>
                </header>
                <div className="pane-body">
                <div className="transmission-note"><ShieldCheck size={15} /><span>生成三维只使用本项目已确认的构件数据，不读取项目以外的文件。</span></div>
                {!geometryGate?.ready && (
                  <div className="geometry-gate">
                    <strong>建立代理几何前，需从当前项目资料逐构件确认几何事实</strong>
                    <p>每个构件和界面必须定位到当前项目具体证据；不得用百分比、固定厚度或其他项目数据补齐。当前缺失：{geometryGate?.missing.join("、")}</p>
                    {!!selected.snapshot.evidences.length && (
                      <form className="geometry-fact-form" onSubmit={(event) => void confirmGeometryFacts(event)}>
                        <label>构件数据<textarea name="geometryComponents" required placeholder="逐个构件填写：名称、类型、尺寸、依据的资料，以及尚未确认的部分" /></label>
                        <label>界面事实 JSON<textarea name="geometryInterfaces" required placeholder="仅填写图纸或调查资料可证明的承托、接触、包含或搭接关系；无证据可留空 []" /></label>
                        <p>当前项目证据 ID：{selected.snapshot.evidences.map((item) => `${item.title}=${item.id}`).join("；")}</p>
                        <button type="submit">写入逐构件证据事实</button>
                      </form>
                    )}
                  </div>
                )}
                {geometryRevision && geometryBlob ? (
                  <div className="geometry-workspace">
                    <GlbViewer blob={geometryBlob} onSelect={setSelectedGeometryEntityId} />
                    <aside className="geometry-inspector">
                      <span className="qualification-chip">未签发，不能用于正式交付</span>
                      <h4>{selectedGeometryEntity?.displayNameZh ?? "选择模型构件查看来源"}</h4>
                      {selectedGeometryEntity ? <>
                        <dl>
                          <div><dt>稳定键</dt><dd>{selectedGeometryEntity.stableKey}</dd></div>
                          <div><dt>构件类型</dt><dd>{typeLabel(selectedGeometryEntity.componentType, selectedGeometryEntity.conceptRef)}（{selectedGeometryEntity.componentType}）</dd></div>
                          <div><dt>来源</dt><dd>{PRODUCER_LABELS[selectedGeometryEntity.producer.producerType]}</dd></div>
                          <div><dt>证据</dt><dd>{selectedGeometryEntity.evidenceRefs.length} 项</dd></div>
                        </dl>
                        {selectedGeometryEntity.unknownRefs.map((id) => {
                          const unknown = geometrySpec?.unknowns.find((item) => item.id === id);
                          return unknown ? <div className="unknown-card" key={id}><p>{unknown.description}</p><small>{unknown.blocksFormalEligibility ? "影响正式交付" : "不影响正式交付"}</small></div> : null;
                        })}
                      </> : <p>点击模型中的构件，查看稳定 ID、证据引用、未知项和资格影响。</p>}
                      <hr />
                      <small>共 {geometrySpec?.objects.length ?? 0} 个构件</small>
                      <small>{geometrySpec?.objects.length ?? 0} 个实体 · {geometrySpec?.interfaces.length ?? 0} 个界面 · {geometrySpec?.unknowns.length ?? 0} 个未知项</small>
                    </aside>
                  </div>
                ) : (
                  <div className="panel-empty">还没有三维模型。生成后可在这里查看构件并核对来源。</div>
                )}
                </div>
              </section>
            )}

            {activeStage === "sheetStyle" && (
              <section className="evidence-board">
                <header className="board-heading">
                  <div><h3>图幅、视图与图签</h3></div>
                  <button className="quiet-link" type="button" onClick={() => setActiveStage("tasks")}>在任务要求中修改</button>
                </header>
                {confirmedTask?.artifactRequirements ? (() => {
                  const requirements = confirmedTask.artifactRequirements;
                  return (
                    <div className="pane-body">
                        <div className="summary-grid">
                          <article><span>图纸标题</span><strong>{requirements.titleZh}</strong><small>修订标记 {requirements.revisionLabel}</small></article>
                          <article><span>图幅</span><strong>{requirements.sheets.length} 张</strong><small>{[...new Set(requirements.sheets.map((sheet) => `${sheet.pageMm[0]}×${sheet.pageMm[1]}`))].join(" · ")} mm</small></article>
                          <article><span>视图</span><strong>{requirements.views.length} 个</strong><small>比例 {[...new Set(requirements.views.map((view) => `1:${view.scaleDenominator}`))].join(" · ")}</small></article>
                        </div>
                        <div className="requirements-table">
                          {requirements.sheets.map((sheet) => (
                            <div key={sheet.key}>
                              <span>{sheet.drawingNumber}</span>
                              <strong>{sheet.displayLabelZh}</strong>
                              <span>{sheet.pageMm[0]}×{sheet.pageMm[1]}</span>
                              <span>{requirements.views.filter((view) => view.sheetKey === sheet.key).length} 个视图</span>
                            </div>
                          ))}
                        </div>
                        <div className="requirements-table">
                          {requirements.views.map((view) => (
                            <div key={view.key}>
                              <span>{view.drawingRef}</span>
                              <strong>{view.displayLabelZh}</strong>
                              <span>{DRAWING_KIND_LABELS[view.kind] ?? view.kind}</span>
                              <span>1:{view.scaleDenominator}</span>
                            </div>
                          ))}
                        </div>
                        <div className="inline-warning">构件画法与标注规则暂时不能选择。当前每张图只标注一道总尺寸和图名，轴线、标高、剖切索引和构件名称都还没有生成。等这部分做好后，这里会开放画法与标注的选项。</div>
                      <aside className="stage-evidence" aria-label="样式预览">
                        <header><strong>图面预览</strong>{drawingPreviewUrls.length > 0 && <small>{drawingPreviewUrls[0]!.label}</small>}</header>
                        {drawingPreviewUrls.length > 0
                          ? (drawingPreviewUrls[0]!.kind === "svg"
                            ? <img src={drawingPreviewUrls[0]!.url} alt="图纸样式预览" />
                            : <object data={drawingPreviewUrls[0]!.url} type="application/pdf" aria-label="图纸样式预览" />)
                          : <div className="panel-empty">生成成组图纸后，这里显示应用当前版面的实际图面。</div>}
                      </aside>
                    </div>
                  );
                })() : <div className="panel-empty">尚未确认成果要求。图幅、视图与图签在任务要求中一次确认后显示在这里。</div>}
              </section>
            )}

            {activeStage === "drawings" && (
              <section className="evidence-board drawing-board">
                <header className="board-heading">
                  <div><h3>成组平立剖与节点详图</h3></div>
                  <button className="upload-evidence" type="button" disabled={!geometryRevision || !confirmedTask || Boolean(drawingProgress && !["succeeded", "failed"].includes(drawingProgress))} onClick={() => void generateDrawings()}>
                    <Images size={14} /> {drawingProgress && !["succeeded", "failed"].includes(drawingProgress) ? "生成中" : "按成果目录生成"}
                  </button>
                </header>
                <div className="pane-body">
                <div className="transmission-note"><ShieldCheck size={15} /><span>图种、图幅和版面来自任务要求；图上每条线都由当前三维模型剖切或投影得到，不另外描画。</span></div>
                {drawingArtifacts.length ? (
                  <><div className="drawing-preview-grid" aria-label="成组图纸预览">
                    {drawingPreviewUrls.map((preview) => preview.kind === "svg"
                      ? <figure key={preview.id}><img src={preview.url} alt={`${preview.label} 矢量预览`} /><figcaption>{preview.label}</figcaption></figure>
                      : <figure key={preview.id}><object data={preview.url} type="application/pdf" aria-label={`${preview.label} PDF 预览`} /><figcaption>{preview.label}</figcaption></figure>)}
                  </div><div className="artifact-list">
                    {drawingArtifacts.map((artifact) => <button type="button" key={artifact.id} onClick={() => void downloadArtifact(artifact)}><span>{artifact.kind}</span><strong>{artifact.fileName}</strong><small>{Math.round(artifact.byteLength / 1024)} KB</small></button>)}
                  </div></>
                ) : <div className="panel-empty">先生成三维模型，再按任务要求出图。图纸会同时导出 DXF、PDF 和预览图。</div>}
                {latestCheckRun && <div className="check-summary"><FileCheck2 size={18} /><div><strong>检查结果</strong>{latestCheckRun.results.map((item) => <p key={item.code} className={item.outcome}>{item.outcome === "passed" ? "通过" : "不通过"} · {item.message}</p>)}</div></div>}
                </div>
              </section>
            )}

            {activeStage === "checks" && (
              <section className="evidence-board checks-board">
                <header className="board-heading"><div><h3>检查结果与待确认项</h3></div><span className="qualification-chip">未签发，不能用于正式交付</span></header>
                <div className="pane-body">
                <div className="summary-grid">
                  <article><span>三维模型</span><strong>{geometryRevision ? "已生成" : "未生成"}</strong><small>{geometrySpec?.unknowns.length ?? 0} 项待确认</small></article>
                  <article><span>当前成果</span><strong>{artifactSetView?.currentArtifacts.length ?? 0} 项</strong><small>{artifactSetView?.crossRevisionArtifactCount ?? 0} 项旧版本成果已隔离</small></article>
                  <article><span>检查结论</span><strong>{latestCheckRun ? latestCheckRun.results.filter((result) => result.outcome === "blocked").length ? "有不通过项" : "全部通过" : "尚未检查"}</strong><small>技术检查通过不等于专业复核通过</small></article>
                </div>
                {latestCheckRun ? <div className="check-register">{latestCheckRun.results.map((result) => <article key={result.code} className={result.outcome}><span>{result.outcome === "passed" ? "通过" : "不通过"}</span><strong>{result.code}</strong><p>{result.message}</p></article>)}</div> : <div className="panel-empty">还没有检查记录。检查通过不等于专业复核通过，签发仍需责任人操作。</div>}
                {!!dashboard?.blockerCodes.length && <div className="delivery-blockers"><strong>暂时不能正式交付</strong>{dashboard.blockerCodes.map((code) => <p key={code}>{BLOCKER_LABELS[code] ?? code}</p>)}</div>}
                </div>
              </section>
            )}

            {activeStage === "package" && (
              <section className="evidence-board package-board">
                <header className="board-heading"><div><h3>代理成果交付与项目包</h3></div><button className="upload-evidence" type="button" disabled={!geometryRevision || !latestCheckRun || !drawingArtifacts.length || Boolean(latestDelivery)} onClick={() => void createProxyDelivery()}><PackageOpen size={14} /> 建立代理交付草案</button></header>
                <div className="pane-body">
                {latestDelivery ? <div className="delivery-status"><span className="qualification-chip">未签发，不能用于正式交付</span><strong>交付草案 {latestDelivery.id.slice(0, 8)}</strong><p>{latestDelivery.restrictions.join(" · ")}</p></div> : deliveries.blockers(selected).length ? <div className="delivery-blockers"><strong>暂时不能正式交付</strong>{deliveries.blockers(selected).map((item) => <p key={item}>{item}</p>)}<button type="button" disabled={Boolean(latestBlockedDelivery)} onClick={() => void recordBlockedDelivery()}>{latestBlockedDelivery ? "已记录原因" : "记录无法交付的原因"}</button></div> : null}
                <div className="package-grid">
                  <article><FileJson /><strong>project.json</strong><p>适合检查结构化记录，不包含二进制文件本体。</p><button type="button" onClick={() => void downloadProject("json")}>导出 JSON</button></article>
                  <article><PackageOpen /><strong>project.gujian.zip</strong><p>包含全部资料原件、识别与核对记录、人工决定、三维模型、图纸、检查结果和交付草案。</p><button type="button" onClick={() => void downloadProject("zip")}>导出代理 ZIP</button></article>
                </div>
                <section className="roundtrip-check">
                  <div>
                    <ShieldCheck size={17} />
                    <span><strong>导出后能否完整恢复</strong><small>用当前项目实时导出一份，在一个独立环境里恢复并逐项核对资料、记录与成果。检验不改动本机项目，结束后自动清理。</small></span>
                  </div>
                  <button type="button" onClick={() => void verifyEmptyLibraryRoundTrip()}>检验导出与恢复</button>
                  {roundTripReceipt && (
                    <dl aria-label="恢复检验结果">
                      
                      
                      
                      <div><dt>资料</dt><dd>{roundTripReceipt.evidenceCount}</dd></div>
                      <div><dt>规则</dt><dd>{roundTripReceipt.ruleRunCount}</dd></div>
                      <div><dt>人工决定</dt><dd>{roundTripReceipt.decisionCount}</dd></div>
                      <div><dt>几何版本</dt><dd>{roundTripReceipt.geometryRevisionCount}</dd></div>
                      <div><dt>成果</dt><dd>{roundTripReceipt.artifactCount}</dd></div>
                      <div><dt>检查</dt><dd>{roundTripReceipt.checkRunCount}</dd></div>
                      <div><dt>交付</dt><dd>{roundTripReceipt.deliveryCount}</dd></div>
                      <div><dt>项目记录</dt><dd>{roundTripReceipt.jsonEvidenceCount} 份资料，其中 {roundTripReceipt.jsonMissingAssetCount} 份缺原文件</dd></div>
                      
                      
                    </dl>
                  )}
                </section>
                </div>
              </section>
            )}
            </div>
            </div>
          </div>
        ) : (
          <div className="empty-workspace">
            <div className="trace-spine" aria-hidden="true"><span /><span /><span /><span /></div>
            <div className="empty-copy">
              
              <h2>从一份原始资料开始</h2>
              <p>新建项目后，资料、模型候选、人工决定和导出包会在同一条证据链中显示。</p>
              <button type="button" onClick={() => setShowCreate(true)}><Plus size={16} /> 建立项目档案</button>
            </div>
          </div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="notice-banner" role="status"><Download size={13} /> {notice}<button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={13} /></button></div>}
      </section>
      <aside className={`assistant-shell ${assistantCollapsed ? "collapsed" : ""}`}>
        {assistantCollapsed ? <button className="assistant-open" type="button" onClick={() => setAssistantCollapsed(false)} aria-label="展开助手与来源面板"><PanelRightOpen size={17} /></button> : <>
        {/* 当前状态条（05 图 1、表 3）：显示正在做什么与进度 */}
        <div className="assistant-status">
          <div className="assistant-title"><Bot size={17} /><strong>助手与来源</strong><button type="button" onClick={() => setAssistantCollapsed(true)} aria-label="收起助手与来源面板"><PanelRightClose size={15} /></button></div>
          <p>{currentStatusText}</p>
        </div>
        <div className="assistant-body">
        {selected && <ChatPanel client={assistantChatClient} buildSnapshot={buildAssistantSnapshot} onClientOp={handleAssistantClientOp} />}
        {pendingProposal && (
          <div className="assistant-pending-confirm">
            <strong>修改建议待确认</strong>
            <p>{pendingProposal.subjectName} 的 {pendingProposal.field}：{pendingProposal.oldValueText} → {pendingProposal.newValueText}</p>
            <small>{pendingProposal.rationaleZh}</small>
            {pendingProposal.warnings.map((warning) => <p className="inline-warning" key={warning}>{warning}</p>)}
            <div className="proposal-actions">
              <button type="button" onClick={() => void adoptProposal()}>采纳生效</button>
              <button type="button" onClick={() => { setPendingProposal(null); setNotice("修改建议已拒绝，未生效"); }}>拒绝</button>
            </div>
          </div>
        )}
        {modelProgress ? (
          <div className="live-run">
            <span className={`run-state ${modelProgress.phase}`}>{modelProgress.phase}</span>
            <strong>助手正在识别</strong>
            <p>{modelProgress.streamedText || "正在建立受控运行……"}</p>
            {modelRunning && <button type="button" onClick={() => void modelRuns.cancel()}><CircleStop size={14} /> 停止识别</button>}
          </div>
        ) : (
          <>
            <div className="assistant-event"><span />助手的识别结果先进入待确认区，确认后才写入项目</div>
            <div className="assistant-event"><span />资料原件保存在本机，不会上传</div>
          </>
        )}
        {provenance && <section className="provenance-track" aria-label="来源关系">
          <header><Link2 size={14} /><strong>{selectedGeometryEntity ? "所选构件的来源" : "本项目的来源"}</strong></header>
          <div>{provenance.nodes.map((node) => <article className={node.status} key={node.key}><i /><span><strong>{node.label}</strong><small>{node.count ? `${node.count} 项已关联` : "尚无"}</small></span></article>)}</div>
          <footer>{provenance.unknownCount} 项待确认 · {provenance.formalBlockerCount} 项影响正式交付</footer>
        </section>}
        </div>
        </>}
      </aside>
      {showCreate && (
        <div className="modal-backdrop" role="presentation">
          <form className="create-dialog" onSubmit={(event) => void handleCreate(event)}>
            <button className="close-dialog" type="button" onClick={() => setShowCreate(false)} aria-label="关闭"><X size={17} /></button>
            <Building2 size={20} />
            
            <h2>建立项目档案</h2>
            <label>项目名称<input name="name" required maxLength={200} placeholder="例如：城隍庙山门保护记录" /></label>
            <label>建筑名称<input name="buildingName" required maxLength={200} placeholder="例如：山门" /></label>
            <label>地点<input name="locationText" maxLength={500} placeholder="可暂时留空" /></label>
            <button className="primary-action" type="submit">创建并进入项目</button>
          </form>
        </div>
      )}
    </main>
  );
}
