import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type InvocationSource = "model" | "keyword";
export type ConfirmationDecision = "allow_once" | "deny" | "user_withdrawn" | "channel_unavailable";

export interface InvocationRecord {
  invocationId: string;
  sessionRef: string;
  actionName: string;
  argsHash: string;
  source: InvocationSource;
  resultCode: string;
  modelRawOutput: string | null;
  sequence: number;
  occurredAt: string;
  previousHash: string | null;
  eventHash: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// 动作留痕账本：调用表与确认表，均为全局哈希链（照 model-ledger 的模式）。
// 确认表按询问与决定成对写入，同 confirmId 关联；有询问无决定即孤儿询问，可查询。
export class ActionLedger {
  readonly #database: DatabaseSync;

  constructor(path = process.env.ACTION_LEDGER_PATH ?? ".data/assistant-actions.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS action_invocations (
        invocation_id TEXT PRIMARY KEY,
        session_ref TEXT NOT NULL,
        action_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        result_code TEXT NOT NULL,
        model_raw_output TEXT,
        sequence INTEGER NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_confirmations (
        record_id TEXT PRIMARY KEY,
        confirm_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        decision TEXT,
        action_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        UNIQUE(confirm_id, kind)
      );
    `);
  }

  #nextLink(table: "action_invocations" | "action_confirmations"): { sequence: number; previousHash: string | null } {
    const previous = this.#database.prepare(
      `SELECT sequence, event_hash FROM ${table} ORDER BY sequence DESC LIMIT 1`,
    ).get() as { sequence: number; event_hash: string } | undefined;
    return { sequence: (previous?.sequence ?? -1) + 1, previousHash: previous?.event_hash ?? null };
  }

  recordInvocation(input: {
    sessionRef: string;
    actionName: string;
    argsHash: string;
    source: InvocationSource;
    resultCode: string;
    modelRawOutput: string | null;
  }): InvocationRecord {
    const link = this.#nextLink("action_invocations");
    const base = {
      invocationId: randomUUID(),
      ...input,
      sequence: link.sequence,
      occurredAt: new Date().toISOString(),
      previousHash: link.previousHash,
    };
    const record: InvocationRecord = { ...base, eventHash: hash(base) };
    this.#database.prepare(`
      INSERT INTO action_invocations
      (invocation_id, session_ref, action_name, args_hash, source, result_code, model_raw_output, sequence, occurred_at, previous_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.invocationId, record.sessionRef, record.actionName, record.argsHash, record.source,
      record.resultCode, record.modelRawOutput, record.sequence, record.occurredAt,
      record.previousHash, record.eventHash,
    );
    return record;
  }

  #recordConfirmation(confirmId: string, kind: "ask" | "decide", decision: ConfirmationDecision | null, actionName: string, argsHash: string): void {
    const link = this.#nextLink("action_confirmations");
    const base = {
      recordId: randomUUID(), confirmId, kind, decision, actionName, argsHash,
      sequence: link.sequence, occurredAt: new Date().toISOString(), previousHash: link.previousHash,
    };
    this.#database.prepare(`
      INSERT INTO action_confirmations
      (record_id, confirm_id, kind, decision, action_name, args_hash, sequence, occurred_at, previous_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(base.recordId, confirmId, kind, decision, actionName, argsHash, base.sequence, base.occurredAt, base.previousHash, hash(base));
  }

  recordAsk(confirmId: string, actionName: string, argsHash: string): void {
    this.#recordConfirmation(confirmId, "ask", null, actionName, argsHash);
  }

  recordDecision(confirmId: string, decision: ConfirmationDecision, actionName: string, argsHash: string): void {
    this.#recordConfirmation(confirmId, "decide", decision, actionName, argsHash);
  }

  orphanAsks(): Array<{ confirmId: string; actionName: string; occurredAt: string }> {
    return this.#database.prepare(`
      SELECT a.confirm_id, a.action_name, a.occurred_at
      FROM action_confirmations a
      WHERE a.kind = 'ask'
        AND NOT EXISTS (SELECT 1 FROM action_confirmations d WHERE d.confirm_id = a.confirm_id AND d.kind = 'decide')
      ORDER BY a.sequence
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        confirmId: String(value.confirm_id),
        actionName: String(value.action_name),
        occurredAt: String(value.occurred_at),
      };
    });
  }

  verifyChains(): boolean {
    for (const table of ["action_invocations", "action_confirmations"] as const) {
      const rows = this.#database.prepare(
        `SELECT previous_hash, event_hash FROM ${table} ORDER BY sequence`,
      ).all() as Array<{ previous_hash: string | null; event_hash: string }>;
      let previous: string | null = null;
      for (const row of rows) {
        if (row.previous_hash !== previous) return false;
        previous = row.event_hash;
      }
    }
    return true;
  }

  close(): void {
    this.#database.close();
  }
}
