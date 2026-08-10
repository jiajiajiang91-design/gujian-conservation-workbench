import {
  CandidateSchema,
  DecisionSchema,
  ExecutionRunSchema,
  ProjectCommandSchema,
  ProjectSnapshotSchema,
  VisibleObservationSchema,
  evaluateFormalEligibility,
  type Artifact,
  type AuditEvent,
  type Candidate,
  type CommandResult,
  type Decision,
  type ExecutionRun,
  type ProjectCommand,
  type ProjectSnapshot,
  type RuleRun,
} from '../domain'
import { sha256Hex } from '../infrastructure/hash'
import {
  IndexedDbProjectRepository,
  type CommandWriteSet,
  type RepositoryExport,
} from '../infrastructure/indexeddb-repository'

type ExistingCommand = Exclude<ProjectCommand, { type: 'CreateProject' }>

interface PreparedCommand {
  snapshot: ProjectSnapshot
  changedRefs: string[]
  invalidatedRefs: string[]
  modelRunsToPut?: ExecutionRun[]
  ruleRunsToAdd?: RuleRun[]
  decisionsToAdd?: Decision[]
  artifactsToPut?: Artifact[]
}

interface CommandFailure {
  failure: CommandResult
}

function fail(code: string, message: string): CommandFailure {
  return { failure: { ok: false, code, message } }
}

function nextSnapshot(snapshot: ProjectSnapshot, command: ExistingCommand): ProjectSnapshot {
  const next = structuredClone(snapshot)
  next.revision = {
    id: crypto.randomUUID(),
    previousRevisionId: snapshot.revision.id,
    number: snapshot.revision.number + 1,
    createdAt: command.issuedAt,
    createdByActorId: command.actor.id,
  }
  next.project.updatedAt = command.issuedAt
  return next
}

function createDecision(
  command: ExistingCommand,
  choice: Decision['choice'],
  reason: string,
  scopeRefs: string[],
): Decision {
  return DecisionSchema.parse({
    id: crypto.randomUUID(),
    projectId: command.projectId,
    sourceRevisionId: command.expectedRevisionId,
    actorId: command.actor.id,
    actorRole: command.actor.role,
    choice,
    reason,
    scopeRefs,
    decidedAt: command.issuedAt,
  })
}

function invalidateArtifacts(artifacts: Artifact[]): { records: Artifact[]; refs: string[] } {
  const records = artifacts
    .filter((artifact) => artifact.status === 'valid')
    .map((artifact) => ({ ...artifact, status: 'stale' as const }))
  return { records, refs: records.map((artifact) => artifact.id) }
}

function buildAuditEvent(
  command: ProjectCommand,
  before: ProjectSnapshot | null,
  after: ProjectSnapshot,
  previousEventHash: string | null,
): AuditEvent {
  const body = {
    id: crypto.randomUUID(),
    projectId: command.projectId,
    commandId: command.id,
    actorId: command.actor.id,
    type: command.type,
    timestamp: command.issuedAt,
    beforeHash: before ? sha256Hex(JSON.stringify(before)) : null,
    afterHash: sha256Hex(JSON.stringify(after)),
    previousEventHash,
  }
  return { ...body, eventHash: sha256Hex(JSON.stringify(body)) }
}

function createInitialSnapshot(command: Extract<ProjectCommand, { type: 'CreateProject' }>): ProjectSnapshot {
  const buildingId = crypto.randomUUID()
  const facadeId = crypto.randomUUID()
  return ProjectSnapshotSchema.parse({
    schemaVersion: 2,
    revision: {
      id: crypto.randomUUID(),
      previousRevisionId: null,
      number: 1,
      createdAt: command.issuedAt,
      createdByActorId: command.actor.id,
    },
    project: {
      id: command.projectId,
      name: command.payload.name,
      status: 'active',
      createdAt: command.issuedAt,
      updatedAt: command.issuedAt,
    },
    buildings: [{ id: buildingId, projectId: command.projectId, name: command.payload.buildingName }],
    tasks: [
      {
        id: crypto.randomUUID(),
        projectId: command.projectId,
        title: command.payload.taskTitle,
        requirements: [],
        standardRefs: [],
        roleAssignments: [],
      },
    ],
    evidence: [],
    entities: [
      {
        id: facadeId,
        buildingId,
        parentId: null,
        kind: 'building-facade',
        name: '正立面',
      },
    ],
    observations: [],
    candidates: [],
    issues: [],
  })
}

export class ProjectCommandService {
  constructor(private readonly repository = new IndexedDbProjectRepository()) {}

  async execute(input: unknown): Promise<CommandResult> {
    const parsed = ProjectCommandSchema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? '命令格式不正确',
      }
    }
    const command = parsed.data
    const repeated = await this.repository.getCommandResult(command.id, command.projectId)
    if (repeated) return repeated
    if (command.type === 'CreateProject') return this.createProject(command)

    let aggregate: RepositoryExport
    try {
      aggregate = await this.repository.loadExport(command.projectId, command.expectedRevisionId)
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : 'PROJECT_LOAD_FAILED',
        message: '无法读取命令指定的项目版本',
      }
    }

    const prepared = this.prepare(command, aggregate)
    if ('failure' in prepared) return prepared.failure
    const auditEvent = buildAuditEvent(
      command,
      aggregate.transfer.revision,
      prepared.snapshot,
      aggregate.auditEvents.at(-1)?.eventHash ?? aggregate.transfer.audit.headHash,
    )
    const writeSet: CommandWriteSet = { ...prepared, auditEvent }
    return this.repository.commitCommand(command, writeSet)
  }

  private async createProject(
    command: Extract<ProjectCommand, { type: 'CreateProject' }>,
  ): Promise<CommandResult> {
    const snapshot = createInitialSnapshot(command)
    return this.repository.commitCommand(command, {
      snapshot,
      changedRefs: [command.projectId, ...snapshot.buildings.map((record) => record.id)],
      invalidatedRefs: [],
      auditEvent: buildAuditEvent(command, null, snapshot, null),
    })
  }

  private prepare(command: ExistingCommand, aggregate: RepositoryExport): PreparedCommand | CommandFailure {
    const current = aggregate.transfer.revision
    const next = nextSnapshot(current, command)

    if (command.type === 'ConfirmTaskScope') {
      const task = next.tasks.find((record) => record.id === command.payload.taskId)
      if (!task) return fail('TASK_NOT_FOUND', '任务不存在')
      task.standardRefs = command.payload.standardRefs
      task.roleAssignments = command.payload.roleAssignments
      task.scopeConfirmedAt = command.issuedAt
      const decision = createDecision(command, 'confirm-scope', command.payload.reason, [task.id])
      const invalidated = invalidateArtifacts(aggregate.transfer.artifacts)
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [task.id, decision.id],
        invalidatedRefs: invalidated.refs,
        decisionsToAdd: [decision],
        artifactsToPut: invalidated.records,
      }
    }

    if (command.type === 'StartModelRun') {
      if (aggregate.transfer.modelRuns.some((run) => run.id === command.payload.runId)) {
        return fail('RUN_EXISTS', '模型运行 ID 已存在')
      }
      const run = ExecutionRunSchema.parse({
        id: command.payload.runId,
        projectId: command.projectId,
        sourceRevisionId: command.expectedRevisionId,
        taskType: command.payload.taskType,
        provider: command.payload.provider,
        model: command.payload.model,
        startedAt: command.issuedAt,
        status: 'running',
        inputHash: command.payload.inputHash,
      })
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [run.id],
        invalidatedRefs: [],
        modelRunsToPut: [run],
      }
    }

    if (command.type === 'CompleteModelRun') {
      const run = aggregate.transfer.modelRuns.find((record) => record.id === command.payload.runId)
      if (!run) return fail('RUN_NOT_FOUND', '模型运行不存在')
      if (run.status !== 'running') return fail('RUN_ALREADY_FINISHED', '模型运行已进入终态')
      const targetRefs = new Set([...next.buildings, ...next.entities].map((record) => record.id))
      const evidenceRefs = new Set(next.evidence.map((record) => record.id))
      const candidates: Candidate[] = []
      for (const proposal of command.payload.candidates) {
        if (!targetRefs.has(proposal.targetRef)) return fail('TARGET_NOT_FOUND', '候选目标不存在')
        if (!proposal.evidenceRefs.every((reference) => evidenceRefs.has(reference))) {
          return fail('EVIDENCE_NOT_FOUND', '候选引用的证据不存在')
        }
        candidates.push(
          CandidateSchema.parse({
            ...proposal,
            projectId: command.projectId,
            sourceRevisionId: run.sourceRevisionId,
            inputHash: run.inputHash,
            producer: { producerType: 'model', runId: run.id },
            status: 'unreviewed',
          }),
        )
      }
      next.candidates.push(...candidates)
      const completed = ExecutionRunSchema.parse({
        ...run,
        finishedAt: command.payload.finishedAt,
        status: 'succeeded',
        usage: command.payload.usage,
      })
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [run.id, ...candidates.map((candidate) => candidate.id)],
        invalidatedRefs: [],
        modelRunsToPut: [completed],
      }
    }

    if (command.type === 'FailModelRun') {
      const run = aggregate.transfer.modelRuns.find((record) => record.id === command.payload.runId)
      if (!run) return fail('RUN_NOT_FOUND', '模型运行不存在')
      if (run.status !== 'running') return fail('RUN_ALREADY_FINISHED', '模型运行已进入终态')
      if (command.payload.status === 'failed' && !command.payload.errorCode) {
        return fail('ERROR_CODE_REQUIRED', '失败运行必须提供错误码')
      }
      const completed = ExecutionRunSchema.parse({
        ...run,
        finishedAt: command.payload.finishedAt,
        status: command.payload.status,
        errorCode: command.payload.errorCode,
      })
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [run.id],
        invalidatedRefs: [],
        modelRunsToPut: [completed],
      }
    }

    if (command.type === 'CommitRuleEvaluation') {
      if (aggregate.transfer.ruleRuns.some((run) => run.id === command.payload.runId)) {
        return fail('RULE_RUN_EXISTS', '规则运行 ID 已存在')
      }
      const targetRefs = new Set([...next.buildings, ...next.entities].map((record) => record.id))
      const evidenceRefs = new Set(next.evidence.map((record) => record.id))
      const candidates: Candidate[] = []
      for (const proposal of command.payload.candidates) {
        if (!targetRefs.has(proposal.targetRef)) return fail('TARGET_NOT_FOUND', '规则候选目标不存在')
        if (!proposal.evidenceRefs.every((reference) => evidenceRefs.has(reference))) {
          return fail('EVIDENCE_NOT_FOUND', '规则候选引用的证据不存在')
        }
        candidates.push(
          CandidateSchema.parse({
            ...proposal,
            projectId: command.projectId,
            sourceRevisionId: command.expectedRevisionId,
            inputHash: command.payload.inputHash,
            producer: { producerType: 'rule', ruleRunId: command.payload.runId },
            status: 'unreviewed',
          }),
        )
      }
      const issues = command.payload.issues.map((issue) => ({
        ...issue,
        projectId: command.projectId,
        status: 'open' as const,
      }))
      if (issues.some((issue) => !issue.subjectRefs.every((reference) => targetRefs.has(reference)))) {
        return fail('TARGET_NOT_FOUND', '规则问题引用的对象不存在')
      }
      next.candidates.push(...candidates)
      next.issues.push(...issues)
      const run: RuleRun = {
        id: command.payload.runId,
        projectId: command.projectId,
        ruleId: command.payload.ruleId,
        ruleVersion: command.payload.ruleVersion,
        sourceRevisionId: command.expectedRevisionId,
        inputHash: command.payload.inputHash,
        result: command.payload.result,
        outputRefs: [
          ...candidates.map((candidate) => candidate.id),
          ...issues.map((issue) => issue.id),
        ],
        createdAt: command.issuedAt,
      }
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [run.id, ...run.outputRefs],
        invalidatedRefs: [],
        ruleRunsToAdd: [run],
      }
    }

    if (command.type === 'DecideCandidate') {
      const candidate = next.candidates.find((record) => record.id === command.payload.candidateId)
      if (!candidate) return fail('CANDIDATE_NOT_FOUND', '候选不存在')
      if (candidate.status !== 'unreviewed') return fail('CANDIDATE_ALREADY_DECIDED', '候选已处理')
      const decision = createDecision(
        command,
        command.payload.choice,
        command.payload.reason,
        [candidate.id, candidate.targetRef],
      )
      candidate.status = command.payload.choice === 'reject' ? 'rejected' : command.payload.choice === 'replace' ? 'superseded' : 'confirmed'
      const changedRefs = [candidate.id, decision.id]
      const invalidated = invalidateArtifacts(aggregate.transfer.artifacts)
      if (command.payload.choice !== 'reject') {
        const value = command.payload.replacementValue ?? candidate.value
        if (typeof value !== 'string' || candidate.operation !== 'set') {
          return fail('CANDIDATE_FACT_UNSUPPORTED', '当前候选不能直接形成可见观察记录')
        }
        const producer =
          command.payload.choice === 'replace'
            ? { producerType: 'human' as const, actorId: command.actor.id, decisionId: decision.id }
            : candidate.producer
        const draft = VisibleObservationSchema.parse({
          id: crypto.randomUUID(),
          projectId: command.projectId,
          subjectRef: candidate.targetRef,
          field: candidate.field,
          observationType: 'visible',
          value,
          producer,
          evidenceRefs: candidate.evidenceRefs,
          reviewDecisionRefs: [decision.id],
          reviewStatus: 'confirmed',
          dataStatus: 'available',
          formalEligibility: {
            eligible: false,
            blockerCodes: ['REVIEW_REQUIRED'],
            policyVersion: 'formal-v1',
            evaluatedAt: command.issuedAt,
          },
        })
        draft.formalEligibility = evaluateFormalEligibility(
          draft,
          {
            evidenceIds: new Set(next.evidence.map((record) => record.id)),
            modelRunIds: new Set(aggregate.transfer.modelRuns.map((record) => record.id)),
            ruleRunIds: new Set(aggregate.transfer.ruleRuns.map((record) => record.id)),
            decisions: new Map([
              ...aggregate.transfer.decisions.map((record) => [
                record.id,
                { actorRole: record.actorRole },
              ] as const),
              [decision.id, { actorRole: decision.actorRole }] as const,
            ]),
          },
          command.issuedAt,
        )
        next.observations.push(draft)
        changedRefs.push(draft.id)
      }
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs,
        invalidatedRefs: invalidated.refs,
        decisionsToAdd: [decision],
        artifactsToPut: invalidated.records,
      }
    }

    if (command.type === 'ResolveIssue') {
      const issue = next.issues.find((record) => record.id === command.payload.issueId)
      if (!issue) return fail('ISSUE_NOT_FOUND', '问题不存在')
      if (issue.status !== 'open') return fail('ISSUE_ALREADY_RESOLVED', '问题已处理')
      if (
        ['high', 'critical'].includes(issue.severity) &&
        !['specialist', 'reviewer'].includes(command.actor.role)
      ) {
        return fail('ROLE_MISMATCH', '高风险问题必须由专业或复核角色处理')
      }
      issue.status = 'resolved'
      const decision = createDecision(command, 'resolve', command.payload.reason, [issue.id, ...issue.subjectRefs])
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [issue.id, decision.id],
        invalidatedRefs: [],
        decisionsToAdd: [decision],
      }
    }

    if (command.type === 'UpdateFact') {
      const existing = next.observations.find((record) => record.id === command.payload.observationId)
      if (!existing) return fail('FACT_NOT_FOUND', '业务事实不存在')
      if (existing.observationType !== 'visible') {
        return fail('FACT_TYPE_UNSUPPORTED', '测量和专业结论不能用普通事实命令修改')
      }
      const decision = createDecision(command, 'replace', command.payload.reason, [existing.id])
      existing.reviewStatus = 'superseded'
      existing.formalEligibility = {
        eligible: false,
        blockerCodes: ['REVIEW_REQUIRED'],
        policyVersion: 'formal-v1',
        evaluatedAt: command.issuedAt,
      }
      const replacement = VisibleObservationSchema.parse({
        ...existing,
        id: crypto.randomUUID(),
        value: command.payload.value,
        producer: { producerType: 'human', actorId: command.actor.id, decisionId: decision.id },
        reviewDecisionRefs: [decision.id],
        reviewStatus: 'confirmed',
      })
      replacement.formalEligibility = evaluateFormalEligibility(
        replacement,
        {
          evidenceIds: new Set(next.evidence.map((record) => record.id)),
          modelRunIds: new Set(aggregate.transfer.modelRuns.map((record) => record.id)),
          ruleRunIds: new Set(aggregate.transfer.ruleRuns.map((record) => record.id)),
          decisions: new Map([[decision.id, { actorRole: decision.actorRole }]]),
        },
        command.issuedAt,
      )
      next.observations.push(replacement)
      const invalidated = invalidateArtifacts(aggregate.transfer.artifacts)
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [existing.id, replacement.id, decision.id],
        invalidatedRefs: invalidated.refs,
        decisionsToAdd: [decision],
        artifactsToPut: invalidated.records,
      }
    }

    if (command.type === 'ArchiveProject') {
      next.project.status = 'archived'
      const decision = createDecision(command, 'archive', command.payload.reason, [command.projectId])
      return {
        snapshot: ProjectSnapshotSchema.parse(next),
        changedRefs: [command.projectId, decision.id],
        invalidatedRefs: [],
        decisionsToAdd: [decision],
      }
    }

    return fail('COMMAND_NOT_IMPLEMENTED', '命令尚未实现')
  }
}
