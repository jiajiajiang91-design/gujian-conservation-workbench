import {
  Archive,
  Building2,
  ChevronRight,
  Download,
  FileArchive,
  FolderKanban,
  Plus,
  Search,
  Upload,
} from 'lucide-react'
import type { ProjectSummary } from '../infrastructure/indexeddb-repository'

interface ProjectCatalogProps {
  projects: ProjectSummary[]
  query: string
  busy: boolean
  onQueryChange: (query: string) => void
  onOpenProject: (projectId: string) => void
  onCreate: () => void
  onImport: () => void
  onLoadExamples: () => void
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function ProjectCatalog({
  projects,
  query,
  busy,
  onQueryChange,
  onOpenProject,
  onCreate,
  onImport,
  onLoadExamples,
}: ProjectCatalogProps) {
  const filtered = projects.filter((project) =>
    project.name.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN')),
  )

  return (
    <div className="catalog-layout">
      <aside className="catalog-sidebar">
        <div className="product-mark" aria-label="古建保护成果工作台">
          <span className="product-mark__icon"><Building2 size={18} /></span>
          <span>
            <strong>古建成果工作台</strong>
            <small>代理验证环境</small>
          </span>
        </div>
        <nav className="catalog-nav" aria-label="项目分类">
          <button className="catalog-nav__item is-active" type="button">
            <FolderKanban size={16} />全部项目<span>{projects.length}</span>
          </button>
          <button className="catalog-nav__item" type="button" disabled>
            <Archive size={16} />已归档
          </button>
        </nav>
        <div className="catalog-sidebar__note">
          <FileArchive size={16} />
          <p>项目数据保存在当前浏览器的独立 v2 数据库中。</p>
        </div>
      </aside>

      <main className="catalog-main">
        <header className="catalog-header">
          <div>
            <p className="page-kicker">项目管理</p>
            <h1>保护成果项目</h1>
            <p>创建任务、导入资料包，并进入成果工作区。</p>
          </div>
          <div className="header-actions">
            <button className="button button--secondary" type="button" onClick={onImport}>
              <Upload size={16} />导入项目
            </button>
            <button className="button button--primary" type="button" onClick={onCreate}>
              <Plus size={16} />新建项目
            </button>
          </div>
        </header>

        <section className="catalog-toolbar" aria-label="项目筛选">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">搜索项目</span>
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="按项目名称搜索"
            />
          </label>
          <span className="toolbar-count">{filtered.length} 个项目</span>
        </section>

        {filtered.length > 0 ? (
          <section className="project-grid" aria-label="项目列表">
            {filtered.map((project) => (
              <button
                className="project-card"
                type="button"
                key={project.projectId}
                onClick={() => onOpenProject(project.projectId)}
              >
                <span className="project-card__icon"><Building2 size={20} /></span>
                <span className="project-card__body">
                  <span className="project-card__topline">
                    <strong>{project.name}</strong>
                    <span className="status-badge status-badge--neutral">进行中</span>
                  </span>
                  <span className="project-card__meta">
                    <span>更新于 {formatDate(project.updatedAt)}</span>
                    <span className="mono">v{project.currentRevisionId.slice(0, 8)}</span>
                  </span>
                  <span className="project-card__audit">
                    {project.auditIncluded ? '审计记录完整' : '未包含完整审计正文'}
                  </span>
                </span>
                <ChevronRight size={18} className="project-card__chevron" />
              </button>
            ))}
          </section>
        ) : (
          <section className="empty-state">
            <span className="empty-state__icon"><FolderKanban size={24} /></span>
            <h2>{query ? '没有匹配的项目' : '建立第一个项目'}</h2>
            <p>
              {query
                ? '调整搜索词，或返回全部项目。'
                : '可以从空任务开始，也可以加载高都和东呈两套独立演示数据。'}
            </p>
            {!query && (
              <div className="empty-state__actions">
                <button className="button button--primary" type="button" onClick={onCreate}>
                  <Plus size={16} />新建项目
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={onLoadExamples}
                  disabled={busy}
                >
                  <Download size={16} />{busy ? '正在载入…' : '加载两套演示项目'}
                </button>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  )
}
