import { ProjectSnapshotSchema, type ArtifactRecord, type CheckRun, type FactEnvelope, type ProjectSnapshot } from "@gujian/domain";

import { ProjectCommandSchema, type ProjectCommand } from "./commands.js";
import { assertDeliveryChainClosure } from "./delivery-chain-closure.js";
import { CommandError } from "./errors.js";
import type {
  AuthorizationPort,
  CommandAuthority,
  CommandReceipt,
  ProjectHead,
  ProjectRepositoryPort,
} from "./ports.js";

function requireMatchingProjectRefs(command: ProjectCommand): void {
  if (command.commandType === "CreateProject" &&
      (command.payload.project.id !== command.projectId || command.payload.building.projectId !== command.projectId)) {
    throw new CommandError("PROJECT_REF_MISMATCH", "project and building references must match command projectId");
  }
  if (command.commandType === "ImportProjectSnapshot" && command.payload.snapshot.project.id !== command.projectId) {
    throw new CommandError("PROJECT_REF_MISMATCH", "imported snapshot must match command projectId");
  }
  if (command.commandType === "ImportProjectSnapshot" && (
    command.payload.sourceAuditEvents.at(-1)?.eventHash !== command.payload.sourceAuditHeadHash ||
    command.payload.sourceAuditEvents.some((event) => event.projectId !== command.projectId)
  )) {
    throw new CommandError("COMMAND_INVALID", "imported audit prefix must match project and head hash");
  }
  if (command.commandType === "ImportProjectSnapshot" && command.payload.assets.some((asset) => asset.projectId !== command.projectId)) {
    throw new CommandError("PROJECT_REF_MISMATCH", "imported assets must match command projectId");
  }
  if (command.commandType === "ImportProjectSnapshot" && command.payload.modelRuns.some((run) => run.projectId !== command.projectId)) {
    throw new CommandError("PROJECT_REF_MISMATCH", "imported model runs must match command projectId");
  }
  if (command.commandType === "ImportProjectSnapshot" && command.payload.ruleRuns.some((run) => run.projectId !== command.projectId)) {
    throw new CommandError("PROJECT_REF_MISMATCH", "imported rule runs must match command projectId");
  }
  if (command.commandType === "ImportProjectSnapshot" && command.payload.decisions.some((decision) => decision.projectId !== command.projectId)) {
    throw new CommandError("PROJECT_REF_MISMATCH", "imported decisions must match command projectId");
  }
  if (command.commandType === "ImportProjectSnapshot" && (
    command.payload.cadJobs.some((item) => item.projectId !== command.projectId) ||
    command.payload.artifacts.some((item) => item.projectId !== command.projectId) ||
    command.payload.checkRuns.some((item) => item.projectId !== command.projectId) ||
    command.payload.deliveryEvaluations.some((item) => item.projectId !== command.projectId) ||
    command.payload.deliveries.some((item) => item.projectId !== command.projectId)
  )) {
    throw new CommandError("PROJECT_REF_MISMATCH", "imported CAD, artifact and delivery records must match command projectId");
  }
  if (command.commandType === "ImportProjectSnapshot") {
    assertDeliveryChainClosure({
      projectId: command.projectId,
      geometryRevisions: command.payload.snapshot.geometryRevisions,
      artifacts: command.payload.artifacts,
      checkRuns: command.payload.checkRuns,
      deliveryEvaluations: command.payload.deliveryEvaluations,
      deliveries: command.payload.deliveries,
    });
  }
  if (command.commandType === "ImportEvidence" && (
    command.payload.evidence.projectId !== command.projectId ||
    command.payload.asset.projectId !== command.projectId ||
    command.payload.evidence.assetId !== command.payload.asset.id ||
    command.payload.parseRecord.projectId !== command.projectId ||
    command.payload.parseRecord.assetId !== command.payload.asset.id ||
    command.payload.parseRecord.evidenceId !== command.payload.evidence.id
  )) {
    throw new CommandError("PROJECT_REF_MISMATCH", "evidence, asset and parse references must form one project closure");
  }
  if (command.commandType === "CommitModelRunResult" && (
    command.payload.run.projectId !== command.projectId ||
    command.payload.run.inputRevisionId !== command.expectedRevisionId ||
    (command.payload.run.status === "succeeded") !== (command.payload.candidate !== null) ||
    (command.payload.candidate !== null && (
      command.payload.candidate.projectId !== command.projectId ||
      command.payload.candidate.runId !== command.payload.run.id ||
      command.payload.candidate.inputRevisionId !== command.payload.run.inputRevisionId
    ))
  )) {
    throw new CommandError("COMMAND_INVALID", "model run and candidate closure is invalid");
  }
  if (command.commandType === "CommitRuleEvaluation" && (
    command.payload.ruleRun.projectId !== command.projectId ||
    command.payload.ruleRun.inputRevisionId !== command.expectedRevisionId ||
    command.payload.issues.some((issue) => issue.projectId !== command.projectId || issue.producer.producerType !== "rule" || issue.producer.ruleRunId !== command.payload.ruleRun.id) ||
    command.payload.ruleRun.results.flatMap((result) => result.issueRefs).some((issueId) => !command.payload.issues.some((issue) => issue.id === issueId))
  )) {
    throw new CommandError("COMMAND_INVALID", "rule run and issue closure is invalid");
  }
  if (command.commandType === "DecideCandidate" && (
    command.payload.decision.projectId !== command.projectId ||
    command.payload.decision.actorId !== command.actorId ||
    command.payload.decision.commandId !== command.commandId
  )) {
    throw new CommandError("COMMAND_INVALID", "candidate decision closure is invalid");
  }
  if (command.commandType === "StartCadJob" && (
    command.payload.job.projectId !== command.projectId ||
    command.payload.job.inputRevisionId !== command.expectedRevisionId ||
    command.payload.job.status !== "queued" || command.payload.job.events.length !== 0 ||
    command.payload.job.outputManifestHash !== null || command.payload.job.completedAt !== null
  )) {
    throw new CommandError("COMMAND_INVALID", "CAD job start closure is invalid");
  }
  if (command.commandType === "SyncCadJobEvents" && command.payload.job.projectId !== command.projectId) {
    throw new CommandError("PROJECT_REF_MISMATCH", "CAD job must match command projectId");
  }
  if (command.commandType === "CommitGeometryRevision") {
    const { geometrySpec: spec, geometryRevision: revision, assets } = command.payload;
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const geometryAssetKinds = new Set(revision.assets.map((asset) => asset.kind));
    if (spec.projectId !== command.projectId || revision.projectId !== command.projectId ||
        revision.geometrySpecId !== spec.id || revision.projectRevisionId !== spec.projectRevisionId ||
        revision.inputHash !== spec.inputHash ||
        ["ifc", "glb", "brepBundle", "manifest", "sourceMap", "report", "preview"].some((kind) => !geometryAssetKinds.has(kind as never)) ||
        revision.assets.some((ref) => {
          const asset = assetById.get(ref.assetId);
          return !asset || asset.projectId !== command.projectId || asset.sha256 !== ref.sha256 ||
            asset.mimeType !== ref.mimeType || asset.byteLength !== ref.byteLength;
        })) {
      throw new CommandError("COMMAND_INVALID", "geometry revision closure is invalid");
    }
    assertDeliveryChainClosure({
      projectId: command.projectId,
      geometryRevisions: [revision],
      artifacts: [],
      checkRuns: [],
      deliveryEvaluations: [],
      deliveries: [],
    });
  }
  if (command.commandType === "CommitArtifactSet") {
    const assets = new Map(command.payload.assets.map((item) => [item.id, item]));
    if (command.payload.artifacts.some((item) => {
      const asset = assets.get(item.assetId);
      return item.projectId !== command.projectId || (asset !== undefined && (asset.projectId !== command.projectId ||
        asset.sha256 !== item.sha256 || asset.byteLength !== item.byteLength || asset.mimeType !== item.mimeType));
    })) throw new CommandError("COMMAND_INVALID", "artifact and asset closure is invalid");
  }
  if (command.commandType === "CommitCheckRun" && command.payload.checkRun.projectId !== command.projectId) {
    throw new CommandError("PROJECT_REF_MISMATCH", "check run must match command projectId");
  }
  if (command.commandType === "EvaluateDelivery" && command.payload.evaluation.projectId !== command.projectId) {
    throw new CommandError("PROJECT_REF_MISMATCH", "delivery evaluation must match command projectId");
  }
  if (command.commandType === "CreateDeliveryDraft" && (
    command.payload.draft.projectId !== command.projectId || command.payload.manifestAsset.projectId !== command.projectId ||
    command.payload.manifestArtifact.projectId !== command.projectId ||
    command.payload.draft.manifestAssetId !== command.payload.manifestAsset.id ||
    command.payload.draft.manifestHash !== command.payload.manifestAsset.sha256 ||
    command.payload.manifestArtifact.assetId !== command.payload.manifestAsset.id ||
    command.payload.manifestArtifact.kind !== "deliveryManifest" ||
    command.payload.manifestArtifact.sha256 !== command.payload.manifestAsset.sha256 ||
    !command.payload.draft.artifactRefs.includes(command.payload.manifestArtifact.id)
  )) throw new CommandError("COMMAND_INVALID", "delivery draft and manifest closure is invalid");
}

function createInitialSnapshot(command: Extract<ProjectCommand, { commandType: "CreateProject" }>): ProjectSnapshot {
  return ProjectSnapshotSchema.parse({
    schemaVersion: "3.0",
    project: command.payload.project,
    buildings: [command.payload.building],
    taskDefinitions: [],
    evidences: [],
    parseRecords: [],
    entities: [],
    relations: [],
    observations: [],
    measurements: [],
    facts: [],
    candidates: [],
    issues: [],
    dependencyEdges: [],
    geometrySpecs: [],
    geometryRevisions: [],
    adoptedRecordRefs: [],
  });
}

function appendFacts(head: ProjectHead, facts: readonly FactEnvelope[]): ProjectSnapshot {
  const existingIds = new Set(head.snapshot.facts.map((fact) => fact.id));
  const duplicate = facts.find((fact) => existingIds.has(fact.id));
  if (duplicate) {
    throw new CommandError("COMMAND_INVALID", "fact id already exists", { factId: duplicate.id });
  }
  return ProjectSnapshotSchema.parse({
    ...head.snapshot,
    facts: [...head.snapshot.facts, ...facts],
  });
}

function appendEvidence(
  head: ProjectHead,
  command: Extract<ProjectCommand, { commandType: "ImportEvidence" }>,
): ProjectSnapshot {
  if (head.snapshot.evidences.some((evidence) => evidence.id === command.payload.evidence.id) ||
      head.snapshot.parseRecords.some((record) => record.id === command.payload.parseRecord.id)) {
    throw new CommandError("COMMAND_INVALID", "evidence or parse record id already exists");
  }
  return ProjectSnapshotSchema.parse({
    ...head.snapshot,
    evidences: [...head.snapshot.evidences, command.payload.evidence],
    parseRecords: [...head.snapshot.parseRecords, command.payload.parseRecord],
  });
}

function appendModelResult(
  head: ProjectHead,
  command: Extract<ProjectCommand, { commandType: "CommitModelRunResult" }>,
): ProjectSnapshot {
  if (!command.payload.candidate) return head.snapshot;
  if (head.snapshot.candidates.some((candidate) => candidate.id === command.payload.candidate?.id || candidate.runId === command.payload.run.id)) {
    throw new CommandError("COMMAND_INVALID", "model candidate already exists");
  }
  return ProjectSnapshotSchema.parse({
    ...head.snapshot,
    candidates: [...head.snapshot.candidates, command.payload.candidate],
  });
}

function confirmTaskSetup(
  head: ProjectHead,
  command: Extract<ProjectCommand, { commandType: "ConfirmTaskSetup" }>,
): ProjectSnapshot {
  if (head.snapshot.taskDefinitions.some((task) => task.confirmedAt !== null)) {
    throw new CommandError("COMMAND_INVALID", "task setup is already confirmed");
  }
  return ProjectSnapshotSchema.parse({ ...head.snapshot, taskDefinitions: [command.payload.taskDefinition] });
}

function replaceTaskDefinition(
  head: ProjectHead,
  command: Extract<ProjectCommand, { commandType: "ReplaceTaskDefinition" }>,
): ProjectSnapshot {
  const current = head.snapshot.taskDefinitions.find((task) => task.id === command.payload.supersedesTaskDefinitionId && task.confirmedAt !== null);
  if (!current) throw new CommandError("COMMAND_INVALID", "confirmed task definition to supersede is missing");
  return ProjectSnapshotSchema.parse({ ...head.snapshot, taskDefinitions: [command.payload.taskDefinition] });
}

function appendRuleEvaluation(
  head: ProjectHead,
  command: Extract<ProjectCommand, { commandType: "CommitRuleEvaluation" }>,
): ProjectSnapshot {
  const superseded = head.snapshot.issues.map((issue) => (
    issue.status === "open" && issue.producer.producerType === "rule"
      ? { ...issue, status: "superseded" as const, resolvedAt: command.issuedAt }
      : issue
  ));
  return ProjectSnapshotSchema.parse({ ...head.snapshot, issues: [...superseded, ...command.payload.issues] });
}

function decideCandidate(
  head: ProjectHead,
  command: Extract<ProjectCommand, { commandType: "DecideCandidate" }>,
): ProjectSnapshot {
  const candidate = head.snapshot.candidates.find((item) => item.id === command.payload.candidateId);
  const issue = head.snapshot.issues.find((item) => item.id === command.payload.decision.issueId);
  if (!candidate || candidate.reviewStatus !== "unreviewed" || !issue || issue.status !== "open" || !issue.subjectRefs.includes(candidate.id)) {
    throw new CommandError("COMMAND_INVALID", "candidate or issue is not open for decision");
  }
  const accepted = command.payload.decision.outcome === "accepted";
  return ProjectSnapshotSchema.parse({
    ...head.snapshot,
    candidates: head.snapshot.candidates.map((item) => item.id === candidate.id
      ? { ...item, reviewStatus: accepted ? "confirmed" as const : "rejected" as const }
      : item),
    issues: head.snapshot.issues.map((item) => item.id === issue.id
      ? { ...item, status: accepted ? "resolved" as const : "rejected" as const, resolvedAt: command.issuedAt }
      : item),
  });
}

function appendGeometryRevision(
  head: ProjectHead,
  command: Extract<ProjectCommand, { commandType: "CommitGeometryRevision" }>,
): ProjectSnapshot {
  if (head.snapshot.geometrySpecs.some((item) => item.id === command.payload.geometrySpec.id) ||
      head.snapshot.geometryRevisions.some((item) => item.id === command.payload.geometryRevision.id)) {
    throw new CommandError("COMMAND_INVALID", "geometry spec or revision id already exists");
  }
  return ProjectSnapshotSchema.parse({
    ...head.snapshot,
    geometrySpecs: [...head.snapshot.geometrySpecs, command.payload.geometrySpec],
    geometryRevisions: [...head.snapshot.geometryRevisions, command.payload.geometryRevision],
  });
}

function appendArtifactSet(head: ProjectHead, command: Extract<ProjectCommand, { commandType: "CommitArtifactSet" }>): ProjectSnapshot {
  const geometryIds = new Set(head.snapshot.geometryRevisions.map((item) => item.id));
  const geometryAssets = new Map(head.snapshot.geometryRevisions.flatMap((item) => item.assets.map((asset) => [asset.assetId, asset] as const)));
  const newAssets = new Map(command.payload.assets.map((item) => [item.id, item]));
  if (command.payload.artifacts.some((item) => {
    const asset = newAssets.get(item.assetId) ?? geometryAssets.get(item.assetId);
    return !geometryIds.has(item.geometryRevisionId) || !asset ||
      asset.sha256 !== item.sha256 || asset.byteLength !== item.byteLength || asset.mimeType !== item.mimeType;
  })) {
    throw new CommandError("COMMAND_INVALID", "artifact references unknown geometry or duplicate id");
  }
  return head.snapshot;
}

function appendCheckRun(head: ProjectHead, command: Extract<ProjectCommand, { commandType: "CommitCheckRun" }>): ProjectSnapshot {
  const run = command.payload.checkRun;
  return head.snapshot;
}

function appendDeliveryEvaluation(head: ProjectHead, command: Extract<ProjectCommand, { commandType: "EvaluateDelivery" }>): ProjectSnapshot {
  return head.snapshot;
}

function appendDeliveryDraft(head: ProjectHead, command: Extract<ProjectCommand, { commandType: "CreateDeliveryDraft" }>): ProjectSnapshot {
  return head.snapshot;
}

function assertCadJobEventPrefix(previous: import("@gujian/domain").CadJob, next: import("@gujian/domain").CadJob): void {
  if (next.id !== previous.id || next.projectId !== previous.projectId ||
      next.inputRevisionId !== previous.inputRevisionId || next.geometrySpecId !== previous.geometrySpecId ||
      next.inputHash !== previous.inputHash || next.idempotencyKey !== previous.idempotencyKey ||
      next.startedAt !== previous.startedAt || next.events.length < previous.events.length) {
    throw new CommandError("COMMAND_INVALID", "CAD job immutable fields or event prefix changed");
  }
  for (let index = 0; index < previous.events.length; index += 1) {
    if (previous.events[index]?.eventHash !== next.events[index]?.eventHash) {
      throw new CommandError("COMMAND_INVALID", "CAD job event prefix changed");
    }
  }
  for (let index = 0; index < next.events.length; index += 1) {
    const event = next.events[index]!;
    if (event.jobId !== next.id || event.sequence !== index || event.previousHash !== (index === 0 ? null : next.events[index - 1]!.eventHash)) {
      throw new CommandError("COMMAND_INVALID", "CAD job event chain is invalid");
    }
  }
}

export class ProjectCommandService {
  readonly #repository: ProjectRepositoryPort;
  readonly #authorization: AuthorizationPort;

  constructor(input: { repository: ProjectRepositoryPort; authorization: AuthorizationPort }) {
    this.#repository = input.repository;
    this.#authorization = input.authorization;
  }

  async execute(rawCommand: unknown, authority: CommandAuthority = {}): Promise<CommandReceipt> {
    const parsed = ProjectCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      throw new CommandError("COMMAND_INVALID", "command schema validation failed", {
        issues: parsed.error.issues,
      });
    }
    const command = parsed.data;
    requireMatchingProjectRefs(command);
    const authoritativeActorId = authority.authoritativeActorId ?? command.actorId;
    await this.#authorization.assertAuthorized({
      actorId: authoritativeActorId,
      projectId: command.projectId,
      commandType: command.commandType,
    });

    return this.#repository.transaction(command.projectId, async (transaction) => {
      const existingReceipt = await transaction.getCommandReceipt(command.commandId);
      if (existingReceipt) {
        return existingReceipt;
      }

      const head = await transaction.getProjectHead();
      if (command.commandType === "CreateProject" || command.commandType === "ImportProjectSnapshot") {
        if (head) {
          throw new CommandError("PROJECT_ALREADY_EXISTS", "project already exists", {
            currentRevisionId: head.revisionId,
          });
        }
        return transaction.commit({
          command,
          authoritativeActorId,
          parentRevisionId: null,
          snapshot: command.commandType === "CreateProject"
            ? createInitialSnapshot(command)
            : ProjectSnapshotSchema.parse({
                ...command.payload.snapshot,
                adoptedRecordRefs: Array.from(new Set([
                  ...command.payload.snapshot.adoptedRecordRefs,
                  `revision:${command.payload.sourceRevisionId}`,
                ])),
              }),
          changedRefs: command.commandType === "CreateProject"
            ? [command.projectId, command.payload.building.id]
            : [command.projectId, command.payload.sourceRevisionId],
          ...(command.commandType === "ImportProjectSnapshot"
            ? { priorAuditEvents: command.payload.sourceAuditEvents }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.assets.length
            ? { assetWrites: { records: command.payload.assets, stagingSessionId: command.payload.assetSessionId } }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.modelRuns.length
            ? { modelRunsToPut: command.payload.modelRuns }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.ruleRuns.length
            ? { ruleRunsToPut: command.payload.ruleRuns }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.decisions.length
            ? { decisionsToPut: command.payload.decisions }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.cadJobs.length
            ? { cadJobsToPut: command.payload.cadJobs }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.snapshot.geometrySpecs.length
            ? { geometrySpecsToPut: command.payload.snapshot.geometrySpecs }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.snapshot.geometryRevisions.length
            ? { geometryRevisionsToPut: command.payload.snapshot.geometryRevisions }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.artifacts.length
            ? { artifactsToPut: command.payload.artifacts }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.checkRuns.length
            ? { checkRunsToPut: command.payload.checkRuns }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.deliveryEvaluations.length
            ? { deliveryEvaluationsToPut: command.payload.deliveryEvaluations }
            : {}),
          ...(command.commandType === "ImportProjectSnapshot" && command.payload.deliveries.length
            ? { deliveriesToPut: command.payload.deliveries }
            : {}),
        });
      }

      if (!head) {
        throw new CommandError("PROJECT_NOT_FOUND", "project does not exist");
      }
      if (command.expectedRevisionId !== head.revisionId) {
        throw new CommandError("REVISION_CONFLICT", "expected revision does not match project head", {
          expectedRevisionId: command.expectedRevisionId,
          currentRevisionId: head.revisionId,
        });
      }
      const persistedCadJob = command.commandType === "StartCadJob" || command.commandType === "SyncCadJobEvents" || command.commandType === "CommitGeometryRevision"
        ? await transaction.getCadJob(command.commandType === "CommitGeometryRevision" ? command.payload.cadJobId : command.payload.job.id)
        : null;
      if (command.commandType === "StartCadJob" && persistedCadJob) {
        throw new CommandError("COMMAND_INVALID", "CAD job already exists");
      }
      if (command.commandType === "SyncCadJobEvents") {
        if (!persistedCadJob) throw new CommandError("COMMAND_INVALID", "CAD job does not exist");
        assertCadJobEventPrefix(persistedCadJob, command.payload.job);
      }
      if (command.commandType === "CommitGeometryRevision") {
        const manifestHash = command.payload.geometryRevision.assets.find((asset) => asset.kind === "manifest")?.sha256;
        if (!persistedCadJob || persistedCadJob.status !== "succeeded" || persistedCadJob.outputManifestHash !== manifestHash ||
            persistedCadJob.geometrySpecId !== command.payload.geometrySpec.id || persistedCadJob.inputHash !== command.payload.geometrySpec.inputHash) {
          throw new CommandError("COMMAND_INVALID", "successful synchronized CAD job is required");
        }
      }
      if (command.commandType === "CommitArtifactSet") {
        for (const artifact of command.payload.artifacts) {
          if (await transaction.getArtifact(artifact.id)) throw new CommandError("COMMAND_INVALID", "artifact id already exists");
        }
        assertDeliveryChainClosure({
          projectId: command.projectId,
          geometryRevisions: head.snapshot.geometryRevisions,
          artifacts: command.payload.artifacts,
          checkRuns: [],
          deliveryEvaluations: [],
          deliveries: [],
        });
      }
      if (command.commandType === "CommitCheckRun") {
        if (await transaction.getCheckRun(command.payload.checkRun.id)) throw new CommandError("COMMAND_INVALID", "check run id already exists");
        const artifacts: ArtifactRecord[] = [];
        for (const artifactId of command.payload.checkRun.artifactRefs) {
          const artifact = await transaction.getArtifact(artifactId);
          if (!artifact) throw new CommandError("COMMAND_INVALID", "check run artifact closure is invalid");
          artifacts.push(artifact);
        }
        assertDeliveryChainClosure({
          projectId: command.projectId,
          geometryRevisions: head.snapshot.geometryRevisions,
          artifacts,
          checkRuns: [command.payload.checkRun],
          deliveryEvaluations: [],
          deliveries: [],
        });
      }
      if (command.commandType === "EvaluateDelivery") {
        const artifacts = new Map<string, ArtifactRecord>();
        for (const artifactId of command.payload.evaluation.artifactRefs) {
          const artifact = await transaction.getArtifact(artifactId);
          if (!artifact) throw new CommandError("COMMAND_INVALID", "delivery artifact closure is invalid");
          artifacts.set(artifact.id, artifact);
        }
        const checkRuns: CheckRun[] = [];
        for (const checkRunId of command.payload.evaluation.checkRunRefs) {
          const checkRun = await transaction.getCheckRun(checkRunId);
          if (!checkRun) throw new CommandError("COMMAND_INVALID", "delivery check closure is invalid");
          checkRuns.push(checkRun);
          for (const artifactId of checkRun.artifactRefs) {
            const artifact = await transaction.getArtifact(artifactId);
            if (!artifact) throw new CommandError("COMMAND_INVALID", "delivery check artifact closure is invalid");
            artifacts.set(artifact.id, artifact);
          }
        }
        assertDeliveryChainClosure({
          projectId: command.projectId,
          geometryRevisions: head.snapshot.geometryRevisions,
          artifacts: [...artifacts.values()],
          checkRuns,
          deliveryEvaluations: [command.payload.evaluation],
          deliveries: [],
        });
      }
      if (command.commandType === "CreateDeliveryDraft") {
        const evaluation = await transaction.getDeliveryEvaluation(command.payload.draft.evaluationId);
        if (!evaluation) {
          throw new CommandError("COMMAND_INVALID", "delivery evaluation is missing or mismatched");
        }
        if (await transaction.getArtifact(command.payload.manifestArtifact.id)) throw new CommandError("COMMAND_INVALID", "delivery manifest artifact id already exists");
        const artifacts = new Map<string, ArtifactRecord>([[command.payload.manifestArtifact.id, command.payload.manifestArtifact]]);
        const artifactIds = new Set([...command.payload.draft.artifactRefs, ...evaluation.artifactRefs]);
        for (const artifactId of artifactIds) {
          if (artifactId === command.payload.manifestArtifact.id) continue;
          const artifact = await transaction.getArtifact(artifactId);
          if (!artifact) throw new CommandError("COMMAND_INVALID", "delivery draft artifact closure is invalid");
          artifacts.set(artifact.id, artifact);
        }
        const checkRuns: CheckRun[] = [];
        for (const checkRunId of evaluation.checkRunRefs) {
          const checkRun = await transaction.getCheckRun(checkRunId);
          if (!checkRun) throw new CommandError("COMMAND_INVALID", "delivery evaluation check closure is invalid");
          checkRuns.push(checkRun);
          for (const artifactId of checkRun.artifactRefs) {
            const artifact = artifacts.get(artifactId) ?? await transaction.getArtifact(artifactId);
            if (!artifact) throw new CommandError("COMMAND_INVALID", "delivery check artifact closure is invalid");
            artifacts.set(artifact.id, artifact);
          }
        }
        assertDeliveryChainClosure({
          projectId: command.projectId,
          geometryRevisions: head.snapshot.geometryRevisions,
          artifacts: [...artifacts.values()],
          checkRuns,
          deliveryEvaluations: [evaluation],
          deliveries: [command.payload.draft],
        });
      }
      const snapshot = command.commandType === "CommitFacts"
        ? appendFacts(head, command.payload.facts)
        : command.commandType === "ImportEvidence"
          ? appendEvidence(head, command)
          : command.commandType === "CommitModelRunResult"
            ? appendModelResult(head, command)
        : command.commandType === "ConfirmTaskSetup"
          ? confirmTaskSetup(head, command)
          : command.commandType === "ReplaceTaskDefinition"
            ? replaceTaskDefinition(head, command)
              : command.commandType === "CommitRuleEvaluation"
                ? appendRuleEvaluation(head, command)
                : command.commandType === "DecideCandidate"
                  ? decideCandidate(head, command)
                  : command.commandType === "CommitGeometryRevision"
                    ? appendGeometryRevision(head, command)
                    : command.commandType === "CommitArtifactSet"
                      ? appendArtifactSet(head, command)
                      : command.commandType === "CommitCheckRun"
                        ? appendCheckRun(head, command)
                        : command.commandType === "EvaluateDelivery"
                          ? appendDeliveryEvaluation(head, command)
                          : command.commandType === "CreateDeliveryDraft"
                            ? appendDeliveryDraft(head, command)
                            : head.snapshot;
      return transaction.commit({
        command,
        authoritativeActorId,
        parentRevisionId: head.revisionId,
        snapshot,
        changedRefs: command.commandType === "CommitFacts"
          ? command.payload.facts.map((fact) => fact.id)
          : command.commandType === "ImportEvidence"
            ? [command.payload.asset.id, command.payload.evidence.id, command.payload.parseRecord.id]
            : command.commandType === "CommitModelRunResult"
              ? [command.payload.run.id, ...(command.payload.candidate ? [command.payload.candidate.id] : [])]
          : command.commandType === "ConfirmTaskSetup"
            ? [command.payload.taskDefinition.id]
            : command.commandType === "ReplaceTaskDefinition"
              ? [command.payload.supersedesTaskDefinitionId, command.payload.taskDefinition.id]
                : command.commandType === "CommitRuleEvaluation"
                  ? [command.payload.ruleRun.id, ...command.payload.issues.map((issue) => issue.id)]
                  : command.commandType === "DecideCandidate"
                    ? [command.payload.candidateId, command.payload.decision.id, command.payload.decision.issueId]
                    : command.commandType === "CommitGeometryRevision"
                      ? [command.payload.cadJobId, command.payload.geometrySpec.id, command.payload.geometryRevision.id, ...command.payload.assets.map((asset) => asset.id)]
                      : command.commandType === "CommitArtifactSet"
                        ? [...command.payload.artifacts.map((item) => item.id), ...command.payload.assets.map((item) => item.id)]
                        : command.commandType === "CommitCheckRun"
                          ? [command.payload.checkRun.id]
                          : command.commandType === "EvaluateDelivery"
                            ? [command.payload.evaluation.id]
                            : command.commandType === "CreateDeliveryDraft"
                              ? [command.payload.draft.id, command.payload.manifestArtifact.id, command.payload.manifestAsset.id]
                              : [command.payload.job.id, ...command.payload.job.events.map((event) => event.id)],
        ...(command.commandType === "ImportEvidence"
          ? { assetWrites: { records: [command.payload.asset], stagingSessionId: command.payload.stagingSessionId } }
          : {}),
        ...(command.commandType === "CommitModelRunResult"
          ? { modelRunsToPut: [command.payload.run] }
          : {}),
        ...(command.commandType === "CommitRuleEvaluation"
          ? { ruleRunsToPut: [command.payload.ruleRun] }
          : {}),
        ...(command.commandType === "DecideCandidate"
          ? { decisionsToPut: [command.payload.decision] }
          : {}),
        ...(command.commandType === "StartCadJob" || command.commandType === "SyncCadJobEvents"
          ? { cadJobsToPut: [command.payload.job] }
          : {}),
        ...(command.commandType === "CommitGeometryRevision"
          ? {
              geometrySpecsToPut: [command.payload.geometrySpec],
              geometryRevisionsToPut: [command.payload.geometryRevision],
              assetWrites: { records: command.payload.assets, stagingSessionId: command.payload.stagingSessionId },
            }
          : {}),
        ...(command.commandType === "CommitArtifactSet"
          ? { artifactsToPut: command.payload.artifacts, ...(command.payload.assets.length ? { assetWrites: { records: command.payload.assets, stagingSessionId: command.payload.stagingSessionId } } : {}) }
          : {}),
        ...(command.commandType === "CommitCheckRun" ? { checkRunsToPut: [command.payload.checkRun] } : {}),
        ...(command.commandType === "EvaluateDelivery" ? { deliveryEvaluationsToPut: [command.payload.evaluation] } : {}),
        ...(command.commandType === "CreateDeliveryDraft"
          ? {
              artifactsToPut: [command.payload.manifestArtifact],
              deliveriesToPut: [command.payload.draft],
              assetWrites: { records: [command.payload.manifestAsset], stagingSessionId: command.payload.stagingSessionId },
            }
          : {}),
      });
    });
  }
}
