import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import { ArtifactRecordSchema, CheckRunSchema, type ArtifactRecord, type ArtifactRequirementMatrix, type CheckRun, type GeometryRevision } from "@gujian/domain";
import { IndexedDbProjectRepository, sha256Hex } from "@gujian/infrastructure";

interface SessionResponse { csrfToken: string; drawingCapabilityToken: string }
interface WorkerAsset { kind: string; fileName: string; mimeType: string; sha256: string; byteLength: number }
interface DrawingSucceeded { type: "succeeded"; jobId: string; buildRecordHash: string; assets: WorkerAsset[] }

const kindMap: Record<string, ArtifactRecord["kind"]> = {
  drawingIr: "drawingIr", viewGeometry: "viewGeometry", dxf: "dxf", svg: "svg", pdf: "pdf", png: "png",
  sourceMap: "drawingSourceMap", checkReport: "checkReport",
};

export class DrawingJobClient {
  constructor(private readonly input: { repository: IndexedDbProjectRepository; commands: ProjectCommandService; fetchImpl?: typeof fetch }) {}

  async generate(head: ProjectHead, actorId: string, geometry: GeometryRevision, matrix: ArtifactRequirementMatrix, onProgress: (phase: string) => void): Promise<{ head: ProjectHead; artifacts: ArtifactRecord[]; checkRun: CheckRun }> {
    const jobs = await this.input.repository.getProjectCadJobs(head.projectId);
    const sourceJob = jobs.filter((item) => item.geometrySpecId === geometry.geometrySpecId && item.status === "succeeded").at(-1);
    if (!sourceJob) throw new Error("DRAWING_SOURCE_CAD_JOB_MISSING");
    const fetcher = this.input.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const sessionResponse = await fetcher("/api/session", { credentials: "same-origin" });
    if (!sessionResponse.ok) throw new Error("DRAWING_SESSION_FAILED");
    const session = await sessionResponse.json() as SessionResponse;
    const jobId = crypto.randomUUID();
    const response = await fetcher("/api/drawing-jobs", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken, "x-capability-token": session.drawingCapabilityToken },
      body: JSON.stringify({ jobId, clientRequestId: crypto.randomUUID(), sourceCadJobId: sourceJob.id, projectId: head.projectId, projectRevisionId: geometry.projectRevisionId, geometryRevisionId: geometry.id, artifactMatrix: matrix }),
    });
    if (!response.ok || !response.body) throw new Error("DRAWING_JOB_START_FAILED");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal: DrawingSucceeded | null = null;
    const consume = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = JSON.parse(line.slice(5).trim()) as { type: string } | DrawingSucceeded;
      onProgress(payload.type);
      if (payload.type === "failed") throw new Error("DRAWING_JOB_FAILED");
      if (payload.type === "succeeded") terminal = payload as DrawingSucceeded;
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    if (buffer.trim()) consume(buffer);
    if (!terminal) throw new Error("DRAWING_JOB_STREAM_INCOMPLETE");
    const completed = terminal as DrawingSucceeded;
    const createdAt = new Date().toISOString();
    const downloaded: Array<{ worker: WorkerAsset; record: import("@gujian/domain").AssetRecord; blob: Blob }> = [];
    for (const item of completed.assets) {
      const assetResponse = await fetcher(`/api/drawing-jobs/${jobId}/assets/${item.fileName}`);
      if (!assetResponse.ok) throw new Error(`DRAWING_ASSET_DOWNLOAD_FAILED:${item.fileName}`);
      const bytes = new Uint8Array(await assetResponse.arrayBuffer());
      if (bytes.byteLength !== item.byteLength || sha256Hex(bytes) !== item.sha256) throw new Error(`DRAWING_ASSET_HASH_MISMATCH:${item.fileName}`);
      const record = { id: crypto.randomUUID(), projectId: head.projectId, fileName: item.fileName.replace("/", "-"), mimeType: item.mimeType, byteLength: bytes.byteLength, sha256: item.sha256, contentStatus: "available" as const, createdAt };
      downloaded.push({ worker: item, record, blob: new Blob([bytes as BlobPart], { type: item.mimeType }) });
    }
    const sessionId = crypto.randomUUID();
    await this.input.repository.stageAssets(sessionId, downloaded.map((item) => item.record), new Map(downloaded.map((item) => [item.record.id, item.blob])));
    const artifacts = downloaded.map(({ worker, record }) => ArtifactRecordSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: geometry.projectRevisionId, geometryRevisionId: geometry.id,
      requirementMatrixId: matrix.id, kind: kindMap[worker.kind] ?? "checkReport", fileName: record.fileName, assetId: record.id,
      sha256: record.sha256, mimeType: record.mimeType, byteLength: record.byteLength, status: "generated-not-qualified", l1Eligible: false,
      formalEligibility: false, sourceRefs: [geometry.id, matrix.id], blockers: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"], createdAt,
    }));
    await this.input.commands.execute({ commandType: "CommitArtifactSet", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: head.revisionId, issuedAt: createdAt, payload: { artifactRequirementMatrices: [matrix], artifacts, assets: downloaded.map((item) => item.record), stagingSessionId: sessionId } });
    let updated = await this.input.repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_ARTIFACTS");
    const report = artifacts.find((item) => item.kind === "checkReport");
    if (!report) throw new Error("DRAWING_CHECK_REPORT_MISSING");
    const checkRun = CheckRunSchema.parse({
      id: crypto.randomUUID(), projectId: head.projectId, projectRevisionId: updated.revisionId, geometryRevisionId: geometry.id,
      artifactRefs: artifacts.map((item) => item.id), status: "completed", results: [
        { code: "DRAWING_OUTPUT_HASH_CLOSURE", outcome: "passed", message: "所有图纸成果与服务端构建清单哈希一致。", sourceRefs: [completed.buildRecordHash] },
        { code: "PROFESSIONAL_REVIEW_REQUIRED", outcome: "blocked", message: "图纸尚未经过项目责任人员专业复核。", sourceRefs: [geometry.id] },
      ], reportAssetId: report.assetId, reportHash: report.sha256, qualification: "generated-not-qualified", l1Eligible: false, formalEligibility: false, completedAt: createdAt,
    });
    await this.input.commands.execute({ commandType: "CommitCheckRun", commandId: crypto.randomUUID(), projectId: head.projectId, actorId, expectedRevisionId: updated.revisionId, issuedAt: createdAt, payload: { checkRun } });
    updated = await this.input.repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_CHECK");
    return { head: updated, artifacts, checkRun };
  }
}
