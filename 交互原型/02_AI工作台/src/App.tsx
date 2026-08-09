export function App() {
  return (
    <main className="scaffold-shell">
      <section className="scaffold-card" aria-labelledby="workbench-title">
        <p className="scaffold-eyebrow">代理验证环境</p>
        <h1 id="workbench-title">古建保护成果工作台</h1>
        <p className="scaffold-copy">
          新应用入口已建立。项目数据、业务命令和成果生成模块将在后续任务中接入。
        </p>
        <dl className="scaffold-status">
          <div>
            <dt>旧版入口</dt>
            <dd>保留</dd>
          </div>
          <div>
            <dt>当前入口</dt>
            <dd>React + TypeScript</dd>
          </div>
          <div>
            <dt>交付权限</dt>
            <dd>仅代理验证</dd>
          </div>
        </dl>
      </section>
    </main>
  )
}
