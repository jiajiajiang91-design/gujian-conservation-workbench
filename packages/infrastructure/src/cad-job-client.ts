import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import { CadJobSchema, GeometryRevisionSchema, ProjectDrivenGeometrySpecSchema, type CadJob, type CadJobEvent, type GeometryRevision, type ProjectDrivenGeometrySpec } from "@gujian/domain";
import { IndexedDbProjectRepository } from "./indexeddb-project-repository.js";
import { recordHash, sha256Hex } from "./hash.js";

import { buildProjectGeometrySpec } from "./geometry-spec-builder.js";

interface SessionResponse {
  csrfToken: string;
  cadCapabilityToken: string;
}

interface WorkerEvent {
  id: string;
  jobId: string;
  sequence: number;
  eventType: CadJobEvent["eventType"];
  detail: string | null;
  occurredAt: string;
  previousHash: string | null;
  eventHash: string;
}

interface StreamPayload {
  type: CadJobEvent["eventType"];
  event: WorkerEvent;
  inputHash?: string;
  startedAt?: string;
  manifestHash?: string;
}

interface WorkerManifestAsset {
  kind: "ifc" | "glb" | "brepBundle" | "manifest" | "sourceMap" | "report" | "preview";
  fileName: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
}

interface WorkerManifest {
  geometryRevisionId: string;
  projectId: string;
  projectRevisionId: string;
  geometrySpecId: string;
  inputHash: string;
  entityClosureHash: string;
  interfaceClosureHash: string;
  geometrySignature: string;
  assets: WorkerManifestAsset[];
}

export interface CadJobProgress {
  jobId: string;
  phase: CadJobEvent["eventType"];
  events: readonly CadJobEvent[];
}

export type GeometryStartInput =
  | { readonly mode: "derivedFromFacts" }
  | { readonly mode: "existingGeometrySpec"; readonly geometrySpecId: string }
  // 形制驱动的构件生成器产出的规格：项目里还没有这份规格，
  // 由调用方直接给，仍走重绑保证构件标识与当前项目版本一致。
  | { readonly mode: "providedSpec"; readonly geometrySpec: ProjectDrivenGeometrySpec; readonly sourceZh: string };

export function rebindExistingGeometrySpec(head: ProjectHead, source: ProjectDrivenGeometrySpec): ProjectDrivenGeometrySpec {
  if (source.projectId !== head.projectId) throw new Error("GEOMETRY_SPEC_PROJECT_MISMATCH");
  const buildingIds = new Set(head.snapshot.buildings.map((building) => building.id));
  if (!buildingIds.has(source.buildingId)) throw new Error("GEOMETRY_SPEC_BUILDING_MISMATCH");
  const rebound = {
    ...source,
    id: crypto.randomUUID(),
    projectRevisionId: head.revisionId,
    inputHash: "0".repeat(64),
    createdAt: new Date().toISOString(),
  };
  // inputHash 必须与服务端 geometryInputHash 的 canonical 重算一致，统一用 recordHash
  return ProjectDrivenGeometrySpecSchema.parse({ ...rebound, inputHash: recordHash(rebound) });
}

function projectEvent(event: WorkerEvent): CadJobEvent {
  const expected = sha256Hex(JSON.stringify({
    id: event.id, jobId: event.jobId, sequence: event.sequence, eventType: event.eventType,
    detail: event.detail, occurredAt: event.occurredAt, previousHash: event.previousHash,
  }));
  if (event.eventHash !== expected) throw new Error("CAD_JOB_EVENT_HASH_MISMATCH");
  return event;
}

export class CadJobClient {
  readonly #repository: IndexedDbProjectRepository;
  readonly #commands: ProjectCommandService;
  readonly #fetch: typeof fetch;
  #active: { jobId: string; csrfToken: string } | null = null;

  constructor(input: { repository: IndexedDbProjectRepository; commands: ProjectCommandService; fetchImpl?: typeof fetch }) {
    this.#repository = input.repository;
    this.#commands = input.commands;
    this.#fetch = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async startGeometry(
    head: ProjectHead,
    actorId: string,
    onProgress: (value: CadJobProgress) => void,
    input: GeometryStartInput = { mode: "derivedFromFacts" },
  ): Promise<{ head: ProjectHead; revision: GeometryRevision; job: CadJob }> {
    if (this.#active) throw new Error("CAD_JOB_ALREADY_ACTIVE");
    const ruleRunId = crypto.randomUUID();
    const ruleStarted = new Date().toISOString();
    await this.#commands.execute({
      commandType: "CommitRuleEvaluation", commandId: crypto.randomUUID(), projectId: head.projectId, actorId,
      expectedRevisionId: head.revisionId, issuedAt: ruleStarted, payload: { ruleRun: {
        id: ruleRunId, projectId: head.projectId, inputRevisionId: head.revisionId, ruleSetVersion: "geometry-spec-builder/1.0",
        status: "completed", producer: { producerType: "rule", ruleRunId },
        results: [{
          ruleId: "geometry-input-closure", outcome: "passed",
          inputRefs: input.mode === "derivedFromFacts"
            ? head.snapshot.facts.map((item) => item.id)
            : input.mode === "existingGeometrySpec" ? [input.geometrySpecId] : [input.geometrySpec.id],
          issueRefs: [],
          message: input.mode === "derivedFromFacts"
            ? "有证据的控制尺寸已形成受控 GeometrySpec 输入。"
            : input.mode === "existingGeometrySpec"
              ? "当前项目包内的 GeometrySpec 已重新绑定到当前项目版本；稳定构件 ID 保留。"
              : input.sourceZh,
        }],
        startedAt: ruleStarted, completedAt: ruleStarted,
      }, issues: [] },
    });
    const ruledHead = await this.#repository.getProjectHead(head.projectId);
    if (!ruledHead) throw new Error("PROJECT_NOT_FOUND_AFTER_GEOMETRY_RULE");
    const sourceSpec = input.mode === "derivedFromFacts"
      ? null
      : input.mode === "providedSpec"
        ? input.geometrySpec
        : head.snapshot.geometrySpecs.find((spec) => spec.id === input.geometrySpecId)
          ?? (() => { throw new Error("GEOMETRY_SPEC_NOT_FOUND_IN_PROJECT"); })();
    const geometrySpec = sourceSpec === null
      ? buildProjectGeometrySpec(ruledHead, ruleRunId)
      : rebindExistingGeometrySpec(ruledHead, sourceSpec);
    const jobId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const initialJob = CadJobSchema.parse({
      id: jobId, projectId: ruledHead.projectId, inputRevisionId: ruledHead.revisionId, geometrySpecId: geometrySpec.id,
      inputHash: geometrySpec.inputHash, idempotencyKey, status: "queued", events: [], outputManifestHash: null,
      startedAt, completedAt: null,
    });
    await this.#commands.execute({
      commandType: "StartCadJob", commandId: crypto.randomUUID(), projectId: ruledHead.projectId, actorId,
      expectedRevisionId: ruledHead.revisionId, issuedAt: startedAt, payload: { job: initialJob },
    });
    let commandHead = await this.#repository.getProjectHead(ruledHead.projectId);
    if (!commandHead) throw new Error("PROJECT_NOT_FOUND_AFTER_CAD_START");
    const sessionResponse = await this.#fetch("/api/session", { credentials: "same-origin" });
    if (!sessionResponse.ok) throw new Error("CAD_SESSION_FAILED");
    const session = await sessionResponse.json() as SessionResponse;
    this.#active = { jobId, csrfToken: session.csrfToken };
    const response = await this.#fetch("/api/cad-jobs", {
      method: "POST", credentials: "same-origin", headers: {
        "content-type": "application/json", "x-csrf-token": session.csrfToken,
        "x-capability-token": session.cadCapabilityToken,
      }, body: JSON.stringify({
        jobId, clientRequestId: crypto.randomUUID(), idempotencyKey,
        projectId: ruledHead.projectId, projectRevisionId: ruledHead.revisionId, geometrySpec,
      }),
    });
    if (!response.ok || !response.body) throw new Error("CAD_JOB_START_FAILED");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: CadJobEvent[] = [];
    let buffer = "";
    let terminal: "succeeded" | "failed" | "cancelled" | null = null;
    let manifestHash: string | null = null;
    let completedAt: string | null = null;
    const consume = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = JSON.parse(line.slice(5).trim()) as StreamPayload;
      events.push(projectEvent(payload.event));
      if (["succeeded", "failed", "cancelled"].includes(payload.type)) {
        terminal = payload.type as typeof terminal;
        completedAt = payload.event.occurredAt;
      }
      if (payload.type === "succeeded") manifestHash = payload.manifestHash ?? null;
      onProgress({ jobId, phase: payload.type, events: [...events] });
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
    if (!terminal || !completedAt) throw new Error("CAD_JOB_STREAM_INCOMPLETE");
    const terminalStatus = terminal as "succeeded" | "failed" | "cancelled";
    const finalCompletedAt = completedAt as string;
    const job = CadJobSchema.parse({ ...initialJob, status: terminalStatus, events, outputManifestHash: manifestHash, completedAt: finalCompletedAt });
    await this.#commands.execute({
      commandType: "SyncCadJobEvents", commandId: crypto.randomUUID(), projectId: ruledHead.projectId, actorId,
      expectedRevisionId: commandHead.revisionId, issuedAt: finalCompletedAt, payload: { job },
    });
    commandHead = await this.#repository.getProjectHead(ruledHead.projectId);
    if (!commandHead) throw new Error("PROJECT_NOT_FOUND_AFTER_CAD_SYNC");
    if (terminalStatus !== "succeeded" || !manifestHash) throw new Error(`CAD_JOB_${terminalStatus.toUpperCase()}`);

    const manifestResponse = await this.#fetch(`/api/cad-jobs/${jobId}/assets/manifest.json`);
    if (!manifestResponse.ok) throw new Error("CAD_MANIFEST_DOWNLOAD_FAILED");
    const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
    if (sha256Hex(manifestBytes) !== manifestHash) throw new Error("CAD_MANIFEST_HASH_MISMATCH");
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as WorkerManifest;
    const sessionId = crypto.randomUUID();
    const files = new Map<string, { bytes: Uint8Array; kind: WorkerManifestAsset["kind"]; mimeType: string; sha256: string; fileName: string }>();
    for (const item of manifest.assets) {
      const assetResponse = await this.#fetch(`/api/cad-jobs/${jobId}/assets/${encodeURIComponent(item.fileName)}`);
      if (!assetResponse.ok) throw new Error(`CAD_ASSET_DOWNLOAD_FAILED:${item.kind}`);
      const bytes = new Uint8Array(await assetResponse.arrayBuffer());
      if (bytes.byteLength !== item.byteLength || sha256Hex(bytes) !== item.sha256) throw new Error(`CAD_ASSET_HASH_MISMATCH:${item.kind}`);
      files.set(item.kind, { ...item, bytes });
    }
    files.set("manifest", { bytes: manifestBytes, kind: "manifest", mimeType: "application/json", sha256: manifestHash, fileName: "manifest.json" });
    const assetRecords = [...files.values()].map((item) => ({
      id: crypto.randomUUID(), projectId: ruledHead.projectId, fileName: item.fileName, mimeType: item.mimeType,
      byteLength: item.bytes.byteLength, sha256: item.sha256, contentStatus: "available" as const, createdAt: finalCompletedAt,
    }));
    const contents = new Map(assetRecords.map((record, index) => [record.id, new Blob([[...files.values()][index]!.bytes.slice().buffer as ArrayBuffer], { type: record.mimeType })]));
    await this.#repository.stageAssets(sessionId, assetRecords, contents);
    const geometryAssets = assetRecords.map((asset, index) => ({
      assetId: asset.id, kind: [...files.values()][index]!.kind, sha256: asset.sha256,
      mimeType: asset.mimeType, byteLength: asset.byteLength,
    }));
    const revision = GeometryRevisionSchema.parse({
      id: manifest.geometryRevisionId, projectId: ruledHead.projectId, projectRevisionId: ruledHead.revisionId,
      geometrySpecId: geometrySpec.id, inputHash: manifest.inputHash, entityClosureHash: manifest.entityClosureHash,
      interfaceClosureHash: manifest.interfaceClosureHash, geometrySignature: manifest.geometrySignature,
      assets: geometryAssets, status: "generated-not-qualified", l1Eligible: false, formalEligibility: false,
      blockers: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"], createdAt: finalCompletedAt,
    });
    await this.#commands.execute({
      commandType: "CommitGeometryRevision", commandId: crypto.randomUUID(), projectId: ruledHead.projectId, actorId,
      expectedRevisionId: commandHead.revisionId, issuedAt: finalCompletedAt,
      payload: { cadJobId: jobId, geometrySpec, geometryRevision: revision, assets: assetRecords, stagingSessionId: sessionId },
    });
    const updated = await this.#repository.getProjectHead(ruledHead.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_GEOMETRY_COMMIT");
    return { head: updated, revision, job };
  }

  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    await this.#fetch(`/api/cad-jobs/${active.jobId}`, {
      method: "DELETE", credentials: "same-origin", headers: { "x-csrf-token": active.csrfToken },
    });
  }
}
