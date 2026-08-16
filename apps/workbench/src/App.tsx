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
import { compareWithMeasuredFacts, conceptLabel, deriveArchetypeExpectations, resolveVocabulary } from "@gujian/infrastructure";
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
  { id: "issues", label: "问题队列" },
  { id: "geometry", label: "三维模型" },
  { id: "drawings", label: "成组图纸" },
  { id: "checks", label: "检查与资格", icon: ShieldCheck },
  { id: "package", label: "代理交付" },
  { id: "candidates", label: "模型运行与费用", icon: Activity },
] as const;
export const LENGTH_INPUT_STEP = "any";
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

  const chooseProject = async (projectId: string) => {
    setError(null);
    setModelProgress(null);
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
      setNotice("项目驱动 GeometryRevision 已生成；仍为代理成果、未签发、L1=false");
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
      setSelected(outcome.head); await loadProject(selected.projectId); await refresh(); setNotice("同一 GeometryRevision 的成组图纸已生成并完成哈希检查");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "图纸作业失败"); }
  };

  const createProxyDelivery = async () => {
    if (!selected || !geometryRevision || !latestCheckRun || !drawingArtifacts.length) return;
    setError(null);
    try {
      const outcome = await deliveries.createProxyDraft(selected, localActorId(), geometryRevision, drawingArtifacts, latestCheckRun);
      setSelected(outcome.head); await loadProject(selected.projectId); await refresh(); setNotice("代理交付草案已建立：未签发、L1=false、不可正式使用");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "代理交付草案建立失败"); }
  };

  const recordBlockedDelivery = async () => {
    if (!selected) return;
    setError(null);
    try {
      await deliveries.recordBlockedEvaluation(selected, localActorId());
      await loadProject(selected.projectId);
      await refresh();
      setNotice("已记录正式交付阻断；未生成空成果或默认模型");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "交付阻断记录失败"); }
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
        modelProgress && `模型运行 ${modelProgress.runId.slice(0, 8)}：${modelProgress.phase}`,
        cadProgress && `三维作业 ${cadProgress.jobId.slice(0, 8)}：${cadProgress.phase}`,
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
    setNotice("本地项目库已清空，可以验证空库回导");
  };

  const verifyEmptyLibraryRoundTrip = async () => {
    if (!selected) return;
    setError(null);
    setRoundTripReceipt(null);
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

      await projectRepository.clearAllData();
      setSelected(null);
      setProjectModelRuns([]);
      setProjectRuleRuns([]);
      setProjectDecisions([]);
      setProjectArtifacts([]); setProjectCheckRuns([]); setProjectDeliveries([]);
      const importedProjectId = await projectPackages.import(zipBytes, "roundtrip.gujian.zip", localActorId());
      const importedHead = await projectRepository.getProjectHead(importedProjectId);
      if (!importedHead) throw new Error("ROUNDTRIP_PROJECT_MISSING");
      const importedEvidenceIds = importedHead.snapshot.evidences.map((item) => item.id).sort();
      const importedAssetIds = importedHead.snapshot.evidences.map((item) => item.assetId).sort();
      const importedArtifacts = await projectRepository.getProjectArtifacts(importedProjectId);
      const importedChecks = await projectRepository.getProjectCheckRuns(importedProjectId);
      const importedDeliveries = await projectRepository.getProjectDeliveries(importedProjectId);
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
        projectRepository.getProjectRuleRuns(importedProjectId),
        projectRepository.getProjectDecisions(importedProjectId),
      ]);
      const importedAssets = await projectRepository.getProjectAssets(importedProjectId);
      if (importedAssets.some(({ record, content }) => record.contentStatus !== "available" || content === null)) {
        throw new Error("ZIP_ROUNDTRIP_ASSET_CONTENT_MISSING");
      }
      await refresh();
      await loadProject(importedProjectId);
      setActiveStage("package");
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
      setNotice("已用当前项目依次完成 JSON 结构回导和 ZIP 完整资料回导");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "空库回导校验失败");
      await refresh();
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
      setNotice(outcome.candidate ? "Kimi 运行完成，结果已进入候选区" : `模型运行已记录：${outcome.run.status}`);
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

  return (
    <main className={`app-shell ${assistantCollapsed ? "assistant-collapsed" : ""}`}>
      <aside className="rail">
        <div className="brand-mark" aria-hidden="true">建</div>
        <nav aria-label="主导航">
          <button className="rail-button active" type="button" aria-label="项目"><FolderKanban /></button>
          <button className="rail-button" type="button" aria-label="归档"><Archive /></button>
        </nav>
      </aside>
      <section className="catalog-panel">
        <header>
          <p className="eyebrow">PROJECT RECORD DESK</p>
          <h1>古建保护<br />成果工作台</h1>
        </header>
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
            <button
              className={`project-card ${selected?.projectId === project.projectId ? "selected" : ""}`}
              key={project.projectId}
              type="button"
              onClick={() => void chooseProject(project.projectId)}
            >
              <span className="project-code">{project.projectId.slice(0, 8).toUpperCase()}</span>
              <strong>{project.name}</strong>
              <small>{project.buildingName}</small>
              <div className="project-card-status">
                <span>{selected?.projectId === project.projectId && dashboard ? dashboard.stage : project.status === "active" ? "进行中" : "已归档"}</span>
                <time>{project.updatedAt.slice(0, 10)}</time>
              </div>
              {selected?.projectId === project.projectId && dashboard && (
                <div className="project-card-meter"><i style={{ width: `${dashboard.evidenceCompleteness}%` }} /><small>资料解析 {dashboard.evidenceCompleteness}% · 阻断 {dashboard.blockerCodes.length}</small></div>
              )}
            </button>
          ))}
          {!filtered.length && <p className="empty-list">还没有项目。先建立一份可追溯的项目档案。</p>}
        </div>
        <footer><span>本地优先 · IndexedDB v3</span><button type="button" onClick={() => void clearLibrary()}><Trash2 size={12} /> 清空本地库</button></footer>
      </section>
      <section className="workspace-shell">
        <div className="topbar">
          <div><span className="status-dot" /><strong>{selected ? selected.snapshot.project.name : "工作台基础服务就绪"}</strong></div>
          <div>
            <span className="muted">{serverStatus?.model ?? "Kimi K2.6"} · {serverStatus?.modelConfigured ? "服务端已配置" : "等待服务端密钥"}</span>
            <button className="panel-toggle" type="button" onClick={() => setAssistantCollapsed((value) => !value)} aria-label={assistantCollapsed ? "展开助手与来源面板" : "收起助手与来源面板"}>
              {assistantCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
            </button>
          </div>
        </div>
        {selected ? (
          <div className="project-workspace">
            <div className="project-heading">
              <div>
                <p className="eyebrow">ACTIVE PROJECT</p>
                <h2>{selected.snapshot.buildings[0]?.name}</h2>
                <p>{selected.snapshot.project.locationText ?? "地点尚未记录"}</p>
                {dashboard && <div className="project-health"><span>{dashboard.stage}</span><span>资料 {dashboard.evidenceCompleteness}%</span><span>开放问题 {dashboard.openIssueCount}</span><span>成果 {dashboard.artifactCount}</span></div>}
              </div>
              <div className="project-actions">
                <button type="button" onClick={() => void downloadProject("json")}><FileJson size={14} /> JSON</button>
                <button type="button" onClick={() => void downloadProject("zip")}><PackageOpen size={14} /> ZIP</button>
                <span className="revision-chip">版本 {selected.revisionId.slice(0, 8)}</span>
              </div>
            </div>
            <div className="project-stage-layout">
            <nav className="stage-list professional" aria-label="工作阶段">
              {stages.map((stage, index) => (
                <button className={`stage-row ${activeStage === stage.id ? "active" : ""}`} key={stage.id} type="button" onClick={() => setActiveStage(stage.id)}>
                  <span>{String(index + 1).padStart(2, "0")}</span><strong>{stage.label}</strong><ChevronRight size={13} />
                </button>
              ))}
              <div className="stage-qualification"><ShieldCheck size={14} /><span>{dashboard?.qualificationLabel}</span></div>
            </nav>
            <div className="stage-content">

            {activeStage === "tasks" && (
              <section className="evidence-board task-overview-board">
                <header className="board-heading"><div><p className="eyebrow">TASK DEFINITION</p><h3>任务要求与成果目录</h3></div><button className="quiet-link" type="button" onClick={() => setActiveStage("issues")}>在问题流程中更新</button></header>
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
              </section>
            )}

            {activeStage === "evidence" && (
              <section className="evidence-board">
                <header className="board-heading">
                  <div><p className="eyebrow">PROJECT EVIDENCE</p><h3>原始资料与解析记录</h3></div>
                  <button className="upload-evidence" type="button" onClick={() => evidenceInput.current?.click()}><Upload size={14} /> 上传原始资料</button>
                  <input ref={evidenceInput} className="sr-only" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) void uploadEvidenceFiles(files); }} />
                </header>
                <div className="evidence-list">
                  {selected.snapshot.evidences.map((evidence) => {
                    const parse = selected.snapshot.parseRecords.find((record) => record.evidenceId === evidence.id);
                    return (
                      <article className="evidence-card" key={evidence.id}>
                        <span className="evidence-type">{evidence.evidenceType}</span>
                        <div><strong>{evidence.title}</strong><small>{parse?.parser ?? "未解析"} · {parse?.status ?? "pending"} · evidence {evidence.id}</small></div>
                        <span className={`data-status ${evidence.dataStatus}`}>{evidence.dataStatus === "available" ? "可用" : evidence.dataStatus}</span>
                        <button type="button" onClick={() => void downloadEvidence(evidence.assetId)}>原文件</button>
                      </article>
                    );
                  })}
                  {!selected.snapshot.evidences.length && (
                    <div className="evidence-empty"><div className="trace-spine" aria-hidden="true"><span /><span /><span /><span /></div><p>上传任务书、照片、测量记录或已有图纸。文件本体、证据记录和解析结果会一起进入项目版本。</p></div>
                  )}
                </div>
              </section>
            )}

            {activeStage === "measurements" && (
              <section className="evidence-board">
                <header className="board-heading"><div><p className="eyebrow">MEASUREMENT BASIS</p><h3>测量记录、事实与缺失影响</h3></div><span className="board-count">{selected.snapshot.measurements.length + selected.snapshot.facts.length} 条记录</span></header>
                {projectArchetypes.length ? (() => {
                  const archetype = projectArchetypes[projectArchetypes.length - 1]!;
                  const derivation = deriveArchetypeExpectations(archetype);
                  const comparisons = compareWithMeasuredFacts(derivation, selected.snapshot.facts);
                  return (
                    <div className="archetype-comparison">
                      <h4>形制应然值与实测对照（R014）</h4>
                      <p>系数组 {derivation.ruleSetId}（{derivation.ruleSetVersion.slice(0, 40)}）· 柱位 {derivation.layout.pillarCount} · 枋连接 {derivation.layout.fangCount}。应然值来源为规则推导，不覆盖实测，不作正式标注依据。</p>
                      <div className="record-table">
                        {comparisons.map((item) => (
                          <article key={item.dimension}>
                            <strong>{item.dimension}</strong>
                            <span>应然 {item.valueMm !== null ? `${item.valueMm} mm` : "按实计"}{item.toleranceText ? ` ${item.toleranceText}` : ""}</span>
                            <span>实测 {item.measuredMm !== null ? `${item.measuredMm} mm` : "无实测记录"}</span>
                            <small>{item.deltaMm !== null ? `差值 ${item.deltaMm} mm${item.withinTolerance === null ? "" : item.withinTolerance ? "，容差内" : "，超容差，进入现状记录候选"}` : "无差值可算"}</small>
                            <code>{item.sourceText}</code>
                          </article>
                        ))}
                      </div>
                    </div>
                  );
                })() : (
                  <form className="task-setup archetype-form" onSubmit={(event) => void registerArchetype(event)}>
                    <div><span className="node-label">形制模板</span><h4>登记形制参数（R014）</h4><p>规则按模板推导应然尺寸，实测值始终覆盖应然值；两层差异进入现状记录候选。</p></div>
                    <label>逐间面阔 mm（逗号分隔）<input name="bayX" required placeholder="例如 4800" /></label>
                    <label>逐间进深 mm（逗号分隔）<input name="bayY" required placeholder="例如 1800,1800" /></label>
                    <label>步架数<input name="stepCount" type="number" min="1" max="20" required placeholder="例如 3（七檩）" /></label>
                    <label>模数基参 D mm<input name="baseD" type="number" min="1" step="any" required placeholder="例如 380" /></label>
                    <label>举架系数组
                      <select name="liftRatioSetRef" defaultValue="qing-gongcheng-zuofa">
                        <option value="qing-gongcheng-zuofa">清工程做法系数组</option>
                        <option value="liang-drawings">梁思成图纸系数组</option>
                      </select>
                    </label>
                    <label>柱网坐标串<input name="pillarNet" required placeholder="例如 0/0,0/1,1/0,1/1" /></label>
                    <label>枋连接柱对串（可选）<input name="fangNet" placeholder="例如 0/0#1/0,0/1#1/1" /></label>
                    <label>形制判断来源<input name="sourceDeclaration" required placeholder="例如 团队演示 fixture r2 口径" /></label>
                    <button type="submit">登记并派生应然值</button>
                  </form>
                )}
                <div className="record-table">
                  {selected.snapshot.measurements.map((measurement) => <article key={measurement.id}><span className={`producer-badge ${measurement.producer.producerType}`}>{measurement.producer.producerType}</span><strong>{measurement.quantity.originalText} {measurement.quantity.originalUnit}</strong><small>{measurement.metadataStatus === "complete" ? "测量元数据完整" : "测量人、时间或方法仍缺失"}</small><code>{measurement.originalEvidenceRef}</code></article>)}
                  {selected.snapshot.facts.map((fact) => <article key={fact.id}><span className={`producer-badge ${fact.producer.producerType}`}>{fact.producer.producerType}</span><strong>{fact.field}</strong><small>{fact.reviewStatus} · {fact.dataStatus}</small><code>{fact.evidenceRefs.join(" · ") || "无证据引用"}</code></article>)}
                  {!selected.snapshot.measurements.length && !selected.snapshot.facts.length && <div className="panel-empty">没有可用尺寸事实。缺失时系统会阻断依赖成果，不使用默认值补齐。</div>}
                </div>
              </section>
            )}

            {activeStage === "objects" && (
              <section className="evidence-board">
                <header className="board-heading"><div><p className="eyebrow">HERITAGE OBJECTS</p><h3>对象、构件与稳定标识</h3></div><span className="board-count">{geometrySpec?.objects.length ?? selected.snapshot.entities.length} 个对象</span></header>
                <div className="object-table">
                  {(geometrySpec?.objects ?? []).map((object) => <button type="button" key={object.id} onClick={() => { setSelectedGeometryEntityId(object.id); setActiveStage("geometry"); }}><span>{object.displayNameZh}</span><code>{object.stableKey}</code><small>{typeLabel(object.componentType, object.conceptRef)} · {object.producer.producerType}</small><strong>{object.unknownRefs.length ? `${object.unknownRefs.length} 个未知项` : "来源已绑定"}</strong></button>)}
                  {!geometrySpec?.objects.length && selected.snapshot.entities.map((entity) => <article key={entity.id}><strong>{entity.name}</strong><span>{entity.entityType}</span><code>{entity.id}</code></article>)}
                  {!geometrySpec?.objects.length && !selected.snapshot.entities.length && <div className="panel-empty">当前没有构件对象。对象必须从当前项目资料或已验证的项目自有 GeometrySpec 建立。</div>}
                </div>
              </section>
            )}

            {activeStage === "candidates" && (
              <section className="evidence-board candidate-board">
                <header className="board-heading">
                  <div><p className="eyebrow">MODEL CANDIDATES</p><h3>AI 候选与真实运行记录</h3></div>
                  <button className="upload-evidence" type="button" disabled={!parsedEvidenceCount || Boolean(modelRunning) || !serverStatus?.modelConfigured} onClick={() => void runModel()}>
                    <Play size={14} /> {modelRunning ? "运行中" : "生成资料候选"}
                  </button>
                </header>
                <div className="transmission-note"><ShieldCheck size={15} /><span>仅发送当前项目内已解析的文本和内容哈希；原文件、浏览器存储和密钥不会发送给模型。</span></div>
                {!serverStatus?.modelConfigured && <p className="inline-warning">服务端尚未配置 KIMI_API_KEY，真实运行按钮已锁定。</p>}
                {!parsedEvidenceCount && <p className="inline-warning">先上传一份可解析的 UTF-8 文本或 JSON 资料。</p>}
                <div className="candidate-list">
                  {selected.snapshot.candidates.map((candidate) => (
                    <article className="candidate-card" key={candidate.id}>
                      <div className="candidate-meta"><span className="producer-badge model">模型</span><span>run {candidate.runId.slice(0, 8)}</span><span>{candidate.reviewStatus === "unreviewed" ? "待处理" : candidate.reviewStatus}</span></div>
                      <h4>{candidate.structured?.summary ?? "模型返回了未结构化候选"}</h4>
                      {!!candidate.structured?.findings.length && <div><strong>资料发现</strong><ul>{candidate.structured.findings.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                      {!!candidate.structured?.missingInformation.length && <div><strong>缺失信息</strong><ul>{candidate.structured.missingInformation.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                    </article>
                  ))}
                  {!selected.snapshot.candidates.length && <div className="panel-empty">模型结果只会进入候选区，不会自动成为项目事实。</div>}
                </div>
                {!!modelCostView.rows.length && <div className="run-ledger"><strong>运行账本与用量</strong>{modelCostView.rows.map((run) => <span key={run.runId}><b>{run.provider} / {run.model}</b><i>{run.status} · attempt {run.attempts}</i><em>{run.totalTokens ?? "—"} tokens · {run.costLabel}</em></span>)}<small>累计 {modelCostView.totalTokens} tokens；没有可靠单价依据，因此不估算费用。</small></div>}
              </section>
            )}

            {activeStage === "issues" && (
              <section className="evidence-board issue-board">
                <header className="board-heading">
                  <div><p className="eyebrow">ISSUE QUEUE</p><h3>问题队列与必要人工节点</h3></div>
                  <span className="issue-count">{openIssues.length} 个待处理</span>
                </header>
                <div className="provenance-legend" aria-label="来源图例">
                  <span className="producer-badge model">模型候选</span>
                  <span className="producer-badge rule">规则结果</span>
                  <span className="producer-badge human">人工决定</span>
                  <span className="producer-badge demo">演示数据</span>
                </div>
                {humanInterventions && <div className="human-node-summary"><article><strong>{humanInterventions.missingFieldFacts.length}</strong><span>现场事实缺失</span></article><article><strong>{humanInterventions.professionalChoices.length}</strong><span>非唯一专业选择</span></article><article><strong>{humanInterventions.groupedReviewRefs.length}</strong><span>成组审核 / 交付</span></article><small>规则确定项自动执行，不增加逐项确认。</small></div>}
                {!confirmedTask ? (
                  <form className="task-setup" onSubmit={(event) => void confirmTaskSetup(event)}>
                    <div><span className="node-label">人工节点 01</span><h4>一次确认任务设置</h4><p>范围、适用规范和责任角色只在任务开始时设置一次。满足自动条件的后续检查直接执行。</p></div>
                    <label>任务名称<input name="taskName" required defaultValue="资料整理与项目包验证" /></label>
                    <label>任务范围<textarea name="scope" required defaultValue={"整理原始资料\n生成 AI 候选\n处理证据缺失问题\n导出与回导项目包"} /></label>
                    <label>适用规范或项目约定<textarea name="regulations" defaultValue="项目资料真实性与来源追溯要求" /></label>
                    <label>成果目录<textarea name="deliverables" required placeholder="逐行填写当前任务要求的成果，不从样例补齐" /></label>
                    <label>图纸标题<input name="drawingTitle" required /></label>
                    <label>修订标记<input name="drawingRevision" required placeholder="例如 P1" /></label>
                    <label>几何目标角色<textarea name="geometryTargetRoles" required placeholder="逐行填写，例如 wall、support、roof；缺一项即阻断" /></label>
                    <label>图纸结构 JSON<textarea name="drawingSheets" required placeholder='[{"key":"sheet-1","drawingNumber":"P-01","displayLabelZh":"平面与立面","pageMm":[841,594]}]' /></label>
                    <label>视图结构 JSON<textarea name="drawingViews" required placeholder="逐项提供 kind、比例、sheetKey、viewportRectMm、方向、目标构件和局部证据；详图缺局部证据时不生成" /></label>
                    <button type="submit">确认一次任务设置</button>
                  </form>
                ) : (
                  <>
                    <div className="task-summary"><span className="node-label complete">人工节点 01 已完成</span><strong>{confirmedTask.name}</strong><small>{confirmedTask.scope.join(" · ")}</small></div>
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
                        <div className="issue-meta"><span className={`issue-severity ${issue.issueType}`}>{issue.issueType}</span><span className="producer-badge rule">规则</span><span>{issue.sourceRef.replace("rule:", "")}</span></div>
                        <h4>{issue.description}</h4>
                        {issue.options?.length ? (
                          <div className="decision-actions option-decision">
                            <p>存在多套有依据的规范方案，选择其一并记录出处；此选择可在后续版本中变更。</p>
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
                  <section><strong>人工决定</strong>{projectDecisions.slice(-4).reverse().map((decision) => <span key={decision.id}><b className="producer-badge human">人工</b>{decision.outcome} · {decision.decidedAt.slice(0, 19).replace("T", " ")}</span>)}{!projectDecisions.length && <small>尚无人工决定</small>}</section>
                </div>
              </section>
            )}

            {activeStage === "geometry" && (
              <section className="evidence-board geometry-board">
                <header className="board-heading">
                  <div><p className="eyebrow">GEOMETRY REVISION</p><h3>项目驱动三维模型</h3></div>
                  <button className="upload-evidence" type="button" disabled={!geometryGate?.ready || Boolean(cadProgress && !["succeeded", "failed", "cancelled"].includes(cadProgress.phase))} onClick={() => void generateDemoGeometry()}>
                    <Play size={14} /> {geometryRevision ? "生成新代理版本" : "生成代理几何"}
                  </button>
                </header>
                <div className="transmission-note"><ShieldCheck size={15} /><span>浏览器冻结 GeometrySpec 与输入哈希；Node 只接收受限结构，Python worker 不接收 URL、提示或用户文件路径。</span></div>
                {!geometryGate?.ready && (
                  <div className="geometry-gate">
                    <strong>建立代理几何前，需从当前项目资料逐构件确认几何事实</strong>
                    <p>每个构件和界面必须定位到当前项目具体证据；不得用百分比、固定厚度或其他项目数据补齐。当前缺失：{geometryGate?.missing.join("、")}</p>
                    {!!selected.snapshot.evidences.length && (
                      <form className="geometry-fact-form" onSubmit={(event) => void confirmGeometryFacts(event)}>
                        <label>构件事实 JSON<textarea name="geometryComponents" required placeholder="每项包含 stableKey、构件类型、可证实体、证据 ID、图号/页码位置和结构化未知项" /></label>
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
                      <span className="qualification-chip">代理成果 · 未签发 · L1=false</span>
                      <h4>{selectedGeometryEntity?.displayNameZh ?? "选择模型构件查看来源"}</h4>
                      {selectedGeometryEntity ? <>
                        <dl>
                          <div><dt>稳定键</dt><dd>{selectedGeometryEntity.stableKey}</dd></div>
                          <div><dt>构件类型</dt><dd>{typeLabel(selectedGeometryEntity.componentType, selectedGeometryEntity.conceptRef)}（{selectedGeometryEntity.componentType}）</dd></div>
                          <div><dt>来源</dt><dd>{selectedGeometryEntity.producer.producerType}</dd></div>
                          <div><dt>证据</dt><dd>{selectedGeometryEntity.evidenceRefs.length} 项</dd></div>
                        </dl>
                        {selectedGeometryEntity.unknownRefs.map((id) => {
                          const unknown = geometrySpec?.unknowns.find((item) => item.id === id);
                          return unknown ? <div className="unknown-card" key={id}><strong>{unknown.reasonCode}</strong><p>{unknown.description}</p><small>正式资格阻断：{unknown.blocksFormalEligibility ? "是" : "否"}</small></div> : null;
                        })}
                      </> : <p>点击模型中的构件，查看稳定 ID、证据引用、未知项和资格影响。</p>}
                      <hr />
                      <small>GeometryRevision {geometryRevision.id.slice(0, 8)} · {geometryRevision.geometrySignature.slice(0, 12)}…</small>
                      <small>{geometrySpec?.objects.length ?? 0} 个实体 · {geometrySpec?.interfaces.length ?? 0} 个界面 · {geometrySpec?.unknowns.length ?? 0} 个未知项</small>
                    </aside>
                  </div>
                ) : (
                  <div className="panel-empty">尚未建立 GeometryRevision。此入口先验证通用几何内核，不宣称项目已有实测三维成果。</div>
                )}
              </section>
            )}

            {activeStage === "drawings" && (
              <section className="evidence-board drawing-board">
                <header className="board-heading">
                  <div><p className="eyebrow">SOURCE-BOUND DRAWINGS</p><h3>成组平立剖与节点详图</h3></div>
                  <button className="upload-evidence" type="button" disabled={!geometryRevision || !confirmedTask || Boolean(drawingProgress && !["succeeded", "failed"].includes(drawingProgress))} onClick={() => void generateDrawings()}>
                    <Images size={14} /> {drawingProgress && !["succeeded", "failed"].includes(drawingProgress) ? "生成中" : "按成果目录生成"}
                  </button>
                </header>
                <div className="transmission-note"><ShieldCheck size={15} /><span>图种、图幅和布局来自当前任务成果目录；所有结构线从当前 GeometryRevision 求交或投影生成。</span></div>
                {drawingArtifacts.length ? (
                  <><div className="drawing-preview-grid" aria-label="成组图纸预览">
                    {drawingPreviewUrls.map((preview) => preview.kind === "svg"
                      ? <figure key={preview.id}><img src={preview.url} alt={`${preview.label} 矢量预览`} /><figcaption>{preview.label}</figcaption></figure>
                      : <figure key={preview.id}><object data={preview.url} type="application/pdf" aria-label={`${preview.label} PDF 预览`} /><figcaption>{preview.label}</figcaption></figure>)}
                  </div><div className="artifact-list">
                    {drawingArtifacts.map((artifact) => <button type="button" key={artifact.id} onClick={() => void downloadArtifact(artifact)}><span>{artifact.kind}</span><strong>{artifact.fileName}</strong><small>{Math.round(artifact.byteLength / 1024)} KB · {artifact.sha256.slice(0, 12)}…</small></button>)}
                  </div></>
                ) : <div className="panel-empty">先生成当前项目的 GeometryRevision，再按已确认成果目录生成 DXF、SVG、PDF、预览、Drawing IR 和来源映射。</div>}
                {latestCheckRun && <div className="check-summary"><FileCheck2 size={18} /><div><strong>检查记录 {latestCheckRun.id.slice(0, 8)}</strong>{latestCheckRun.results.map((item) => <p key={item.code} className={item.outcome}>{item.outcome === "passed" ? "通过" : "阻断"} · {item.message}</p>)}</div></div>}
              </section>
            )}

            {activeStage === "checks" && (
              <section className="evidence-board checks-board">
                <header className="board-heading"><div><p className="eyebrow">CHECKS & QUALIFICATION</p><h3>检查、未知项与资格边界</h3></div><span className="qualification-chip">generated-not-qualified · L1=false</span></header>
                <div className="summary-grid">
                  <article><span>当前几何</span><strong>{geometryRevision ? geometryRevision.id.slice(0, 8) : "未建立"}</strong><small>{geometrySpec?.unknowns.length ?? 0} 个结构化未知项</small></article>
                  <article><span>当前成果</span><strong>{artifactSetView?.currentArtifacts.length ?? 0} 项</strong><small>{artifactSetView?.crossRevisionArtifactCount ?? 0} 项旧版本成果已隔离</small></article>
                  <article><span>检查结论</span><strong>{latestCheckRun ? latestCheckRun.results.filter((result) => result.outcome === "blocked").length ? "存在阻断" : "技术检查完成" : "尚未检查"}</strong><small>技术通过不授予专业资格</small></article>
                </div>
                {latestCheckRun ? <div className="check-register">{latestCheckRun.results.map((result) => <article key={result.code} className={result.outcome}><span>{result.outcome === "passed" ? "通过" : "阻断"}</span><strong>{result.code}</strong><p>{result.message}</p><code>{result.sourceRefs.join(" · ") || "system check"}</code></article>)}</div> : <div className="panel-empty">当前 GeometryRevision 尚无绑定的检查运行。检查不会自动授予 L1 或签发状态。</div>}
                {!!dashboard?.blockerCodes.length && <div className="delivery-blockers"><strong>当前阻断原因</strong>{dashboard.blockerCodes.map((code) => <p key={code}>{code}</p>)}</div>}
              </section>
            )}

            {activeStage === "package" && (
              <section className="evidence-board package-board">
                <header className="board-heading"><div><p className="eyebrow">PROXY DELIVERY</p><h3>代理成果交付与项目包</h3></div><button className="upload-evidence" type="button" disabled={!geometryRevision || !latestCheckRun || !drawingArtifacts.length || Boolean(latestDelivery)} onClick={() => void createProxyDelivery()}><PackageOpen size={14} /> 建立代理交付草案</button></header>
                {latestDelivery ? <div className="delivery-status"><span className="qualification-chip">代理成果 · 未签发 · L1=false</span><strong>交付草案 {latestDelivery.id.slice(0, 8)}</strong><p>{latestDelivery.restrictions.join(" · ")}</p></div> : deliveries.blockers(selected).length ? <div className="delivery-blockers"><strong>当前阻断</strong>{deliveries.blockers(selected).map((item) => <p key={item}>{item}</p>)}<button type="button" disabled={Boolean(latestBlockedDelivery)} onClick={() => void recordBlockedDelivery()}>{latestBlockedDelivery ? "已记录正式交付阻断" : "记录正式交付阻断"}</button></div> : null}
                <div className="package-grid">
                  <article><FileJson /><strong>project.json</strong><p>适合检查结构化记录，不包含二进制文件本体。</p><button type="button" onClick={() => void downloadProject("json")}>导出 JSON</button></article>
                  <article><PackageOpen /><strong>project.gujian.zip</strong><p>包含资料、许可、模型/规则/人工记录、GeometryRevision、图纸成果、检查、交付草案和审计事件。</p><button type="button" onClick={() => void downloadProject("zip")}>导出代理 ZIP</button></article>
                </div>
                <section className="roundtrip-check">
                  <div>
                    <ShieldCheck size={17} />
                    <span><strong>空库回导验证</strong><small>以当前项目、当前版本实时生成 JSON 与 ZIP。先校验 JSON 结构回导，再由原 ZIP 恢复完整资料；不使用预置项目。</small></span>
                  </div>
                  <button type="button" onClick={() => void verifyEmptyLibraryRoundTrip()}>验证 JSON 与 ZIP 空库回导</button>
                  {roundTripReceipt && (
                    <dl aria-label="空库回导结果">
                      <div><dt>项目</dt><dd>{roundTripReceipt.projectId.slice(0, 8).toUpperCase()}</dd></div>
                      <div><dt>来源版本</dt><dd>{roundTripReceipt.sourceRevisionId.slice(0, 8)}</dd></div>
                      <div><dt>回导版本</dt><dd>{roundTripReceipt.importedRevisionId.slice(0, 8)}</dd></div>
                      <div><dt>资料</dt><dd>{roundTripReceipt.evidenceCount}</dd></div>
                      <div><dt>规则</dt><dd>{roundTripReceipt.ruleRunCount}</dd></div>
                      <div><dt>人工决定</dt><dd>{roundTripReceipt.decisionCount}</dd></div>
                      <div><dt>几何版本</dt><dd>{roundTripReceipt.geometryRevisionCount}</dd></div>
                      <div><dt>成果</dt><dd>{roundTripReceipt.artifactCount}</dd></div>
                      <div><dt>检查</dt><dd>{roundTripReceipt.checkRunCount}</dd></div>
                      <div><dt>交付</dt><dd>{roundTripReceipt.deliveryCount}</dd></div>
                      <div><dt>JSON 结构</dt><dd>{roundTripReceipt.jsonEvidenceCount} 份资料 · {roundTripReceipt.jsonMissingAssetCount} 个文件待补</dd></div>
                      <div><dt>JSON SHA-256</dt><dd>{roundTripReceipt.jsonSha256.slice(0, 12)}…</dd></div>
                      <div><dt>ZIP SHA-256</dt><dd>{roundTripReceipt.zipSha256.slice(0, 12)}…</dd></div>
                    </dl>
                  )}
                </section>
              </section>
            )}
            </div>
            </div>
          </div>
        ) : (
          <div className="empty-workspace">
            <div className="trace-spine" aria-hidden="true"><span /><span /><span /><span /></div>
            <div className="empty-copy">
              <p className="eyebrow">MILESTONE ONE</p>
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
        <div className="assistant-title"><Bot size={17} /><strong>助手与来源</strong><button type="button" onClick={() => setAssistantCollapsed(true)} aria-label="收起助手与来源面板"><PanelRightClose size={15} /></button></div>
        <p>{selected ? "对助手下达操作指令，写入与作业类动作需逐条确认后生效。" : "选中项目后，可在这里对助手下达操作指令。"}</p>
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
            <strong>运行 {modelProgress.runId.slice(0, 8)}</strong>
            <p>{modelProgress.streamedText || "正在建立受控运行……"}</p>
            {modelRunning && <button type="button" onClick={() => void modelRuns.cancel()}><CircleStop size={14} /> 取消运行</button>}
            <small>{modelProgress.events.length} 条运行事件</small>
          </div>
        ) : (
          <>
            <div className="assistant-event"><span />密钥不进入浏览器</div>
            <div className="assistant-event"><span />模型结果只进入候选区</div>
            <div className="assistant-event"><span />版本写入由命令服务控制</div>
          </>
        )}
        {provenance && <section className="provenance-track" aria-label="证据关系轨道">
          <header><Link2 size={14} /><strong>{selectedGeometryEntity ? "所选构件来源链" : "当前项目来源链"}</strong></header>
          <div>{provenance.nodes.map((node) => <article className={node.status} key={node.key}><i /><span><strong>{node.label}</strong><small>{node.count ? `${node.count} 项已关联` : "缺失"}</small></span></article>)}</div>
          <footer>{provenance.unknownCount} 个未知项 · {provenance.formalBlockerCount} 个正式资格阻断</footer>
        </section>}
        </>}
      </aside>
      {showCreate && (
        <div className="modal-backdrop" role="presentation">
          <form className="create-dialog" onSubmit={(event) => void handleCreate(event)}>
            <button className="close-dialog" type="button" onClick={() => setShowCreate(false)} aria-label="关闭"><X size={17} /></button>
            <Building2 size={20} />
            <p className="eyebrow">NEW PROJECT</p>
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
