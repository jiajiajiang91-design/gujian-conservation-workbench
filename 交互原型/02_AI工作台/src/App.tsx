import { useCallback, useEffect, useState } from 'react'
import gaoduProject from '../data/v2/gaodu.project.json'
import dongchengProject from '../data/v2/dongcheng.project.json'
import { projectCommands, projectPackages, proxyActor, repository } from './app/services'
import { CreateProjectDialog, ImportProjectDialog } from './components/Dialogs'
import { ProjectCatalog } from './components/ProjectCatalog'
import { Workspace } from './components/Workspace'
import type { ValidationReport } from './application/package-contract'
import type { ProjectSummary } from './infrastructure/indexeddb-repository'

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string>()
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<'create' | 'import'>()
  const [busy, setBusy] = useState(false)
  const [importFile, setImportFile] = useState<File>()
  const [importReport, setImportReport] = useState<ValidationReport>()
  const [importAsCopy, setImportAsCopy] = useState(false)
  const [catalogNotice, setCatalogNotice] = useState<string>()

  const refresh = useCallback(async () => {
    setProjects(await repository.list())
  }, [])

  useEffect(() => {
    void repository
      .recoverStagingImports()
      .then(refresh)
      .catch((error) => setCatalogNotice(error instanceof Error ? error.message : String(error)))
  }, [refresh])

  const createProject = async (value: { name: string; buildingName: string; taskTitle: string }) => {
    setBusy(true)
    try {
      const projectId = crypto.randomUUID()
      const result = await projectCommands.execute({
        id: crypto.randomUUID(),
        projectId,
        type: 'CreateProject',
        actor: proxyActor,
        expectedRevisionId: null,
        issuedAt: new Date().toISOString(),
        payload: value,
      })
      if (!result.ok) throw new Error(result.message)
      await refresh()
      setDialog(undefined)
      setActiveProjectId(projectId)
    } catch (error) {
      setCatalogNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const loadExamples = async () => {
    setBusy(true)
    setCatalogNotice(undefined)
    let loaded = 0
    for (const fixture of [gaoduProject, dongchengProject]) {
      try {
        await projectPackages.importProjectJson(
          new Blob([JSON.stringify(fixture)], { type: 'application/json' }),
        )
        loaded += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/Constraint|PROJECT_EXISTS|事务/.test(message)) setCatalogNotice(message)
      }
    }
    await refresh()
    setBusy(false)
    if (loaded > 0) setCatalogNotice(`已载入 ${loaded} 套独立演示项目。`)
  }

  const inspectImportFile = async (file: File) => {
    setImportFile(file)
    setImportReport(undefined)
    setImportReport(await projectPackages.validate(file))
  }

  const confirmImport = async () => {
    if (!importFile || !importReport?.valid) return
    setBusy(true)
    try {
      const header = new Uint8Array(await importFile.slice(0, 4).arrayBuffer())
      const options = { onConflict: importAsCopy ? ('copy' as const) : ('reject' as const) }
      const result =
        header[0] === 0x50 && header[1] === 0x4b
          ? await projectPackages.importPackage(importFile, options)
          : await projectPackages.importProjectJson(importFile, options)
      await refresh()
      setDialog(undefined)
      setImportFile(undefined)
      setImportReport(undefined)
      setActiveProjectId(result.projectId)
    } catch (error) {
      setImportReport({
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
      })
    } finally {
      setBusy(false)
    }
  }

  if (activeProjectId) {
    return (
      <Workspace
        projectId={activeProjectId}
        onBack={() => setActiveProjectId(undefined)}
        onProjectChanged={refresh}
      />
    )
  }

  return (
    <>
      <ProjectCatalog
        projects={projects}
        query={query}
        busy={busy}
        onQueryChange={setQuery}
        onOpenProject={setActiveProjectId}
        onCreate={() => setDialog('create')}
        onImport={() => setDialog('import')}
        onLoadExamples={() => void loadExamples()}
      />
      {catalogNotice && (
        <div className="catalog-toast" role="status">
          {catalogNotice}
          <button type="button" onClick={() => setCatalogNotice(undefined)} aria-label="关闭提示">×</button>
        </div>
      )}
      {dialog === 'create' && (
        <CreateProjectDialog
          busy={busy}
          onClose={() => setDialog(undefined)}
          onSubmit={createProject}
        />
      )}
      {dialog === 'import' && (
        <ImportProjectDialog
          file={importFile}
          report={importReport}
          busy={busy}
          importAsCopy={importAsCopy}
          onFile={(file) => void inspectImportFile(file)}
          onCopyChange={setImportAsCopy}
          onConfirm={confirmImport}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
  )
}
