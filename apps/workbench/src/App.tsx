import { Archive, ArrowRight, Bot, FolderKanban, Search } from "lucide-react"

const stages = ["项目资料", "AI 候选", "问题处理", "项目包"]

export function App() {
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
          <p className="eyebrow">项目档案台</p>
          <h1>古建保护<br />成果工作台</h1>
        </header>
        <label className="search-field">
          <Search size={15} />
          <span className="sr-only">搜索项目</span>
          <input placeholder="搜索项目、建筑或任务" />
        </label>
        <div className="stage-list" aria-label="工作阶段">
          {stages.map((stage, index) => (
            <div className="stage-row" key={stage}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{stage}</strong>
            </div>
          ))}
        </div>
        <footer>本地优先 · IndexedDB v3</footer>
      </section>
      <section className="workspace-shell">
        <div className="topbar">
          <div>
            <span className="status-dot" />
            <strong>工作台基础服务就绪</strong>
          </div>
          <span className="muted">Kimi K2.6 · 服务端密钥</span>
        </div>
        <div className="empty-workspace">
          <div className="trace-spine" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <div className="empty-copy">
            <p className="eyebrow">里程碑一</p>
            <h2>从一份原始资料开始</h2>
            <p>建立项目后，资料、模型候选、人工决定和导出包将在同一条证据链上显示。</p>
            <button type="button">进入项目目录 <ArrowRight size={16} /></button>
          </div>
        </div>
      </section>
      <aside className="assistant-shell">
        <div className="assistant-title"><Bot size={17} /><strong>AI 项目助手</strong></div>
        <p>服务将在选中项目后显示任务、流式运行和用量记录。</p>
        <div className="assistant-event"><span />密钥不进入浏览器</div>
        <div className="assistant-event"><span />模型结果只进候选区</div>
      </aside>
    </main>
  )
}
