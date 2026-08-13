import {
  Archive, Bot, Building2, CircleStop, Download, FileJson, FolderKanban,
  PackageOpen, Play, Plus, Search, ShieldCheck, Trash2, Upload, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ProjectHead, ProjectSummary } from "@gujian/application";
import type { ModelRun } from "@gujian/domain";

import type { ModelRunProgress } from "./model-run-client";
import {
  createLocalProject, evidenceIngestion, listLocalProjects, localActorId,
  modelRuns, projectPackages, projectRepository,
} from "./workbench";

const stages = [
  { id: "evidence", label: "项目资料" },
  { id: "candidates", label: "AI 候选" },
  { id: "issues", label: "问题处理" },
  { id: "package", label: "项目包" },
] as const;
type StageId = typeof stages[number]["id"];

interface ServerStatus {
  ready: boolean;
  model: string;
  modelConfigured: boolean;
}

export function App() {
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectHead | null>(null);
  const [projectModelRuns, setProjectModelRuns] = useState<readonly ModelRun[]>([]);
  const [activeStage, setActiveStage] = useState<StageId>("evidence");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelRunProgress | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const evidenceInput = useRef<HTMLInputElement>(null);

  const refresh = async () => setProjects(await listLocalProjects());
  const loadProject = async (projectId: string) => {
    const [head, runs] = await Promise.all([
      projectRepository.getProjectHead(projectId),
      projectRepository.getProjectModelRuns(projectId),
    ]);
    setSelected(head);
    setProjectModelRuns(runs);
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

  const chooseProject = async (projectId: string) => {
    setError(null);
    setModelProgress(null);
    await loadProject(projectId);
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
      setSelected(head);
      setProjectModelRuns([]);
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
    await refresh();
    setNotice("本地项目库已清空，可以验证空库回导");
  };

  const uploadEvidence = async (file: File) => {
    if (!selected) return;
    setError(null);
    try {
      const updated = await evidenceIngestion.ingest(selected, localActorId(), file);
      setSelected(updated);
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
      setSelected(outcome.head);
      setProjectModelRuns(await projectRepository.getProjectModelRuns(selected.projectId));
      setActiveStage("candidates");
      setNotice(outcome.candidate ? "Kimi 运行完成，结果已进入候选区" : `模型运行已记录：${outcome.run.status}`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型运行失败");
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
              <section className="evidence-board">
                <header className="board-heading"><div><p className="eyebrow">ISSUE QUEUE</p><h3>问题队列</h3></div></header>
                <div className="panel-empty">问题队列将在下一任务接入规则结果、人工决定和候选处理。</div>
              </section>
            )}

            {activeStage === "package" && (
              <section className="evidence-board package-board">
                <header className="board-heading"><div><p className="eyebrow">PROJECT PACKAGE</p><h3>结构化项目包</h3></div></header>
                <div className="package-grid">
                  <article><FileJson /><strong>project.json</strong><p>适合检查结构化记录，不包含二进制文件本体。</p><button type="button" onClick={() => void downloadProject("json")}>导出 JSON</button></article>
                  <article><PackageOpen /><strong>project.gujian.zip</strong><p>包含项目数据、资料文件和审计事件，可用于空库回导。</p><button type="button" onClick={() => void downloadProject("zip")}>导出 ZIP</button></article>
                </div>
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
