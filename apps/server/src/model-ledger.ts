import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LedgerEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: "queued" | "running" | "retrying" | "stream" | "succeeded" | "failed" | "cancelled" | "late";
  attempt: number;
  detail: string | null;
  occurredAt: string;
  previousHash: string | null;
  eventHash: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ModelRunLedger {
  readonly #database: DatabaseSync;

  constructor(path = process.env.MODEL_LEDGER_PATH ?? ".data/model-runs.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS model_runs (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_revision_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        output_hash TEXT,
        usage_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS model_run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        detail TEXT,
        occurred_at TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );
    `);
  }

  start(input: {
    runId: string; projectId: string; projectRevisionId: string; taskType: string;
    inputHash: string; provider: string; model: string; startedAt: string;
  }): void {
    this.#database.prepare(`
      INSERT INTO model_runs
      (run_id, project_id, project_revision_id, task_type, input_hash, provider, model, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(input.runId, input.projectId, input.projectRevisionId, input.taskType, input.inputHash, input.provider, input.model, input.startedAt);
  }

  append(runId: string, eventType: LedgerEvent["eventType"], attempt: number, detail: string | null): LedgerEvent {
    const previous = this.#database.prepare(
      "SELECT sequence, event_hash FROM model_run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
    ).get(runId) as { sequence: number; event_hash: string } | undefined;
    const base = {
      id: randomUUID(), runId, sequence: (previous?.sequence ?? -1) + 1, eventType, attempt,
      detail, occurredAt: new Date().toISOString(), previousHash: previous?.event_hash ?? null,
    };
    const event: LedgerEvent = { ...base, eventHash: hash(base) };
    this.#database.prepare(`
      INSERT INTO model_run_events
      (event_id, run_id, sequence, event_type, attempt, detail, occurred_at, previous_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, runId, event.sequence, eventType, attempt, detail, event.occurredAt, event.previousHash, event.eventHash);
    return event;
  }

  complete(runId: string, status: "succeeded" | "failed" | "cancelled", outputHash: string | null, usage: unknown): void {
    this.#database.prepare(`
      UPDATE model_runs SET status = ?, output_hash = ?, usage_json = ?, completed_at = ? WHERE run_id = ?
    `).run(status, outputHash, usage ? JSON.stringify(usage) : null, new Date().toISOString(), runId);
  }

  read(runId: string): { run: Record<string, unknown>; events: LedgerEvent[] } | null {
    const row = this.#database.prepare("SELECT * FROM model_runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const events = this.#database.prepare("SELECT * FROM model_run_events WHERE run_id = ? ORDER BY sequence").all(runId)
      .map((event) => {
        const value = event as Record<string, unknown>;
        return {
          id: String(value.event_id), runId: String(value.run_id), sequence: Number(value.sequence),
          eventType: value.event_type as LedgerEvent["eventType"], attempt: Number(value.attempt),
          detail: value.detail === null ? null : String(value.detail), occurredAt: String(value.occurred_at),
          previousHash: value.previous_hash === null ? null : String(value.previous_hash), eventHash: String(value.event_hash),
        };
      });
    return { run: row, events };
  }

  close(): void {
    this.#database.close();
  }
}
