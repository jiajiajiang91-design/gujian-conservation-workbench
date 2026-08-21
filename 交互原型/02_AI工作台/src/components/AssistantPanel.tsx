import { Bot, ChevronRight, PanelRightClose, Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'

interface AssistantPanelProps {
  stageLabel: string
  collapsed: boolean
  onToggle: () => void
  onSuggestedAction?: () => void
  suggestedActionLabel?: string
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export function AssistantPanel({
  stageLabel,
  collapsed,
  onToggle,
  onSuggestedAction,
  suggestedActionLabel,
}: AssistantPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: '我会说明当前阶段的阻断项和下一步。本地面板不会自行写入项目，也没有把演示内容记录为模型结果。',
    },
  ])

  if (collapsed) {
    return (
      <aside className="assistant-collapsed">
        <button className="icon-button" type="button" onClick={onToggle} aria-label="展开工作助手">
          <Bot size={18} />
        </button>
      </aside>
    )
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const text = String(data.get('message') ?? '').trim()
    if (!text) return
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', text },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `当前位于“${stageLabel}”。请先核对页面中的证据、状态和阻断原因；需要改变项目时，请使用页面上的受控操作。`,
      },
    ])
    event.currentTarget.reset()
  }

  return (
    <aside className="assistant-panel" aria-label="工作助手">
      <header className="assistant-panel__header">
        <span><Bot size={17} /><span><strong>工作助手</strong><small>本地建议 · 未调用模型</small></span></span>
        <button className="icon-button" type="button" onClick={onToggle} aria-label="收起工作助手">
          <PanelRightClose size={17} />
        </button>
      </header>
      <div className="assistant-context">
        <small>当前阶段</small><strong>{stageLabel}</strong>
      </div>
      <div className="assistant-messages" aria-live="polite">
        {messages.map((message) => (
          <div className={`assistant-message assistant-message--${message.role}`} key={message.id}>
            {message.text}
          </div>
        ))}
        {suggestedActionLabel && onSuggestedAction && (
          <button className="assistant-suggestion" type="button" onClick={onSuggestedAction}>
            {suggestedActionLabel}<ChevronRight size={15} />
          </button>
        )}
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        <label>
          <span className="sr-only">向工作助手提问</span>
          <textarea name="message" rows={2} maxLength={500} placeholder="询问当前阶段或阻断原因" />
        </label>
        <button className="icon-button icon-button--primary" type="submit" aria-label="发送">
          <Send size={16} />
        </button>
      </form>
    </aside>
  )
}
