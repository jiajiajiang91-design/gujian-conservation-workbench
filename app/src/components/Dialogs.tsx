import { FileJson, PackageCheck, X } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import type { PackagePreview, ValidationReport } from '../application/package-contract'

interface ModalProps {
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
}

export function Modal({ title, description, children, onClose }: ModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__header">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

interface CreateProjectDialogProps {
  busy: boolean
  onClose: () => void
  onSubmit: (value: { name: string; buildingName: string; taskTitle: string }) => Promise<void>
}

export function CreateProjectDialog({ busy, onClose, onSubmit }: CreateProjectDialogProps) {
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    await onSubmit({
      name: String(data.get('name') ?? ''),
      buildingName: String(data.get('buildingName') ?? ''),
      taskTitle: String(data.get('taskTitle') ?? ''),
    })
  }
  return (
    <Modal
      title="新建保护成果项目"
      description="建立空项目和第一项任务。资料、对象和成果在进入工作区后补充。"
      onClose={onClose}
    >
      <form className="dialog__body form-stack" onSubmit={submit}>
        <label className="form-field">
          <span>项目名称</span>
          <input name="name" required maxLength={200} placeholder="例如：某院落现状归档" autoFocus />
        </label>
        <label className="form-field">
          <span>首栋建筑</span>
          <input name="buildingName" required maxLength={200} defaultValue="正房" />
        </label>
        <label className="form-field">
          <span>任务名称</span>
          <input name="taskTitle" required maxLength={200} defaultValue="现状记录与成果归档" />
        </label>
        <div className="dialog__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? '正在建立…' : '建立项目'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface ImportProjectDialogProps {
  file?: File
  report?: ValidationReport
  busy: boolean
  importAsCopy: boolean
  onFile: (file: File) => void
  onCopyChange: (value: boolean) => void
  onConfirm: () => Promise<void>
  onClose: () => void
}

function Preview({ preview }: { preview: PackagePreview }) {
  return (
    <div className="import-preview">
      <span className="import-preview__icon"><PackageCheck size={20} /></span>
      <dl>
        <div><dt>项目</dt><dd>{preview.projectName}</dd></div>
        <div><dt>格式</dt><dd>{preview.packageKind}</dd></div>
        <div><dt>资源</dt><dd>{preview.assetCount} 个</dd></div>
        <div><dt>审计</dt><dd>{preview.auditIncluded ? '已包含' : '未包含'}</dd></div>
      </dl>
      {preview.warnings.length > 0 && (
        <ul className="warning-list">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      )}
    </div>
  )
}

export function ImportProjectDialog({
  file,
  report,
  busy,
  importAsCopy,
  onFile,
  onCopyChange,
  onConfirm,
  onClose,
}: ImportProjectDialogProps) {
  return (
    <Modal
      title="导入结构化项目"
      description="支持 project.json 和 .gujian.zip。系统会先校验边界、哈希和数据关系。"
      onClose={onClose}
    >
      <div className="dialog__body form-stack">
        <label className="file-picker">
          <FileJson size={20} />
          <span><strong>{file?.name ?? '选择项目文件'}</strong><small>JSON 或 ZIP，校验通过后才写入项目库</small></span>
          <input
            type="file"
            accept=".json,.zip,.gujian.zip,application/json,application/zip"
            onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])}
          />
        </label>
        {report?.valid && report.preview && <Preview preview={report.preview} />}
        {report && !report.valid && (
          <div className="inline-alert inline-alert--danger">
            <strong>文件未通过校验</strong>
            <p>{report.errors[0]}</p>
          </div>
        )}
        <label className="check-field">
          <input
            type="checkbox"
            checked={importAsCopy}
            onChange={(event) => onCopyChange(event.target.checked)}
          />
          <span>项目 ID 冲突时导入为副本；副本会重新建立内部 ID，且不冒充原审计链。</span>
        </label>
        <div className="dialog__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button
            className="button button--primary"
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy || !report?.valid}
          >
            {busy ? '正在导入…' : '确认导入'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
