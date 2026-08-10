import 'fake-indexeddb/auto'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { IndexedDbProjectRepository, openWorkbenchDb } from '../infrastructure/indexeddb-repository'
import { createProjectFixture } from '../test/project-fixture'
import { ProjectPackageService } from './project-package-service'

function testRepository() {
  return new IndexedDbProjectRepository(openWorkbenchDb(`test-${crypto.randomUUID()}`))
}

describe('项目 JSON 与本地存储', () => {
  it('暂存项目不可见，短事务提交后才进入项目列表', async () => {
    const repository = testRepository()
    const fixture = createProjectFixture('暂存检查项目', { withAsset: true })
    const sessionId = crypto.randomUUID()

    await repository.stageImport(sessionId, fixture.transfer, fixture.contents)
    expect(await repository.list()).toEqual([])

    await repository.commitImport(sessionId, fixture.transfer, [], 0)
    expect((await repository.list()).map((project) => project.name)).toEqual(['暂存检查项目'])
  })

  it('project.json 可导入、选择和导出，重复导入不覆盖原项目', async () => {
    const repository = testRepository()
    const service = new ProjectPackageService(repository)
    const fixture = createProjectFixture('结构化数据往返项目')
    const input = new Blob([JSON.stringify(fixture.transfer)], { type: 'application/json' })

    const imported = await service.importProjectJson(input)
    expect(imported.projectId).toBe(fixture.transfer.revision.project.id)
    expect((await repository.list()).map((project) => project.projectId)).toEqual([imported.projectId])

    const exported = await service.exportProjectJson(imported.projectId)
    expect(JSON.parse(await exported.text())).toEqual(fixture.transfer)

    await expect(service.importProjectJson(input)).rejects.toBeTruthy()
    expect(await repository.list()).toHaveLength(1)

    const copied = await service.importProjectJson(input, { onConflict: 'copy' })
    expect(copied.projectId).not.toBe(imported.projectId)
    expect((await repository.list()).map((project) => project.name)).toContain(
      '结构化数据往返项目（副本）',
    )
  })

  it('深层 schema 拒绝远程资源名称和额外危险字段', async () => {
    const service = new ProjectPackageService(testRepository())
    const fixture = createProjectFixture('恶意输入检查', { withAsset: true })
    const malicious = structuredClone(fixture.transfer) as Record<string, unknown>
    const assets = malicious.assets as Array<Record<string, unknown>>
    assets[0].fileName = 'https://example.invalid/tracker.png'
    malicious.dangerouslySetInnerHTML = { __html: '<img src=x onerror=alert(1)>' }

    const report = await service.validate(
      new Blob([JSON.stringify(malicious)], { type: 'application/json' }),
    )
    expect(report.valid).toBe(false)
  })
})

describe('项目 ZIP', () => {
  it('资源、哈希和结构化数据可完整导出后重新导入', async () => {
    const sourceRepository = testRepository()
    const fixture = createProjectFixture('项目包往返', { withAsset: true })
    const sessionId = crypto.randomUUID()
    await sourceRepository.stageImport(sessionId, fixture.transfer, fixture.contents)
    await sourceRepository.commitImport(sessionId, fixture.transfer, [], 0)

    const sourceService = new ProjectPackageService(sourceRepository)
    const exported = await sourceService.exportPackage(
      fixture.transfer.revision.project.id,
      fixture.transfer.revision.revision.id,
      'project-archive',
    )
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/)

    const targetRepository = testRepository()
    const targetService = new ProjectPackageService(targetRepository)
    const result = await targetService.importPackage(exported.blob)
    const asset = await targetRepository.getAsset(fixture.transfer.assets[0].id)

    expect(result.missingAssetCount).toBe(0)
    expect(await asset.content.text()).toBe('现场尺寸记录：通面阔待复核。')
  })

  it('在业务解析前拒绝 ZIP 路径穿越', async () => {
    const service = new ProjectPackageService(testRepository())
    const zip = zipSync({
      '../project.json': strToU8('{}'),
      'manifest.json': strToU8('{}'),
    })
    const report = await service.validate(new Blob([zip.buffer], { type: 'application/zip' }))

    expect(report.valid).toBe(false)
    expect(report.errors[0]).toContain('不安全的项目包路径')
  })
})
