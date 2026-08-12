import {
  AlertTriangle,
  ArrowLeft,
  Box,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Download,
  FileCheck2,
  FileOutput,
  Files,
  FolderInput,
  LayoutDashboard,
  Menu,
  PackageCheck,
  PanelRightOpen,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import gaoduProxyInput from '../../data/v2/gaodu.proxy-input.json'
import dongchengSketchInput from '../../data/v2/dongcheng.evidence-sketch-input.json'
import {
  EvidenceSketchInputSchema,
  ProxyDrawingInputSchema,
  type Artifact,
  type Observation,
} from '../domain'
import type { RepositoryExport } from '../infrastructure/indexeddb-repository'
import { artifacts, deliveries, projectCommands, projectPackages, proxyActor, proxyActorName, repository } from '../app/services'
import { downloadBlob } from '../ui/download'
import { AssistantPanel } from './AssistantPanel'
import { ProvenanceStrip } from './ProvenanceStrip'

type Stage = 'overview' | 'evidence' | 'objects' | 'issues' | 'artifacts' | 'delivery'

const stages = [
  { id: 'overview' as const, label: '项目概览', icon: LayoutDashboard },
  { id: 'evidence' as const, label: '资料与证据', icon: Files },
  { id: 'objects' as const, label: '对象与现状', icon: Box },
  { id: 'issues' as const, label: '人工问题', icon: ShieldAlert },
  { id: 'artifacts' as const, label: '成果与检查', icon: FileOutput },
  { id: 'delivery' as const, label: '交付与归档', icon: PackageCheck },
]

const artifactLabels: Record<Artifact['kind'], string> = {
  'elevation-svg': '代理立面 SVG',
  'elevation-dxf': '代理立面 DXF',
  'evidence-sketch-svg': '证据草图 SVG',
  'project-data': '结构化项目数据',
  'check-report': '检查报告',
  'delivery-manifest': '交付清单',
  'audit-log': '审计记录',
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function producerLabel(observation: Observation): string {
  const labels = { model: '模型候选核对后形成', rule: '规则结果', human: '人工记录', demo: '演示数据' }
  return labels[observation.producer.producerType]
}

interface WorkspaceProps {
  projectId: string
  onBack: () => void
  onProjectChanged: () => void
}

export function Workspace({ projectId, onBack, onProjectChanged }: WorkspaceProps) {
  const [aggregate, setAggregate] = useState<RepositoryExport>()
  const [stage, setStage] = useState<Stage>('overview')
  const [assistantCollapsed, setAssistantCollapsed] = useState(false)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'info'; text: string }>()

  const load = useCallback(async () => {
    const value = await repository.loadExport(projectId)
    setAggregate(value)
    setSelectedArtifactId((current) =>
      current && value.transfer.artifacts.some((artifact) => artifact.id === current)
        ? current
        : value.transfer.artifacts.find((artifact) => artifact.status === 'valid')?.id,
    )
  }, [projectId])

  useEffect(() => {
    void load().catch((error) =>
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) }),
    )
  }, [load])

  const run = async (action: () => Promise<string>) => {
    setBusy(true)
    setNotice(undefined)
    try {
      const text = await action()
      await load()
      await onProjectChanged()
      setNotice({ tone: 'success', text })
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const transfer = aggregate?.transfer
  const snapshot = transfer?.revision
  const revisionId = snapshot?.revision.id
  const selectedArtifact = transfer?.artifacts.find((artifact) => artifact.id === selectedArtifactId)
  const currentStage = stages.find((item) => item.id === stage)!

  const canUseGaoduFixture = projectId === '11000000-0000-4000-8000-000000000001'
  const canUseDongchengFixture = projectId === '22000000-0000-4000-8000-000000000001'
  const canGenerateDemo = canUseGaoduFixture || canUseDongchengFixture

  const generateDemo = () =>
    run(async () => {
      if (!revisionId) throw new Error('项目版本尚未载入')
      const result = canUseGaoduFixture
        ? await artifacts.generateElevation(
            projectId,
            revisionId,
            ProxyDrawingInputSchema.parse(gaoduProxyInput),
            proxyActor,
          )
        : canUseDongchengFixture
          ? await artifacts.generateEvidenceSketch(
              projectId,
              revisionId,
              EvidenceSketchInputSchema.parse(dongchengSketchInput),
              proxyActor,
            )
          : undefined
      if (!result) throw new Error('当前项目没有独立代理输入，不能套用其他项目数据')
      if (!result.command.ok) throw new Error(result.command.message)
      return canUseGaoduFixture
        ? '已生成代理 SVG、DXF 和检查报告。'
        : '已生成五开间证据草图和资料不足报告；尺寸立面仍保持阻断。'
    })

  const confirmProxy = () =>
    run(async () => {
      if (!revisionId) throw new Error('项目版本尚未载入')
      const result = await deliveries.confirmProxy(
        projectId,
        revisionId,
        proxyActor,
        '确认本次只生成代理交付，限制、来源和未决问题继续保留。',
      )
      if (!result.ok) throw new Error(result.message)
      return '已记录一次代理交付确认，不会创建正式签发。'
    })

  const createDelivery = () =>
    run(async () => {
      if (!revisionId) throw new Error('项目版本尚未载入')
      const result = await deliveries.createProxy(projectId, revisionId, proxyActor)
      if (!result.command.ok) throw new Error(result.command.message)
      if (result.blob && result.packageAssetId) {
        downloadBlob(result.blob, `${snapshot?.project.name ?? 'project'}-proxy-delivery.gujian.zip`)
      }
      return '代理交付包已生成、保存并开始下载。'
    })

  const resolveIssue = (issueId: string) =>
    run(async () => {
      if (!revisionId) throw new Error('项目版本尚未载入')
      const result = await projectCommands.execute({
        id: crypto.randomUUID(),
        projectId,
        type: 'ResolveIssue',
        actor: proxyActor,
        expectedRevisionId: revisionId,
        issuedAt: new Date().toISOString(),
        payload: { issueId, reason: '代理复核：已核对当前影响范围，处理结果保留在审计记录中。' },
      })
      if (!result.ok) throw new Error(result.message)
      return '问题已由代理复核角色处理并留痕。'
    })

  const downloadArtifact = async (artifact: Artifact) => {
    try {
      const asset = await repository.getAsset(artifact.assetId)
      downloadBlob(asset.content, asset.record.fileName)
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const exportJson = async () => {
    if (!revisionId) return
    const blob = await projectPackages.exportProjectJson(projectId, revisionId)
    downloadBlob(blob, `${snapshot?.project.name ?? 'project'}.project.json`)
  }

  const exportArchive = async () => {
    if (!revisionId) return
    const result = await projectPackages.exportPackage(projectId, revisionId, 'project-archive')
    downloadBlob(result.blob, `${snapshot?.project.name ?? 'project'}.gujian.zip`)
  }

  const relation = useMemo(() => {
    if (!selectedArtifact || !snapshot) {
      return {
        source: { title: '项目当前版本', detail: revisionId?.slice(0, 8) ?? '载入中' },
        producer: { title: '受控业务命令', detail: '不从页面直接改数据' },
        review: { title: '按问题处理', detail: '只保留必要人工节点' },
        result: { title: '尚未选择成果', detail: '选择成果后查看具体关系' },
      }
    }
    const isSketch = selectedArtifact.kind === 'evidence-sketch-svg'
    const confirmation = transfer?.decisions.find((decision) => decision.choice === 'confirm-proxy')
    return {
      source: {
        title: isSketch ? '五开间位置框选' : '独立 demo 制图输入',
        detail: isSketch ? '不含实测尺寸' : '与项目事实分开保存',
      },
      producer: { title: `代理生成器 ${selectedArtifact.generatorVersion}`, detail: '规则计算，不是模型结果' },
      review: {
        title: confirmation ? '已确认代理范围' : '尚未确认代理交付',
        detail: confirmation ? `${confirmation.actorRole} · ${formatDate(confirmation.decidedAt)}` : '不等同正式签发',
      },
      result: {
        title: artifactLabels[selectedArtifact.kind],
        detail: `基于版本 ${selectedArtifact.sourceRevisionId.slice(0, 8)}`,
      },
    }
  }, [revisionId, selectedArtifact, snapshot, transfer?.decisions])

  if (!snapshot || !transfer) {
    return <div className="loading-screen"><RefreshCw size={20} className="spin" />正在载入项目…</div>
  }

  const openIssues = snapshot.issues.filter((issue) => issue.status === 'open')
  const validArtifacts = transfer.artifacts.filter((artifact) => artifact.status === 'valid')
  const requiredProxyArtifactKinds = ['elevation-svg', 'elevation-dxf', 'check-report'] as const
  const hasRequiredProxyArtifacts = requiredProxyArtifactKinds.every((kind) =>
    validArtifacts.some((artifact) => artifact.kind === kind),
  )
  const hasProxyConfirmation = transfer.decisions.some((decision) => decision.choice === 'confirm-proxy')
  const deliveryBlockers = [
    ...(!hasRequiredProxyArtifacts ? ['缺少立面 SVG、DXF 或检查报告'] : []),
    ...(!hasProxyConfirmation ? ['尚未确认代理交付范围'] : []),
  ]
  const canCreateProxyDelivery = deliveryBlockers.length === 0
  const modelCandidateCount = snapshot.candidates.filter(
    (candidate) => candidate.producer.producerType === 'model',
  ).length

  return (
    <div className={`workspace-shell ${assistantCollapsed ? 'assistant-is-collapsed' : ''}`}>
      <header className="workspace-topbar">
        <button className="icon-button" type="button" onClick={onBack} aria-label="返回项目列表"><ArrowLeft size={18} /></button>
        <div className="workspace-identity">
          <span className="workspace-identity__mark"><Menu size={16} /></span>
          <span><strong>{snapshot.project.name}</strong><small>{snapshot.project.code ?? '未设置项目编号'} · 版本 {snapshot.revision.number}</small></span>
        </div>
        <div className="workspace-topbar__meta">
          <span className="status-badge status-badge--warning">代理验证</span>
          <span>{proxyActorName} · 复核角色</span>
          {assistantCollapsed && (
            <button className="icon-button" type="button" onClick={() => setAssistantCollapsed(false)} aria-label="展开工作助手"><PanelRightOpen size={17} /></button>
          )}
        </div>
      </header>

      <aside className="stage-sidebar">
        <p className="stage-sidebar__label">任务阶段</p>
        <nav aria-label="工作阶段">
          {stages.map((item) => {
            const Icon = item.icon
            const count =
              item.id === 'issues' ? openIssues.length : item.id === 'artifacts' ? validArtifacts.length : undefined
            return (
              <button
                key={item.id}
                className={`stage-nav-item ${stage === item.id ? 'is-active' : ''}`}
                type="button"
                onClick={() => setStage(item.id)}
              >
                <Icon size={16} /><span>{item.label}</span>{count !== undefined && <em>{count}</em>}
              </button>
            )
          })}
        </nav>
        <div className="stage-sidebar__summary">
          <small>正式资格</small>
          <strong><AlertTriangle size={14} />本轮锁定</strong>
          <p>缺少真实身份、权限与签名能力。</p>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="workspace-page-header">
          <div><p className="page-kicker">{snapshot.tasks[0]?.title ?? '项目任务'}</p><h1>{currentStage.label}</h1></div>
          <div className="header-actions">
            <button className="button button--secondary" type="button" onClick={() => void exportJson()}><Download size={15} />项目 JSON</button>
            <button className="button button--secondary" type="button" onClick={() => void exportArchive()}><FolderInput size={15} />项目归档包</button>
          </div>
        </header>

        {notice && <div className={`inline-alert inline-alert--${notice.tone}`}>{notice.text}</div>}

        <ProvenanceStrip {...relation} />

        {stage === 'overview' && (
          <div className="workspace-content">
            <section className="metric-grid">
              <article><span><Database size={17} /></span><small>资料记录</small><strong>{snapshot.evidence.length}</strong><em>{snapshot.evidence.length ? '已登记' : '保持缺失'}</em></article>
              <article><span><Box size={17} /></span><small>对象</small><strong>{snapshot.entities.length}</strong><em>{snapshot.entities.filter((entity) => entity.kind === 'bay').length} 个开间对象</em></article>
              <article><span><AlertTriangle size={17} /></span><small>未决问题</small><strong>{openIssues.length}</strong><em>{openIssues.filter((issue) => ['high', 'critical'].includes(issue.severity)).length} 个高风险</em></article>
              <article><span><FileOutput size={17} /></span><small>有效成果</small><strong>{validArtifacts.length}</strong><em>{transfer.deliveries.length} 次代理交付</em></article>
            </section>
            <section className="panel">
              <header className="panel__header"><div><h2>流程状态</h2><p>系统自动推进技术检查，只把异常与高风险问题留给人工。</p></div></header>
              <div className="workflow-list">
                {[
                  ['任务范围', snapshot.tasks[0]?.scopeConfirmedAt ? '已确认' : '待确认'],
                  ['资料与对象', snapshot.evidence.length ? '已建立关系' : '资料缺失'],
                  ['模型候选', modelCandidateCount ? `${modelCandidateCount} 条待核对` : '没有真实模型结果'],
                  ['成果生成', validArtifacts.length ? `${validArtifacts.length} 项有效成果` : '尚未生成'],
                  ['正式签发', '能力未启用'],
                ].map(([label, value], index) => (
                  <div className="workflow-row" key={label}><span>{index + 1}</span><strong>{label}</strong><em>{value}</em></div>
                ))}
              </div>
            </section>
          </div>
        )}

        {stage === 'evidence' && (
          <div className="workspace-content">
            <section className="panel">
              <header className="panel__header"><div><h2>资料清单</h2><p>权属、用途和保密声明只提取已有内容；缺失时不推断。</p></div><span className="status-badge status-badge--neutral">{snapshot.evidence.length} 项</span></header>
              {snapshot.evidence.length ? (
                <div className="data-table">
                  <div className="data-table__head"><span>类型</span><span>质量</span><span>关联对象</span><span>导入时间</span></div>
                  {snapshot.evidence.map((record) => <div className="data-table__row" key={record.id}><span>{record.evidenceType}</span><span>{record.quality}</span><span>{record.relatedEntityRefs.length}</span><span>{formatDate(record.importedAt)}</span></div>)}
                </div>
              ) : (
                <div className="panel-empty"><Files size={22} /><strong>当前没有可用资料资源</strong><p>项目保留资料缺失状态，不会按文件名或远程地址自动补齐。</p></div>
              )}
            </section>
          </div>
        )}

        {stage === 'objects' && (
          <div className="workspace-content">
            <section className="panel">
              <header className="panel__header"><div><h2>建筑与构件对象</h2><p>对象关系来自结构化数据，不依赖页面位置或固定三开间模板。</p></div></header>
              <div className="object-list">
                {snapshot.entities.map((entity) => (
                  <article key={entity.id}><span className="object-list__icon"><Box size={16} /></span><span><strong>{entity.name}</strong><small>{entity.kind} · {entity.parentId ? '下级对象' : '建筑层级'}</small></span><code>{entity.id.slice(0, 8)}</code></article>
                ))}
              </div>
            </section>
            {snapshot.observations.length > 0 && (
              <section className="panel">
                <header className="panel__header"><div><h2>现状记录</h2><p>产生来源、核对状态、数据状态和正式资格分开显示。</p></div></header>
                <div className="record-list">
                  {snapshot.observations.map((record) => (
                    <article key={record.id}><div><strong>{record.field}</strong><p>{typeof record.value === 'string' ? record.value : `${record.value.value} ${record.value.unit}`}</p></div><div className="record-tags"><span>{producerLabel(record)}</span><span>{record.reviewStatus}</span><span>{record.dataStatus}</span><span className={record.formalEligibility.eligible ? 'is-success' : 'is-danger'}>{record.formalEligibility.eligible ? '可用于正式成果' : record.formalEligibility.blockerCodes.join(', ')}</span></div></article>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {stage === 'issues' && (
          <div className="workspace-content">
            <section className="panel">
              <header className="panel__header"><div><h2>人工问题队列</h2><p>这里只保留证据不足、专业存疑、规则冲突和高风险问题。</p></div><span className={`status-badge ${openIssues.length ? 'status-badge--danger' : 'status-badge--success'}`}>{openIssues.length} 项未决</span></header>
              <div className="issue-list">
                {snapshot.issues.map((issue) => (
                  <article className={issue.status === 'resolved' ? 'is-resolved' : ''} key={issue.id}>
                    <span className={`issue-severity issue-severity--${issue.severity}`}><AlertTriangle size={15} /></span>
                    <div><span className="issue-list__top"><strong>{issue.type}</strong><em>{issue.severity}</em></span><p>{issue.blockerCodes.join(' · ') || '没有阻断码'}</p><small>影响 {issue.subjectRefs.length} 个对象 · {issue.status}</small></div>
                    {issue.status === 'open' && <button className="button button--secondary button--small" type="button" onClick={() => void resolveIssue(issue.id)} disabled={busy}><ClipboardCheck size={14} />复核处理</button>}
                  </article>
                ))}
                {snapshot.issues.length === 0 && <div className="panel-empty"><CheckCircle2 size={22} /><strong>当前没有人工问题</strong><p>后续资料或规则变化可能重新产生问题。</p></div>}
              </div>
            </section>
          </div>
        )}

        {stage === 'artifacts' && (
          <div className="workspace-content">
            <section className="panel">
              <header className="panel__header"><div><h2>成果版本</h2><p>成果由固定项目版本生成；业务数据变化后，受影响成果会失效。</p></div>{canGenerateDemo && <button className="button button--primary" type="button" onClick={() => void generateDemo()} disabled={busy}><Sparkles size={15} />{busy ? '正在生成…' : '生成代理成果'}</button>}</header>
              <div className="artifact-list">
                {transfer.artifacts.map((artifact) => (
                  <div className={`artifact-row ${selectedArtifactId === artifact.id ? 'is-selected' : ''}`} key={artifact.id}>
                    <button className="artifact-select" type="button" onClick={() => setSelectedArtifactId(artifact.id)}>
                      <span className="artifact-row__icon"><FileCheck2 size={17} /></span><span><strong>{artifactLabels[artifact.kind]}</strong><small>{artifact.generatorVersion} · {formatDate(artifact.createdAt)}</small></span><span className={`status-badge ${artifact.status === 'valid' ? 'status-badge--success' : 'status-badge--neutral'}`}>{artifact.status}</span><span className="mono">{artifact.sha256.slice(0, 10)}</span>
                    </button>
                    <button className="artifact-download" type="button" onClick={() => void downloadArtifact(artifact)} aria-label={`下载${artifactLabels[artifact.kind]}`}><Download size={15} /></button>
                  </div>
                ))}
                {transfer.artifacts.length === 0 && <div className="panel-empty"><FileOutput size={22} /><strong>尚未生成成果</strong><p>{canGenerateDemo ? '使用与项目分开的代理输入生成可验证文件。' : '请先补齐项目输入；系统不会套用其他项目的几何。'}</p></div>}
              </div>
            </section>
          </div>
        )}

        {stage === 'delivery' && (
          <div className="workspace-content delivery-grid">
            <section className="panel">
              <header className="panel__header"><div><h2>代理交付</h2><p>确认一次代理范围后生成 ZIP；正式签发始终锁定。</p></div><span className={`status-badge ${canCreateProxyDelivery ? 'status-badge--success' : 'status-badge--danger'}`}>{canCreateProxyDelivery ? '可以生成' : '当前阻断'}</span></header>
              {!canCreateProxyDelivery && (
                <div className="delivery-blockers" role="status">
                  <AlertTriangle size={17} />
                  <div><strong>尚未满足代理交付条件</strong><p>{deliveryBlockers.join('；')}</p></div>
                </div>
              )}
              <div className="delivery-actions">
                <article><span>1</span><div><strong>确认代理交付范围</strong><p>保留演示来源、未决问题和使用限制。</p></div><button className="button button--secondary" type="button" onClick={() => void confirmProxy()} disabled={busy || hasProxyConfirmation}>{hasProxyConfirmation ? '已确认' : '确认代理范围'}</button></article>
                <article><span>2</span><div><strong>生成交付包</strong><p>包含项目数据、真实生成成果、检查报告、审计和清单。</p></div><button className="button button--primary" type="button" onClick={() => void createDelivery()} disabled={busy || transfer.deliveries.length > 0 || !canCreateProxyDelivery}>生成并下载</button></article>
              </div>
            </section>
            <section className="panel formal-lock"><ShieldAlert size={22} /><div><h2>正式签发未启用</h2><p>缺少真实实测证据、责任身份、组织权限和签名服务。本环境不会用代理确认代替正式签发。</p></div></section>
            {transfer.deliveries.length > 0 && <section className="panel"><header className="panel__header"><div><h2>交付记录</h2><p>每次交付引用固定成果和项目版本。</p></div></header>{transfer.deliveries.map((delivery) => <div className="delivery-record" key={delivery.id}><PackageCheck size={18} /><span><strong>代理交付</strong><small>{formatDate(delivery.createdAt)} · {delivery.artifactIds.length} 项成果</small></span><code>{delivery.id.slice(0, 8)}</code></div>)}</section>}
          </div>
        )}
      </main>

      <AssistantPanel
        stageLabel={currentStage.label}
        collapsed={assistantCollapsed}
        onToggle={() => setAssistantCollapsed((value) => !value)}
        suggestedActionLabel={stage === 'artifacts' && canGenerateDemo ? '生成当前项目的代理成果' : undefined}
        onSuggestedAction={stage === 'artifacts' && canGenerateDemo ? () => void generateDemo() : undefined}
      />
    </div>
  )
}
