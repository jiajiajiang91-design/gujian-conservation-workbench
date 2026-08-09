import { describe, expect, it } from 'vitest'
import { evaluateFormalEligibility } from './eligibility'
import { MeasurementRecordSchema, VisibleObservationSchema } from './project'
import { ExecutionRunSchema, ProxyDrawingInputSchema } from './records'

const id = () => crypto.randomUUID()
const timestamp = '2026-08-10T00:00:00.000Z'
const unavailable = {
  eligible: false,
  blockerCodes: ['REVIEW_REQUIRED'] as const,
  policyVersion: 'formal-v1',
  evaluatedAt: timestamp,
}

function visibleFact() {
  return {
    id: id(),
    projectId: id(),
    subjectRef: id(),
    field: 'damage.description',
    observationType: 'visible' as const,
    value: '檐柱表面可见纵向裂缝',
    producer: { producerType: 'model' as const, runId: id() },
    evidenceRefs: [id()],
    reviewDecisionRefs: [id()],
    reviewStatus: 'confirmed' as const,
    dataStatus: 'available' as const,
    formalEligibility: unavailable,
  }
}

describe('来源责任', () => {
  it('业务事实拒绝缺少运行引用、system 和旧 program 枚举', () => {
    const fact = visibleFact()

    expect(VisibleObservationSchema.safeParse(fact).success).toBe(true)
    expect(
      VisibleObservationSchema.safeParse({ ...fact, producer: { producerType: 'model' } }).success,
    ).toBe(false)
    expect(
      VisibleObservationSchema.safeParse({
        ...fact,
        producer: { producerType: 'system', operationId: id(), scope: 'derived-metadata' },
      }).success,
    ).toBe(false)
    expect(
      VisibleObservationSchema.safeParse({ ...fact, producer: { producerType: 'program' } })
        .success,
    ).toBe(false)
  })

  it('演示事实始终不能取得正式资格', () => {
    const fact = VisibleObservationSchema.parse({
      ...visibleFact(),
      producer: { producerType: 'demo', fixtureId: id() },
    })
    const result = evaluateFormalEligibility(
      fact,
      {
        evidenceIds: new Set(fact.evidenceRefs),
        modelRunIds: new Set(),
        ruleRunIds: new Set(),
        decisions: new Map([[fact.reviewDecisionRefs[0], { actorRole: 'reviewer' }]]),
      },
      timestamp,
    )

    expect(result.eligible).toBe(false)
    expect(result.blockerCodes).toContain('DEMO_SOURCE')
  })

  it('真实模型运行、证据和人工核对同时存在时才可通过资格计算', () => {
    const fact = VisibleObservationSchema.parse(visibleFact())
    const result = evaluateFormalEligibility(
      fact,
      {
        evidenceIds: new Set(fact.evidenceRefs),
        modelRunIds: new Set([fact.producer.producerType === 'model' ? fact.producer.runId : '']),
        ruleRunIds: new Set(),
        decisions: new Map([[fact.reviewDecisionRefs[0], { actorRole: 'reviewer' }]]),
        requiredRole: 'reviewer',
      },
      timestamp,
    )

    expect(result).toEqual({
      eligible: true,
      blockerCodes: [],
      policyVersion: 'formal-v1',
      evaluatedAt: timestamp,
    })
  })
})

describe('测量记录', () => {
  it('必须保留测量人、时间、方法、单位和现场原记录', () => {
    const fact = visibleFact()
    const measurement = {
      ...fact,
      observationType: 'measurement',
      field: 'geometry.totalWidth',
      value: { value: 15_800, unit: 'mm' },
      measuredByActorId: id(),
      measuredAt: timestamp,
      method: '钢卷尺现场测量',
      originalEvidenceRef: fact.evidenceRefs[0],
    }

    expect(MeasurementRecordSchema.safeParse(measurement).success).toBe(true)
    expect(
      MeasurementRecordSchema.safeParse({ ...measurement, originalEvidenceRef: undefined }).success,
    ).toBe(false)
    expect(
      MeasurementRecordSchema.safeParse({ ...measurement, value: { value: 15_800 } }).success,
    ).toBe(false)
  })
})

describe('追加记录和代理制图输入', () => {
  it('模型运行只允许运行中或具备完成时间的终态', () => {
    const base = {
      id: id(),
      projectId: id(),
      sourceRevisionId: id(),
      taskType: 'extract-evidence',
      provider: 'openai',
      model: 'configured-model',
      startedAt: timestamp,
      status: 'running',
      inputHash: 'a'.repeat(64),
    }

    expect(ExecutionRunSchema.safeParse(base).success).toBe(true)
    expect(ExecutionRunSchema.safeParse({ ...base, status: 'succeeded' }).success).toBe(false)
  })

  it('代理制图输入必须显式包含完整开间数组和屋面高度', () => {
    const base = {
      id: id(),
      projectId: id(),
      fixtureId: id(),
      purpose: 'proxy-artifact-generation',
      geometry: {
        baySpans: [{ entityId: id(), width: { value: 4_200, unit: 'mm' } }],
        baseHeight: { value: 300, unit: 'mm' },
        columnHeight: { value: 3_600, unit: 'mm' },
        roofRise: { value: 2_100, unit: 'mm' },
      },
      limitations: ['仅用于代理成果，不代表现场实测。'],
    }

    expect(ProxyDrawingInputSchema.safeParse(base).success).toBe(true)
    expect(
      ProxyDrawingInputSchema.safeParse({
        ...base,
        geometry: { ...base.geometry, roofRise: undefined },
      }).success,
    ).toBe(false)
  })
})
