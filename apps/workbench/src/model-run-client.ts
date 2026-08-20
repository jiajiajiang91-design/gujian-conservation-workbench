import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import {
  ModelCandidateOutputSchema,
  ModelCandidateSchema,
  ModelRunSchema,
  type ModelCandidate,
  type ModelRun,
  type ModelRunEvent,
} from "@gujian/domain";
import { IndexedDbProjectRepository } from "@gujian/infrastructure";

interface SessionResponse {
  csrfToken: string;
  capabilityToken: string;
  expiresAt: string;
}

interface ServerEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: ModelRunEvent["eventType"];
  attempt: number;
  detail: string | null;
  occurredAt: string;
}

interface StreamPayload {
  type: ModelRunEvent["eventType"];
  event: ServerEvent;
  content?: string;
  inputHash?: string;
  startedAt?: string;
  model?: string;
  provider?: string;
  usage?: ModelRun["usage"];
  outputHash?: string;
  errorCode?: string;
}

export interface ModelRunProgress {
  runId: string;
  phase: ModelRunEvent["eventType"];
  streamedText: string;
  events: readonly ModelRunEvent[];
}

export interface ModelRunOutcome {
  head: ProjectHead;
  run: ModelRun;
  candidate: ModelCandidate | null;
}

function toProjectEvent(event: ServerEvent): ModelRunEvent {
  return {
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    eventType: event.eventType,
    attempt: event.attempt,
    detail: event.detail,
    occurredAt: event.occurredAt,
  };
}

// 模型按任务的输出结构返回 JSON，判别字段 kind 由任务类型补上再交领域层校验。
// 手写字段检查会随任务增多而漂移，改用同一份 schema。
const OUTPUT_KIND: Record<string, "evidenceSummary" | "measurementTranscription"> = {
  "evidence-summary": "evidenceSummary",
  "measurement-transcription": "measurementTranscription",
};

function parseStructured(content: string, taskType: string): ModelCandidate["structured"] {
  const kind = OUTPUT_KIND[taskType];
  if (!kind) return null;
  try {
    const parsed = ModelCandidateOutputSchema.safeParse({ ...JSON.parse(content) as object, kind });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? `HTTP_${response.status}`;
  } catch {
    return `HTTP_${response.status}`;
  }
}

export class ModelRunClient {
  readonly #repository: IndexedDbProjectRepository;
  readonly #commands: ProjectCommandService;
  readonly #fetch: typeof fetch;
  #active: { runId: string; csrfToken: string } | null = null;

  constructor(input: {
    repository: IndexedDbProjectRepository;
    commands: ProjectCommandService;
    fetchImpl?: typeof fetch;
  }) {
    this.#repository = input.repository;
    this.#commands = input.commands;
    this.#fetch = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get activeRunId(): string | null { return this.#active?.runId ?? null; }

  async runEvidenceSummary(
    head: ProjectHead,
    actorId: string,
    onProgress: (progress: ModelRunProgress) => void,
  ): Promise<ModelRunOutcome> {
    if (this.#active) throw new Error("MODEL_RUN_ALREADY_ACTIVE");
    const projectAssets = await this.#repository.getProjectAssets(head.projectId);
    const assetById = new Map(projectAssets.map((asset) => [asset.record.id, asset.record]));
    const evidences = head.snapshot.parseRecords.flatMap((parseRecord) => {
      if (parseRecord.status !== "parsed" || !parseRecord.extractedText?.trim()) return [];
      const evidence = head.snapshot.evidences.find((item) => item.id === parseRecord.evidenceId);
      const asset = evidence ? assetById.get(evidence.assetId) : undefined;
      if (!evidence || !asset || asset.contentStatus !== "available") return [];
      return [{
        evidenceId: evidence.id,
        assetSha256: asset.sha256,
        text: parseRecord.extractedText.slice(0, 50_000),
      }];
    });
    if (!evidences.length) throw new Error("NO_PARSED_EVIDENCE_FOR_MODEL");

    const sessionResponse = await this.#fetch("/api/session", { credentials: "same-origin" });
    if (!sessionResponse.ok) throw new Error(await errorCode(sessionResponse));
    const session = await sessionResponse.json() as SessionResponse;
    const runId = crypto.randomUUID();
    this.#active = { runId, csrfToken: session.csrfToken };
    const response = await this.#fetch("/api/model-runs", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
        "x-capability-token": session.capabilityToken,
      },
      body: JSON.stringify({
        runId,
        clientRequestId: crypto.randomUUID(),
        projectId: head.projectId,
        projectRevisionId: head.revisionId,
        taskType: "evidence-summary",
        evidences,
      }),
    });
    if (!response.ok || !response.body) {
      this.#active = null;
      throw new Error(await errorCode(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: ModelRunEvent[] = [];
    let buffer = "";
    let streamedText = "";
    let inputHash = "";
    let outputHash: string | null = null;
    let startedAt = "";
    let completedAt = "";
    let provider = "moonshot";
    let model = "kimi-k2.6";
    let usage: ModelRun["usage"] = null;
    let terminal: "succeeded" | "failed" | "cancelled" | null = null;

    const consume = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = JSON.parse(line.slice(5).trim()) as StreamPayload;
      events.push(toProjectEvent(payload.event));
      if (payload.type === "queued") {
        inputHash = payload.inputHash ?? "";
        startedAt = payload.startedAt ?? payload.event.occurredAt;
        provider = payload.provider ?? provider;
        model = payload.model ?? model;
      }
      if (payload.type === "stream") streamedText += payload.content ?? "";
      if (payload.type === "succeeded") {
        terminal = "succeeded";
        streamedText = payload.content ?? streamedText;
        outputHash = payload.outputHash ?? null;
        usage = payload.usage ?? null;
        completedAt = payload.event.occurredAt;
      }
      if (payload.type === "failed" || payload.type === "cancelled") {
        terminal = payload.type;
        completedAt = payload.event.occurredAt;
      }
      onProgress({ runId, phase: payload.type, streamedText, events: [...events] });
    };

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) consume(line);
      }
      if (buffer.trim()) consume(buffer);
    } finally {
      this.#active = null;
    }
    if (!terminal || !inputHash || !startedAt || !completedAt) throw new Error("MODEL_RUN_STREAM_INCOMPLETE");

    const run = ModelRunSchema.parse({
      id: runId,
      projectId: head.projectId,
      inputRevisionId: head.revisionId,
      inputHash,
      provider,
      model,
      taskType: "evidence-summary",
      status: terminal,
      evidenceRefs: evidences.map((item) => item.evidenceId),
      events,
      usage,
      outputHash,
      startedAt,
      completedAt,
    });
    const candidate = terminal === "succeeded"
      ? ModelCandidateSchema.parse({
          id: crypto.randomUUID(),
          projectId: head.projectId,
          runId,
          inputRevisionId: head.revisionId,
          taskType: "evidence-summary",
          contentText: streamedText,
          structured: parseStructured(streamedText, "evidence-summary"),
          producer: { producerType: "model", runId },
          evidenceRefs: evidences.map((item) => item.evidenceId),
          reviewStatus: "unreviewed",
          createdAt: completedAt,
        })
      : null;
    await this.#commands.execute({
      commandType: "CommitModelRunResult",
      commandId: crypto.randomUUID(),
      projectId: head.projectId,
      actorId,
      expectedRevisionId: head.revisionId,
      issuedAt: completedAt,
      payload: { run, candidate },
    });
    const updated = await this.#repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_MODEL_RUN");
    return { head: updated, run, candidate };
  }

  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    const response = await this.#fetch(`/api/model-runs/${active.runId}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-csrf-token": active.csrfToken },
    });
    if (!response.ok && response.status !== 404) throw new Error(await errorCode(response));
  }
}
