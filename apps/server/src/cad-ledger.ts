import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CadLedgerEvent {
  id: string;
  jobId: string;
  sequence: number;
  eventType: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "late";
  detail: string | null;
  occurredAt: string;
  previousHash: string | null;
  eventHash: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class CadJobLedger {
  readonly #database: DatabaseSync;

  constructor(path = process.env.CAD_LEDGER_PATH ?? ".data/cad-jobs.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cad_jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_revision_id TEXT NOT NULL,
        geometry_spec_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        output_manifest_hash TEXT,
        output_directory TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cad_job_events (
        event_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        detail TEXT,
        occurred_at TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        UNIQUE(job_id, sequence)
      );
    `);
  }

  start(input: {
    jobId: string; projectId: string; projectRevisionId: string; geometrySpecId: string;
    inputHash: string; idempotencyKey: string; startedAt: string;
  }): void {
    this.#database.prepare(`
      INSERT INTO cad_jobs
      (job_id, project_id, project_revision_id, geometry_spec_id, input_hash, idempotency_key, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(input.jobId, input.projectId, input.projectRevisionId, input.geometrySpecId, input.inputHash, input.idempotencyKey, input.startedAt);
  }

  append(jobId: string, eventType: CadLedgerEvent["eventType"], detail: string | null): CadLedgerEvent {
    const previous = this.#database.prepare(
      "SELECT sequence, event_hash FROM cad_job_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1",
    ).get(jobId) as { sequence: number; event_hash: string } | undefined;
    const base = {
      id: randomUUID(), jobId, sequence: (previous?.sequence ?? -1) + 1,
      eventType, detail, occurredAt: new Date().toISOString(), previousHash: previous?.event_hash ?? null,
    };
    const event: CadLedgerEvent = { ...base, eventHash: hash(base) };
    this.#database.prepare(`
      INSERT INTO cad_job_events
      (event_id, job_id, sequence, event_type, detail, occurred_at, previous_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, jobId, event.sequence, eventType, detail, event.occurredAt, event.previousHash, event.eventHash);
    return event;
  }

  complete(jobId: string, input: {
    status: "succeeded" | "failed" | "cancelled";
    outputManifestHash: string | null;
    outputDirectory: string | null;
  }): void {
    this.#database.prepare(`
      UPDATE cad_jobs SET status = ?, output_manifest_hash = ?, output_directory = ?, completed_at = ? WHERE job_id = ?
    `).run(input.status, input.outputManifestHash, input.outputDirectory, new Date().toISOString(), jobId);
  }

  read(jobId: string): { job: Record<string, unknown>; events: CadLedgerEvent[] } | null {
    const job = this.#database.prepare("SELECT * FROM cad_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    if (!job) return null;
    const events = this.#database.prepare("SELECT * FROM cad_job_events WHERE job_id = ? ORDER BY sequence").all(jobId).map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: String(value.event_id), jobId: String(value.job_id), sequence: Number(value.sequence),
        eventType: value.event_type as CadLedgerEvent["eventType"], detail: value.detail === null ? null : String(value.detail),
        occurredAt: String(value.occurred_at), previousHash: value.previous_hash === null ? null : String(value.previous_hash),
        eventHash: String(value.event_hash),
      };
    });
    return { job, events };
  }

  close(): void {
    this.#database.close();
  }
}
