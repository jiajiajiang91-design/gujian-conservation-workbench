export type CommandErrorCode =
  | "COMMAND_INVALID"
  | "PROJECT_ALREADY_EXISTS"
  | "PROJECT_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "PROJECT_REF_MISMATCH"
  | "UNAUTHORIZED";

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CommandErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.details = details;
  }
}
