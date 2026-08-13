import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import {
  CadJobSchema, GeometryRevisionSchema, ProjectDrivenGeometrySpecSchema,
  type CadJob, type CadJobEvent, type GeometryRevision, type ProjectDrivenGeometrySpec, type ProjectGeometryObject,
} from "@gujian/domain";
import { IndexedDbProjectRepository, recordHash, sha256Hex } from "@gujian/infrastructure";

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
  kind: "ifc" | "glb" | "manifest" | "sourceMap" | "report" | "preview";
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

function projectEvent(event: WorkerEvent): CadJobEvent {
  const expected = sha256Hex(JSON.stringify({
    id: event.id, jobId: event.jobId, sequence: event.sequence, eventType: event.eventType,
    detail: event.detail, occurredAt: event.occurredAt, previousHash: event.previousHash,
  }));
  if (event.eventHash !== expected) throw new Error("CAD_JOB_EVENT_HASH_MISMATCH");
  return event;
}

function geometrySpecHash(spec: ProjectDrivenGeometrySpec): string {
  return recordHash({ ...spec, inputHash: "0".repeat(64) });
}

function localDemoGeometry(head: ProjectHead): ProjectDrivenGeometrySpec {
  const object = (input: {
    stableKey: string; displayNameZh: string; componentType: string;
    solid: { kind: "box"; sizeX: string; sizeY: string; sizeZ: string; centerMm: [number, number, number] } |
      { kind: "cylinder"; radius: string; height: string; axis: "z"; centerMm: [number, number, number] };
  }): ProjectGeometryObject => ({
    id: crypto.randomUUID(), stableKey: input.stableKey, parentId: null, componentType: input.componentType,
    displayNameZh: input.displayNameZh, materialCode: "team-demo", solid: input.solid, parameters: [],
    producer: { producerType: "demo" as const, fixtureId: "workbench-project-geometry-start" },
    factRefs: [], evidenceRefs: head.snapshot.evidences.map((item) => item.id), unknownRefs: [],
  });
  const base = object({ stableKey: "base", displayNameZh: "演示台基", componentType: "base", solid: { kind: "box", sizeX: "3200", sizeY: "2400", sizeZ: "300", centerMm: [0, 0, 150] } });
  const column = object({ stableKey: "column", displayNameZh: "演示柱", componentType: "column", solid: { kind: "cylinder", radius: "180", height: "2400", axis: "z", centerMm: [0, 0, 1500] } });
  const beam = object({ stableKey: "beam", displayNameZh: "演示横向构件", componentType: "beam", solid: { kind: "box", sizeX: "2800", sizeY: "280", sizeZ: "260", centerMm: [0, 0, 2830] } });
  const unknown = {
    id: crypto.randomUUID(), subjectRef: column.id, reasonCode: "DEMO_GEOMETRY_NOT_MEASURED",
    description: "当前几何仅用于验证项目驱动内核，不是现场实测或专业模型。",
    requiredEvidence: ["现场测量记录", "经核对的平立剖尺寸"], affectedRefs: [base.id, column.id, beam.id],
    evidenceRefs: head.snapshot.evidences.map((item) => item.id), blocksProxyOutcome: false, blocksFormalEligibility: true,
  };
  column.unknownRefs = [unknown.id];
  const value: ProjectDrivenGeometrySpec = {
    schemaVersion: "2.0", id: crypto.randomUUID(), projectId: head.projectId,
    projectRevisionId: head.revisionId, buildingId: head.snapshot.buildings[0]!.id, inputHash: "0".repeat(64),
    coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 }, objects: [base, column, beam],
    interfaces: [
      { id: crypto.randomUUID(), fromObjectId: base.id, toObjectId: column.id, interfaceType: "bearing", fromSurface: "zMax", toSurface: "zMin", direction: [0, 0, 1], maximumGapMm: 0.01, maximumUnexpectedOverlapMm3: 0, minimumDeclaredOverlapMm3: null, factRefs: [], evidenceRefs: [] },
      { id: crypto.randomUUID(), fromObjectId: column.id, toObjectId: beam.id, interfaceType: "bearing", fromSurface: "zMax", toSurface: "zMin", direction: [0, 0, 1], maximumGapMm: 0.01, maximumUnexpectedOverlapMm3: 0, minimumDeclaredOverlapMm3: null, factRefs: [], evidenceRefs: [] },
    ], unknowns: [unknown], createdAt: new Date().toISOString(),
  };
  return ProjectDrivenGeometrySpecSchema.parse({ ...value, inputHash: geometrySpecHash(value) });
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

  async startDemoGeometry(head: ProjectHead, actorId: string, onProgress: (value: CadJobProgress) => void): Promise<{ head: ProjectHead; revision: GeometryRevision; job: CadJob }> {
    if (this.#active) throw new Error("CAD_JOB_ALREADY_ACTIVE");
    const geometrySpec = localDemoGeometry(head);
    const jobId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const initialJob = CadJobSchema.parse({
      id: jobId, projectId: head.projectId, inputRevisionId: head.revisionId, geometrySpecId: geometrySpec.id,
      inputHash: geometrySpec.inputHash, idempotencyKey, status: "queued", events: [], outputManifestHash: null,
      startedAt, completedAt: null,
    });
    await this.#commands.execute({
      commandType: "StartCadJob", commandId: crypto.randomUUID(), projectId: head.projectId, actorId,
      expectedRevisionId: head.revisionId, issuedAt: startedAt, payload: { job: initialJob },
    });
    let commandHead = await this.#repository.getProjectHead(head.projectId);
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
        projectId: head.projectId, projectRevisionId: head.revisionId, geometrySpec,
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
      commandType: "SyncCadJobEvents", commandId: crypto.randomUUID(), projectId: head.projectId, actorId,
      expectedRevisionId: commandHead.revisionId, issuedAt: finalCompletedAt, payload: { job },
    });
    commandHead = await this.#repository.getProjectHead(head.projectId);
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
      id: crypto.randomUUID(), projectId: head.projectId, fileName: item.fileName, mimeType: item.mimeType,
      byteLength: item.bytes.byteLength, sha256: item.sha256, contentStatus: "available" as const, createdAt: finalCompletedAt,
    }));
    const contents = new Map(assetRecords.map((record, index) => [record.id, new Blob([[...files.values()][index]!.bytes.slice().buffer as ArrayBuffer], { type: record.mimeType })]));
    await this.#repository.stageAssets(sessionId, assetRecords, contents);
    const geometryAssets = assetRecords.map((asset, index) => ({
      assetId: asset.id, kind: [...files.values()][index]!.kind, sha256: asset.sha256,
      mimeType: asset.mimeType, byteLength: asset.byteLength,
    }));
    const revision = GeometryRevisionSchema.parse({
      id: manifest.geometryRevisionId, projectId: head.projectId, projectRevisionId: head.revisionId,
      geometrySpecId: geometrySpec.id, inputHash: manifest.inputHash, entityClosureHash: manifest.entityClosureHash,
      interfaceClosureHash: manifest.interfaceClosureHash, geometrySignature: manifest.geometrySignature,
      assets: geometryAssets, status: "generated-not-qualified", l1Eligible: false, formalEligibility: false,
      blockers: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"], createdAt: finalCompletedAt,
    });
    await this.#commands.execute({
      commandType: "CommitGeometryRevision", commandId: crypto.randomUUID(), projectId: head.projectId, actorId,
      expectedRevisionId: commandHead.revisionId, issuedAt: finalCompletedAt,
      payload: { cadJobId: jobId, geometrySpec, geometryRevision: revision, assets: assetRecords, stagingSessionId: sessionId },
    });
    const updated = await this.#repository.getProjectHead(head.projectId);
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
