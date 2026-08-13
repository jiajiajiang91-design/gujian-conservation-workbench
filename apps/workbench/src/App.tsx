import {
  Archive, Bot, Building2, CircleStop, Download, FileJson, FolderKanban,
  PackageOpen, Play, Plus, Search, ShieldCheck, Trash2, Upload, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ProjectHead, ProjectSummary } from "@gujian/application";
import type { Decision, ModelRun, RuleRun } from "@gujian/domain";
import type { GeometryRevision } from "@gujian/domain";

import type { ModelRunProgress } from "./model-run-client";
import type { CadJobProgress } from "./cad-job-client";
import { GlbViewer } from "./GlbViewer";
import {
  cadJobs, createLocalProject, evidenceIngestion, listLocalProjects, localActorId,
  modelRuns, projectPackages, projectRepository,
  workflow,
} from "./workbench";

const stages = [
  { id: "evidence", label: "项目资料" },
  { id: "candidates", label: "AI 候选" },
  { id: "issues", label: "问题处理" },
  { id: "geometry", label: "三维模型" },
  { id: "package", label: "项目包" },
] as const;
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
}

export function App() {
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectHead | null>(null);
  const [projectModelRuns, setProjectModelRuns] = useState<readonly ModelRun[]>([]);
  const [projectRuleRuns, setProjectRuleRuns] = useState<readonly RuleRun[]>([]);
  const [projectDecisions, setProjectDecisions] = useState<readonly Decision[]>([]);
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({});
  const [activeStage, setActiveStage] = useState<StageId>("evidence");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelRunProgress | null>(null);
  const [cadProgress, setCadProgress] = useState<CadJobProgress | null>(null);
  const [geometryBlob, setGeometryBlob] = useState<Blob | null>(null);
  const [selectedGeometryEntityId, setSelectedGeometryEntityId] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [roundTripReceipt, setRoundTripReceipt] = useState<RoundTripReceipt | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const evidenceInput = useRef<HTMLInputElement>(null);

  const refresh = async () => setProjects(await listLocalProjects());
  const loadProject = async (projectId: string) => {
    const head = await projectRepository.getProjectHead(projectId);
    const [runs, rules, decisions] = await Promise.all([
      projectRepository.getProjectModelRuns(projectId),
      projectRepository.getProjectRuleRuns(projectId),
      projectRepository.getProjectDecisions(projectId),
    ]);
    setSelected(head);
    setProjectModelRuns(runs);
    setProjectRuleRuns(rules);
    setProjectDecisions(decisions);
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
  const geometrySpec = selected && geometryRevision
    ? selected.snapshot.geometrySpecs.find((item) => item.id === geometryRevision.geometrySpecId) ?? null
    : null;
  const selectedGeometryEntity = geometrySpec?.objects.find((item) => item.id === selectedGeometryEntityId) ?? null;

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
      const outcome = await cadJobs.startDemoGeometry(selected, localActorId(), setCadProgress);
      setSelected(outcome.head);
      await refresh();
      setNotice("项目驱动 GeometryRevision 已生成；仍为代理成果、未签发、L1=false");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "几何作业失败");
    }
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
      await projectRepository.clearAllData();
      setSelected(null);
      setProjectModelRuns([]);
      setProjectRuleRuns([]);
      setProjectDecisions([]);

      const jsonProjectId = await projectPackages.import(jsonBytes, "roundtrip.project.json", localActorId());
      const jsonHead = await projectRepository.getProjectHead(jsonProjectId);
      if (!jsonHead) throw new Error("JSON_ROUNDTRIP_PROJECT_MISSING");
      const jsonAssets = await projectRepository.getProjectAssets(jsonProjectId);
      const jsonMissingAssetCount = jsonAssets.filter(({ record, content }) => record.contentStatus === "missing" && content === null).length;
      if (
        jsonHead.projectId !== expected.projectId
        || !jsonHead.snapshot.adoptedRecordRefs.includes(`revision:${expected.revisionId}`)
        || jsonHead.snapshot.evidences.length !== expected.evidenceIds.length
        || jsonMissingAssetCount !== expected.assetIds.length
      ) {
        throw new Error("JSON_ROUNDTRIP_IDENTITY_MISMATCH");
      }

      await projectRepository.clearAllData();
      const importedProjectId = await projectPackages.import(zipBytes, "roundtrip.gujian.zip", localActorId());
      const importedHead = await projectRepository.getProjectHead(importedProjectId);
      if (!importedHead) throw new Error("ROUNDTRIP_PROJECT_MISSING");
      const importedEvidenceIds = importedHead.snapshot.evidences.map((item) => item.id).sort();
      const importedAssetIds = importedHead.snapshot.evidences.map((item) => item.assetId).sort();
      if (
        importedHead.projectId !== expected.projectId
        || !importedHead.snapshot.adoptedRecordRefs.includes(`revision:${expected.revisionId}`)
        || JSON.stringify(importedEvidenceIds) !== JSON.stringify(expected.evidenceIds)
        || JSON.stringify(importedAssetIds) !== JSON.stringify(expected.assetIds)
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
        jsonEvidenceCount: jsonHead.snapshot.evidences.length,
        jsonMissingAssetCount,
        zipSha256,
        zipBytes: zipBytes.byteLength,
        projectId: importedProjectId,
        sourceRevisionId: expected.revisionId,
        importedRevisionId: importedHead.revisionId,
        evidenceCount: importedHead.snapshot.evidences.length,
        ruleRunCount: rules.length,
        decisionCount: decisions.length,
      });
      setNotice("已用当前项目依次完成 JSON 结构回导和 ZIP 完整资料回导");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "空库回导校验失败");
      await refresh();
    }
  };

  const uploadEvidence = async (file: File) => {
    if (!selected) return;
    setError(null);
    try {
      const updated = await evidenceIngestion.ingest(selected, localActorId(), file);
      const evaluated = await workflow.evaluate(updated, localActorId());
      setSelected(evaluated);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(updated.projectId));
      await refresh();
      setNotice(`资料“${file.name}”已保存并建立来源关系`);
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
        deliverables: ["结构化项目包", "AI 资料候选与问题清单"],
      });
      setSelected(updated);
      setProjectRuleRuns(await projectRepository.getProjectRuleRuns(selected.projectId));
      await refresh();
      setNotice("任务范围、规范和责任角色已一次确认");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务设置失败");
    }
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

  return (
    <main className="app-shell">
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
            </button>
          ))}
          {!filtered.length && <p className="empty-list">还没有项目。先建立一份可追溯的项目档案。</p>}
        </div>
        <footer><span>本地优先 · IndexedDB v3</span><button type="button" onClick={() => void clearLibrary()}><Trash2 size={12} /> 清空本地库</button></footer>
      </section>
      <section className="workspace-shell">
        <div className="topbar">
          <div><span className="status-dot" /><strong>{selected ? selected.snapshot.project.name : "工作台基础服务就绪"}</strong></div>
          <span className="muted">{serverStatus?.model ?? "Kimi K2.6"} · {serverStatus?.modelConfigured ? "服务端已配置" : "等待服务端密钥"}</span>
        </div>
        {selected ? (
          <div className="project-workspace">
            <div className="project-heading">
              <div>
                <p className="eyebrow">ACTIVE PROJECT</p>
                <h2>{selected.snapshot.buildings[0]?.name}</h2>
                <p>{selected.snapshot.project.locationText ?? "地点尚未记录"}</p>
              </div>
              <div className="project-actions">
                <button type="button" onClick={() => void downloadProject("json")}><FileJson size={14} /> JSON</button>
                <button type="button" onClick={() => void downloadProject("zip")}><PackageOpen size={14} /> ZIP</button>
                <span className="revision-chip">版本 {selected.revisionId.slice(0, 8)}</span>
              </div>
            </div>
            <div className="stage-list horizontal" aria-label="工作阶段">
              {stages.map((stage, index) => (
                <button className={`stage-row ${activeStage === stage.id ? "active" : ""}`} key={stage.id} type="button" onClick={() => setActiveStage(stage.id)}>
                  <span>{String(index + 1).padStart(2, "0")}</span><strong>{stage.label}</strong>
                </button>
              ))}
            </div>

            {activeStage === "evidence" && (
              <section className="evidence-board">
                <header className="board-heading">
                  <div><p className="eyebrow">PROJECT EVIDENCE</p><h3>原始资料与解析记录</h3></div>
                  <button className="upload-evidence" type="button" onClick={() => evidenceInput.current?.click()}><Upload size={14} /> 上传原始资料</button>
                  <input ref={evidenceInput} className="sr-only" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadEvidence(file); }} />
                </header>
                <div className="evidence-list">
                  {selected.snapshot.evidences.map((evidence) => {
                    const parse = selected.snapshot.parseRecords.find((record) => record.evidenceId === evidence.id);
                    return (
                      <article className="evidence-card" key={evidence.id}>
                        <span className="evidence-type">{evidence.evidenceType}</span>
                        <div><strong>{evidence.title}</strong><small>{parse?.parser ?? "未解析"} · {parse?.status ?? "pending"}</small></div>
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
                {!!projectModelRuns.length && <div className="run-ledger"><strong>运行账本</strong>{projectModelRuns.map((run) => <span key={run.id}>{run.startedAt.slice(0, 19).replace("T", " ")} · {run.model} · {run.status} · {run.usage?.totalTokens ?? 0} tokens</span>)}</div>}
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
                {!confirmedTask ? (
                  <form className="task-setup" onSubmit={(event) => void confirmTaskSetup(event)}>
                    <div><span className="node-label">人工节点 01</span><h4>一次确认任务设置</h4><p>范围、适用规范和责任角色只在任务开始时设置一次。满足自动条件的后续检查直接执行。</p></div>
                    <label>任务名称<input name="taskName" required defaultValue="资料整理与项目包验证" /></label>
                    <label>任务范围<textarea name="scope" required defaultValue={"整理原始资料\n生成 AI 候选\n处理证据缺失问题\n导出与回导项目包"} /></label>
                    <label>适用规范或项目约定<textarea name="regulations" defaultValue="项目资料真实性与来源追溯要求" /></label>
                    <button type="submit">确认一次任务设置</button>
                  </form>
                ) : (
                  <div className="task-summary"><span className="node-label complete">人工节点 01 已完成</span><strong>{confirmedTask.name}</strong><small>{confirmedTask.scope.join(" · ")}</small></div>
                )}
                <div className="issue-list">
                  {openIssues.filter((issue) => issue.sourceRef !== "rule:task-setup-required").map((issue) => {
                    const candidate = selected.snapshot.candidates.find((item) => issue.subjectRefs.includes(item.id));
                    const canDecide = issue.sourceRef === "rule:model-candidate-review" && candidate?.reviewStatus === "unreviewed";
                    return (
                      <article className="issue-card" key={issue.id}>
                        <div className="issue-meta"><span className={`issue-severity ${issue.issueType}`}>{issue.issueType}</span><span className="producer-badge rule">规则</span><span>{issue.sourceRef.replace("rule:", "")}</span></div>
                        <h4>{issue.description}</h4>
                        {canDecide ? (
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
                  <button className="upload-evidence" type="button" disabled={Boolean(cadProgress && !["succeeded", "failed", "cancelled"].includes(cadProgress.phase))} onClick={() => void generateDemoGeometry()}>
                    <Play size={14} /> {geometryRevision ? "生成新代理版本" : "生成代理几何"}
                  </button>
                </header>
                <div className="transmission-note"><ShieldCheck size={15} /><span>浏览器冻结 GeometrySpec 与输入哈希；Node 只接收受限结构，Python worker 不接收 URL、提示或用户文件路径。</span></div>
                {geometryRevision && geometryBlob ? (
                  <div className="geometry-workspace">
                    <GlbViewer blob={geometryBlob} onSelect={setSelectedGeometryEntityId} />
                    <aside className="geometry-inspector">
                      <span className="qualification-chip">代理成果 · 未签发 · L1=false</span>
                      <h4>{selectedGeometryEntity?.displayNameZh ?? "选择模型构件查看来源"}</h4>
                      {selectedGeometryEntity ? <>
                        <dl>
                          <div><dt>稳定键</dt><dd>{selectedGeometryEntity.stableKey}</dd></div>
                          <div><dt>构件类型</dt><dd>{selectedGeometryEntity.componentType}</dd></div>
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

            {activeStage === "package" && (
              <section className="evidence-board package-board">
                <header className="board-heading"><div><p className="eyebrow">PROJECT PACKAGE</p><h3>结构化项目包</h3></div></header>
                <div className="package-grid">
                  <article><FileJson /><strong>project.json</strong><p>适合检查结构化记录，不包含二进制文件本体。</p><button type="button" onClick={() => void downloadProject("json")}>导出 JSON</button></article>
                  <article><PackageOpen /><strong>project.gujian.zip</strong><p>包含资料、模型与规则运行、人工决定和审计事件，可用于空库回导。</p><button type="button" onClick={() => void downloadProject("zip")}>导出 ZIP</button></article>
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
                      <div><dt>JSON 结构</dt><dd>{roundTripReceipt.jsonEvidenceCount} 份资料 · {roundTripReceipt.jsonMissingAssetCount} 个文件待补</dd></div>
                      <div><dt>JSON SHA-256</dt><dd>{roundTripReceipt.jsonSha256.slice(0, 12)}…</dd></div>
                      <div><dt>ZIP SHA-256</dt><dd>{roundTripReceipt.zipSha256.slice(0, 12)}…</dd></div>
                    </dl>
                  )}
                </section>
              </section>
            )}
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
      <aside className="assistant-shell">
        <div className="assistant-title"><Bot size={17} /><strong>AI 项目助手</strong></div>
        <p>{selected ? "当前助手只整理已解析资料，生成结果留在候选区。" : "选中项目后，这里显示流式运行、取消和用量记录。"}</p>
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
