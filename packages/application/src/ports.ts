import type { ProjectSnapshot } from "@gujian/domain";

import type { ProjectCommand, ProjectCommandType } from "./commands.js";

export interface ProjectHead {
  readonly projectId: string;
  readonly revisionId: string;
  readonly auditEventId: string;
  readonly snapshot: ProjectSnapshot;
}

export interface CommandReceipt {
  readonly commandId: string;
  readonly commandType: ProjectCommandType;
  readonly projectId: string;
  readonly revisionId: string;
  readonly auditEventId: string;
  readonly committedAt: string;
}

export interface CommitProjectMutation {
  readonly command: ProjectCommand;
  readonly authoritativeActorId: string;
  readonly parentRevisionId: string | null;
  readonly snapshot: ProjectSnapshot;
  readonly changedRefs: readonly string[];
}

export interface ProjectTransaction {
  getCommandReceipt(commandId: string): Promise<CommandReceipt | null>;
  getProjectHead(): Promise<ProjectHead | null>;
  commit(mutation: CommitProjectMutation): Promise<CommandReceipt>;
}

export interface ProjectRepositoryPort {
  transaction<T>(projectId: string, operation: (transaction: ProjectTransaction) => Promise<T>): Promise<T>;
}

export interface AuthorizationPort {
  assertAuthorized(input: {
    readonly actorId: string;
    readonly projectId: string;
    readonly commandType: ProjectCommandType;
  }): Promise<void>;
}

export interface CommandAuthority {
  authoritativeActorId?: string;
}
