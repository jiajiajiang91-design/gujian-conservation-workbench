import { ProjectSnapshotSchema, type FactEnvelope, type ProjectSnapshot } from "@gujian/domain";

import { ProjectCommandSchema, type ProjectCommand } from "./commands.js";
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
}

function createInitialSnapshot(command: Extract<ProjectCommand, { commandType: "CreateProject" }>): ProjectSnapshot {
  return ProjectSnapshotSchema.parse({
    schemaVersion: "3.0",
    project: command.payload.project,
    buildings: [command.payload.building],
    taskDefinitions: [],
    evidences: [],
    entities: [],
    relations: [],
    observations: [],
    measurements: [],
    facts: [],
    issues: [],
    dependencyEdges: [],
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
      const snapshot = appendFacts(head, command.payload.facts);
      return transaction.commit({
        command,
        authoritativeActorId,
        parentRevisionId: head.revisionId,
        snapshot,
        changedRefs: command.payload.facts.map((fact) => fact.id),
      });
    });
  }
}
