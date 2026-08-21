import { ArrowRight, CheckCircle2, Database, FileOutput, Sparkles } from 'lucide-react'

interface ProvenanceStripProps {
  source: { title: string; detail: string }
  producer: { title: string; detail: string }
  review: { title: string; detail: string }
  result: { title: string; detail: string }
}

export function ProvenanceStrip({ source, producer, review, result }: ProvenanceStripProps) {
  const nodes = [
    { icon: Database, label: '输入或证据', ...source },
    { icon: Sparkles, label: '产生方式', ...producer },
    { icon: CheckCircle2, label: '人工核对', ...review },
    { icon: FileOutput, label: '成果版本', ...result },
  ]
  return (
    <section className="provenance-strip" aria-label="来源关系">
      {nodes.map((node, index) => {
        const Icon = node.icon
        return (
          <div className="provenance-step-wrap" key={node.label}>
            <div className="provenance-step">
              <span className="provenance-step__icon"><Icon size={16} /></span>
              <span><small>{node.label}</small><strong>{node.title}</strong><em>{node.detail}</em></span>
            </div>
            {index < nodes.length - 1 && <ArrowRight className="provenance-arrow" size={16} />}
          </div>
        )
      })}
    </section>
  )
}
