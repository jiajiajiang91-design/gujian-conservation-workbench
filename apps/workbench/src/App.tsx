import { Archive, Bot, Building2, FolderKanban, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ProjectHead, ProjectSummary } from "@gujian/application";

import { createLocalProject, listLocalProjects, projectRepository } from "./workbench";

const stages = ["项目资料", "AI 候选", "问题处理", "项目包"];

export function App() {
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectHead | null>(null);
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => setProjects(await listLocalProjects());
  useEffect(() => { void refresh().catch((reason: unknown) => setError(String(reason))); }, []);

  const filtered = useMemo(
    () => projects.filter((project) => `${project.name}${project.buildingName}`.toLowerCase().includes(query.toLowerCase())),
    [projects, query],
  );

  const chooseProject = async (projectId: string) => {
    setError(null);
    setSelected(await projectRepository.getProjectHead(projectId));
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
      setShowCreate(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败");
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
        <footer>本地优先 · IndexedDB v3</footer>
      </section>
      <section className="workspace-shell">
        <div className="topbar">
          <div><span className="status-dot" /><strong>{selected ? selected.snapshot.project.name : "工作台基础服务就绪"}</strong></div>
          <span className="muted">Kimi K2.6 · 密钥仅服务端读取</span>
        </div>
        {selected ? (
          <div className="project-workspace">
            <div className="project-heading">
              <div>
                <p className="eyebrow">ACTIVE PROJECT</p>
                <h2>{selected.snapshot.buildings[0]?.name}</h2>
                <p>{selected.snapshot.project.locationText ?? "地点尚未记录"}</p>
              </div>
              <span className="revision-chip">版本 {selected.revisionId.slice(0, 8)}</span>
            </div>
            <div className="stage-list horizontal" aria-label="工作阶段">
              {stages.map((stage, index) => <div className="stage-row" key={stage}><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage}</strong></div>)}
            </div>
            <section className="evidence-board">
              <div className="trace-spine" aria-hidden="true"><span /><span /><span /><span /></div>
              <div>
                <p className="eyebrow">EVIDENCE CHAIN</p>
                <h3>项目骨架已经建立</h3>
                <p>所有后续资料、候选、规则结果和人工决定都将通过唯一命令入口形成新版本。</p>
              </div>
            </section>
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
      </section>
      <aside className="assistant-shell">
        <div className="assistant-title"><Bot size={17} /><strong>AI 项目助手</strong></div>
        <p>选中项目后，这里将显示任务、流式运行、取消和用量记录。</p>
        <div className="assistant-event"><span />密钥不进入浏览器</div>
        <div className="assistant-event"><span />模型结果只进入候选区</div>
        <div className="assistant-event"><span />版本写入由命令服务控制</div>
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
