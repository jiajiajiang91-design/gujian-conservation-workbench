import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { IndexedDbProjectRepository, openWorkbenchDb } from '../infrastructure/indexeddb-repository'
import { ProjectCommandService } from './project-command-service'

const timestamp = (minute: number) => `2026-08-10T00:${String(minute).padStart(2, '0')}:00.000Z`
const inputHash = 'a'.repeat(64)

function setup() {
  const repository = new IndexedDbProjectRepository(openWorkbenchDb(`commands-${crypto.randomUUID()}`))
  return { repository, service: new ProjectCommandService(repository) }
}

function createCommand(projectId: string, actorId: string) {
  return {
    id: crypto.randomUUID(),
    projectId,
    type: 'CreateProject' as const,
    actor: { id: actorId, role: 'operator' as const },
    expectedRevisionId: null,
    issuedAt: timestamp(0),
    payload: { name: '命令测试项目', buildingName: '正房', taskTitle: '现状记录与成果归档' },
  }
}

describe('项目命令', () => {
  it('创建命令幂等，旧版本命令不会覆盖新版本', async () => {
    const { repository, service } = setup()
    const projectId = crypto.randomUUID()
    const actorId = crypto.randomUUID()
    const create = createCommand(projectId, actorId)

    const first = await service.execute(create)
    const repeated = await service.execute(create)
    expect(repeated).toEqual(first)
    if (!first.ok) throw new Error(first.message)

    const aggregate = await repository.loadExport(projectId)
    const taskId = aggregate.transfer.revision.tasks[0].id
    const accepted = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'ConfirmTaskScope',
      actor: { id: actorId, role: 'operator' },
      expectedRevisionId: first.revisionId,
      issuedAt: timestamp(1),
      payload: {
        taskId,
        standardRefs: ['项目任务书已声明规范'],
        roleAssignments: [{ actorId, role: 'operator', assignedAt: timestamp(1) }],
        reason: '确认本次任务范围和责任角色。',
      },
    })
    expect(accepted.ok).toBe(true)

    const conflict = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'ArchiveProject',
      actor: { id: actorId, role: 'operator' },
      expectedRevisionId: first.revisionId,
      issuedAt: timestamp(2),
      payload: { reason: '测试旧版本冲突。' },
    })
    expect(conflict).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
  })

  it('模型结果只进入候选区，人工接受后仍保留模型来源', async () => {
    const { repository, service } = setup()
    const projectId = crypto.randomUUID()
    const actorId = crypto.randomUUID()
    const created = await service.execute(createCommand(projectId, actorId))
    if (!created.ok) throw new Error(created.message)
    const initial = await repository.loadExport(projectId)
    const targetRef = initial.transfer.revision.entities[0].id
    const runId = crypto.randomUUID()

    const started = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'StartModelRun',
      actor: { id: actorId, role: 'operator' },
      expectedRevisionId: created.revisionId,
      issuedAt: timestamp(1),
      payload: { runId, taskType: 'extract-visible-damage', provider: 'openai', model: 'configured-model', inputHash },
    })
    if (!started.ok) throw new Error(started.message)
    const candidateId = crypto.randomUUID()
    const completed = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'CompleteModelRun',
      actor: { id: actorId, role: 'operator' },
      expectedRevisionId: started.revisionId,
      issuedAt: timestamp(2),
      payload: {
        runId,
        finishedAt: timestamp(2),
        candidates: [
          {
            id: candidateId,
            targetRef,
            field: 'condition.description',
            operation: 'set',
            value: '檐柱表面存在纵向裂缝',
            evidenceRefs: [],
            confidence: 0.76,
            applicability: ['需要人工核对原图'],
          },
        ],
      },
    })
    if (!completed.ok) throw new Error(completed.message)

    const beforeDecision = await repository.loadExport(projectId)
    expect(beforeDecision.transfer.revision.observations).toEqual([])
    expect(beforeDecision.transfer.revision.candidates[0].producer).toEqual({ producerType: 'model', runId })

    const decided = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'DecideCandidate',
      actor: { id: actorId, role: 'operator' },
      expectedRevisionId: completed.revisionId,
      issuedAt: timestamp(3),
      payload: { candidateId, choice: 'accept', reason: '已核对候选描述，但当前没有关联证据。' },
    })
    if (!decided.ok) throw new Error(decided.message)

    const afterDecision = await repository.loadExport(projectId)
    const fact = afterDecision.transfer.revision.observations[0]
    expect(fact.producer).toEqual({ producerType: 'model', runId })
    expect(fact.reviewDecisionRefs).toHaveLength(1)
    expect(fact.formalEligibility).toMatchObject({
      eligible: false,
      blockerCodes: expect.arrayContaining(['EVIDENCE_MISSING']),
    })
  })

  it('规则运行与模型运行分开保存，高风险问题只允许匹配角色处理', async () => {
    const { repository, service } = setup()
    const projectId = crypto.randomUUID()
    const operatorId = crypto.randomUUID()
    const reviewerId = crypto.randomUUID()
    const created = await service.execute(createCommand(projectId, operatorId))
    if (!created.ok) throw new Error(created.message)
    const initial = await repository.loadExport(projectId)
    const targetRef = initial.transfer.revision.entities[0].id
    const ruleRunId = crypto.randomUUID()
    const issueId = crypto.randomUUID()

    const evaluated = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'CommitRuleEvaluation',
      actor: { id: operatorId, role: 'operator' },
      expectedRevisionId: created.revisionId,
      issuedAt: timestamp(1),
      payload: {
        runId: ruleRunId,
        ruleId: 'geometry.required-inputs',
        ruleVersion: '1.0.0',
        inputHash,
        result: 'blocked',
        candidates: [],
        issues: [
          {
            id: issueId,
            type: 'high-risk',
            severity: 'high',
            subjectRefs: [targetRef],
            blockerCodes: ['MEASUREMENT_RECORD_MISSING'],
          },
        ],
      },
    })
    if (!evaluated.ok) throw new Error(evaluated.message)
    const afterRule = await repository.loadExport(projectId)
    expect(afterRule.transfer.ruleRuns).toHaveLength(1)
    expect(afterRule.transfer.modelRuns).toHaveLength(0)

    const rejected = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'ResolveIssue',
      actor: { id: operatorId, role: 'operator' },
      expectedRevisionId: evaluated.revisionId,
      issuedAt: timestamp(2),
      payload: { issueId, reason: '普通操作人员尝试处理。' },
    })
    expect(rejected).toMatchObject({ ok: false, code: 'ROLE_MISMATCH' })

    const resolved = await service.execute({
      id: crypto.randomUUID(),
      projectId,
      type: 'ResolveIssue',
      actor: { id: reviewerId, role: 'reviewer' },
      expectedRevisionId: evaluated.revisionId,
      issuedAt: timestamp(3),
      payload: { issueId, reason: '复核后确认保持阻断并补采现场数据。' },
    })
    expect(resolved.ok).toBe(true)
  })
})
