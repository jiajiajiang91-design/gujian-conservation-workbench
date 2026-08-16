import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ArtifactRequirementMatrixSchema, ProjectDrivenGeometrySpecSchema } from "@gujian/domain";
import { z } from "zod";

import { ActionLedger } from "./actions/action-ledger.js";
import { AssistantRuntime } from "./actions/assistant-routes.js";
import { CadJobLedger } from "./cad-ledger.js";
import { PythonCadWorker, type CadWorker, type CadWorkerRun } from "./cad-worker.js";
import { KimiGateway, RunCancelledError, type GatewayResult } from "./kimi-gateway.js";
import { ModelRunLedger } from "./model-ledger.js";
import { PythonDrawingWorker, type DrawingWorker, type DrawingWorkerRun, type DrawingWorkerResult } from "./drawing-worker.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.GUJIAN_SERVER_PORT ?? "8787", 10);
const defaultAllowedOrigin = process.env.GUJIAN_ALLOWED_ORIGIN ?? "http://127.0.0.1:5173";
const sessionLifetimeMs = 30 * 60 * 1_000;
// GeometrySpec 随项目构件数增长（三方项目 1258 实体约 3.7 MB），上限按最大预期项目留余量
const maxBodyBytes = 32 * 1_024 * 1_024;
const maxEvidenceTextChars = 120_000;

const RunRequestSchema = z.object({
  runId: z.uuid(),
  clientRequestId: z.uuid(),
  projectId: z.uuid(),
  projectRevisionId: z.uuid(),
  taskType: z.literal("evidence-summary"),
  evidences: z.array(z.object({
    evidenceId: z.uuid(),
    assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().min(1).max(50_000),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, context) => {
  const total = value.evidences.reduce((sum, evidence) => sum + evidence.text.length, 0);
  if (total > maxEvidenceTextChars) {
    context.addIssue({ code: "custom", message: "evidence text exceeds the task limit", path: ["evidences"] });
  }
});

type RunRequest = z.infer<typeof RunRequestSchema>;

const CadJobRequestSchema = z.object({
  jobId: z.uuid(),
  clientRequestId: z.uuid(),
  idempotencyKey: z.uuid(),
  projectId: z.uuid(),
  projectRevisionId: z.uuid(),
  geometrySpec: ProjectDrivenGeometrySpecSchema,
}).strict();

const DrawingJobRequestSchema = z.object({
  jobId: z.uuid(),
  clientRequestId: z.uuid(),
  sourceCadJobId: z.uuid(),
  projectId: z.uuid(),
  projectRevisionId: z.uuid(),
  geometryRevisionId: z.uuid(),
  artifactMatrix: ArtifactRequirementMatrixSchema,
}).strict();

interface SessionRecord {
  csrfToken: string;
  capabilityToken: string;
  capabilityUsed: boolean;
  cadCapabilityToken: string;
  cadCapabilityUsed: boolean;
  drawingCapabilityToken: string;
  drawingCapabilityUsed: boolean;
  // 助手回合是多次调用，令牌不用后即焚；防护由 cookie + CSRF + 令牌比对承担。
  // confirm 端点不查此令牌：confirmToken 本身即一次性能力凭证（取即删）。
  assistantCapabilityToken: string;
  expiresAt: number;
  lastRunStartedAt: number;
}

interface ActiveRun {
  controller: AbortController;
  response: ServerResponse;
  state: "running" | "cancelled" | "settled";
  lateRecorded: boolean;
}

interface ActiveCadJob {
  workerRun: CadWorkerRun;
  response: ServerResponse;
  state: "running" | "cancelled" | "settled";
}

interface ActiveDrawingJob {
  workerRun: DrawingWorkerRun;
  response: ServerResponse;
}

export interface ModelGateway {
  readonly configured: boolean;
  readonly model: string;
  execute(input: {
    userContent: string;
    signal: AbortSignal;
    onStatus: (type: "running" | "retrying", attempt: number, detail: string | null) => void;
    onChunk: (content: string, attempt: number) => void;
  }): Promise<GatewayResult>;
  // 可选：助手动作层的函数调用入口。缺失时助手自动走关键词退路。
  executeWithTools?(input: {
    systemPrompt: string;
    userContent: string;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    signal: AbortSignal;
  }): Promise<
    | { kind: "tool_call"; name: string; argumentsJson: string; raw: string }
    | { kind: "text"; content: string; raw: string }
  >;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function geometryInputHash(value: z.infer<typeof ProjectDrivenGeometrySpecSchema>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize({ ...value, inputHash: "0".repeat(64) }))).digest("hex");
}

function containsForbiddenExternalInput(value: unknown): boolean {
  if (typeof value === "string") {
    return /^(?:https?:|file:)/i.test(value) || /^[A-Za-z]:[\\/]/.test(value) ||
      /(?:^|[\\/])Downloads(?:[\\/]|$)/i.test(value) || /\.(?:dwg|dws|dwt|dxf)$/i.test(value) ||
      /\b(?:xref|underlay|proxyObject)\b/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsForbiddenExternalInput);
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(containsForbiddenExternalInput));
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of (request.headers.cookie ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    result.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return result;
}

function writeJson(response: ServerResponse, status: number, payload: unknown, allowedOrigin?: string): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(allowedOrigin ? { "access-control-allow-origin": allowedOrigin, vary: "origin" } : {}),
  });
  response.end(JSON.stringify(payload));
}

function sendSse(response: ServerResponse, payload: unknown): void {
  if (!response.writableEnded) response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function taskContent(input: RunRequest): string {
  const evidence = input.evidences.map((item, index) => [
    `资料 ${index + 1}`,
    `evidenceId: ${item.evidenceId}`,
    `assetSha256: ${item.assetSha256}`,
    item.text,
  ].join("\n")).join("\n\n");
  return [
    "任务：整理以下古建保护项目资料，输出资料摘要、明确发现和缺失信息。",
    "限制：只能使用所给文本；不得补写现场测量、年代、材料、病害诊断或保护结论。",
    evidence,
  ].join("\n\n");
}

function publicErrorCode(error: unknown): string {
  if (error instanceof RunCancelledError) return "MODEL_RUN_CANCELLED";
  if (!(error instanceof Error)) return "MODEL_RUN_FAILED";
  const code = error.message.split(":", 1)[0] ?? "";
  if (/^(KIMI_[A-Z0-9_]+|MODEL_RUN_CANCELLED)$/.test(code)) return code;
  return "MODEL_RUN_FAILED";
}

export function createWorkbenchServer(options: {
  gateway?: ModelGateway;
  ledger?: ModelRunLedger;
  cadLedger?: CadJobLedger;
  cadWorker?: CadWorker;
  drawingWorker?: DrawingWorker;
  allowedOrigin?: string;
} = {}) {
  const gateway = options.gateway ?? new KimiGateway();
  const assistantRuntime = new AssistantRuntime({
    gateway: {
      get configured() { return gateway.configured && typeof gateway.executeWithTools === "function"; },
      executeWithTools: (input) => {
        if (!gateway.executeWithTools) throw new Error("KIMI_TOOLS_UNAVAILABLE");
        return gateway.executeWithTools(input);
      },
    },
    ledger: new ActionLedger(process.env.NODE_ENV === "test" ? ":memory:" : undefined),
  });
  const reconciledAsks = assistantRuntime.reconcileOrphanAsks();
  if (reconciledAsks > 0) console.log(`助手确认账本：${reconciledAsks} 条孤儿询问已按通道不可用补记决定`);
  const ownsLedger = options.ledger === undefined;
  const ledger = options.ledger ?? new ModelRunLedger(process.env.NODE_ENV === "test" ? ":memory:" : undefined);
  const ownsCadLedger = options.cadLedger === undefined;
  const cadLedger = options.cadLedger ?? new CadJobLedger(process.env.NODE_ENV === "test" ? ":memory:" : undefined);
  const cadWorker = options.cadWorker ?? new PythonCadWorker();
  const drawingWorker = options.drawingWorker ?? new PythonDrawingWorker();
  const allowedOrigin = options.allowedOrigin ?? defaultAllowedOrigin;
  const sessions = new Map<string, SessionRecord>();
  const activeRuns = new Map<string, ActiveRun>();
  const activeCadJobs = new Map<string, ActiveCadJob>();
  const activeDrawingJobs = new Map<string, ActiveDrawingJob>();
  const completedDrawingJobs = new Map<string, DrawingWorkerResult>();

  const server = createServer((request, response) => {
    void (async () => {
      const requestHost = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(requestHost)) {
        return writeJson(response, 403, { error: "HOST_NOT_ALLOWED" });
      }
      const origin = request.headers.origin;
      if (origin && origin !== allowedOrigin) {
        return writeJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": allowedOrigin,
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,x-csrf-token,x-capability-token",
          "access-control-allow-credentials": "true",
          vary: "origin",
        });
        return response.end();
      }

      const url = new URL(request.url ?? "/", `http://${requestHost}`);
      const cadAssetMatch = url.pathname.match(/^\/api\/cad-jobs\/([0-9a-f-]+)\/assets\/([^/]+)$/i);
      const drawingAssetMatch = url.pathname.match(/^\/api\/drawing-jobs\/([0-9a-f-]+)\/assets\/(.+)$/i);
      if (request.method === "GET" && url.pathname === "/api/status") {
        return writeJson(response, 200, {
          service: "gujian-workbench-server",
          ready: true,
          provider: "moonshot",
          model: gateway.model,
          modelConfigured: gateway.configured,
          projectStorage: "browser-indexeddb-v3",
          cadWorker: "cadquery-2.8.0/ocp-7.9.3.1.1",
        }, origin);
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        const sessionId = randomToken();
        const record: SessionRecord = {
          csrfToken: randomToken(), capabilityToken: randomToken(), capabilityUsed: false,
          cadCapabilityToken: randomToken(), cadCapabilityUsed: false,
          drawingCapabilityToken: randomToken(), drawingCapabilityUsed: false,
          assistantCapabilityToken: randomToken(),
          expiresAt: Date.now() + sessionLifetimeMs, lastRunStartedAt: 0,
        };
        sessions.set(sessionId, record);
        response.setHeader("set-cookie", `gujian_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=1800`);
        return writeJson(response, 200, {
          csrfToken: record.csrfToken,
          capabilityToken: record.capabilityToken,
          cadCapabilityToken: record.cadCapabilityToken,
          drawingCapabilityToken: record.drawingCapabilityToken,
          assistantCapabilityToken: record.assistantCapabilityToken,
          expiresAt: new Date(record.expiresAt).toISOString(),
        }, origin);
      }

      if (cadAssetMatch && request.method === "GET") {
        const assetSessionId = parseCookies(request).get("gujian_session");
        const assetSession = assetSessionId ? sessions.get(assetSessionId) : undefined;
        if (!assetSession || assetSession.expiresAt < Date.now()) return writeJson(response, 403, { error: "SESSION_INVALID" }, origin);
        const jobId = cadAssetMatch[1] ?? "";
        const fileName = cadAssetMatch[2] ?? "";
        const entry = cadLedger.read(jobId);
        if (!entry || entry.job.status !== "succeeded") return writeJson(response, 404, { error: "CAD_ASSET_NOT_READY" }, origin);
        const data = cadWorker.readAsset(jobId, fileName);
        const mime = fileName.endsWith(".glb") ? "model/gltf-binary" : fileName.endsWith(".ifc") ? "application/x-step"
          : fileName.endsWith(".zip") ? "application/zip"
          : fileName.endsWith(".png") ? "image/png" : fileName.endsWith(".ndjson") ? "application/x-ndjson" : "application/json";
        response.writeHead(200, { "content-type": mime, "content-length": data.length, "cache-control": "no-store" });
        return response.end(data);
      }

      if (drawingAssetMatch && request.method === "GET") {
        const assetSessionId = parseCookies(request).get("gujian_session");
        const assetSession = assetSessionId ? sessions.get(assetSessionId) : undefined;
        if (!assetSession || assetSession.expiresAt < Date.now()) return writeJson(response, 403, { error: "SESSION_INVALID" }, origin);
        const jobId = drawingAssetMatch[1] ?? "";
        if (!completedDrawingJobs.has(jobId)) return writeJson(response, 404, { error: "DRAWING_ASSET_NOT_READY" }, origin);
        const fileName = (drawingAssetMatch[2] ?? "").split("/").map((part) => decodeURIComponent(part)).join("/");
        const data = drawingWorker.readAsset(jobId, fileName);
        const mime = fileName.endsWith(".dxf") ? "image/vnd.dxf" : fileName.endsWith(".svg") ? "image/svg+xml"
          : fileName.endsWith(".pdf") ? "application/pdf" : fileName.endsWith(".png") ? "image/png"
            : fileName.endsWith(".ndjson") ? "application/x-ndjson" : fileName.endsWith(".gz") ? "application/gzip" : "application/json";
        response.writeHead(200, { "content-type": mime, "content-length": data.length, "cache-control": "no-store" });
        return response.end(data);
      }

      const sessionId = parseCookies(request).get("gujian_session");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session || session.expiresAt < Date.now() || request.headers["x-csrf-token"] !== session.csrfToken) {
        return writeJson(response, 403, { error: "SESSION_OR_CSRF_INVALID" }, origin);
      }

      if (request.method === "POST" && url.pathname === "/api/assistant/turn") {
        if (request.headers["x-capability-token"] !== session.assistantCapabilityToken) {
          return writeJson(response, 403, { error: "ASSISTANT_CAPABILITY_INVALID" }, origin);
        }
        const body = await readJsonBody(request);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
          ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
        });
        const controller = new AbortController();
        response.once("close", () => controller.abort());
        const sessionRef = createHash("sha256").update(sessionId ?? "").digest("hex").slice(0, 32);
        try {
          await assistantRuntime.handleTurn(body, sessionRef, (event) => sendSse(response, event), controller.signal);
        } catch (error) {
          sendSse(response, { type: "failed", text: "助手服务处理失败，本次未执行任何动作", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        }
        return response.end();
      }

      if (request.method === "POST" && url.pathname === "/api/assistant/confirm") {
        const body = await readJsonBody(request);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
          ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
        });
        const sessionRef = createHash("sha256").update(sessionId ?? "").digest("hex").slice(0, 32);
        try {
          await assistantRuntime.handleConfirm(body, sessionRef, (event) => sendSse(response, event));
        } catch (error) {
          sendSse(response, { type: "failed", text: "确认处理失败，该动作未执行", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        }
        return response.end();
      }

      if (request.method === "POST" && url.pathname === "/api/model-runs") {
        if (request.headers["x-capability-token"] !== session.capabilityToken || session.capabilityUsed) {
          return writeJson(response, 403, { error: "CAPABILITY_INVALID" }, origin);
        }
        if (!gateway.configured) return writeJson(response, 503, { error: "KIMI_API_KEY_NOT_CONFIGURED" }, origin);
        if (Date.now() - session.lastRunStartedAt < 1_000) {
          return writeJson(response, 429, { error: "RUN_RATE_LIMITED" }, origin);
        }
        const parsed = RunRequestSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) return writeJson(response, 400, { error: "RUN_REQUEST_INVALID", issues: parsed.error.issues }, origin);
        if (activeRuns.has(parsed.data.runId) || ledger.read(parsed.data.runId)) {
          return writeJson(response, 409, { error: "RUN_ALREADY_EXISTS" }, origin);
        }
        if ([...activeRuns.values()].some((run) => run.state === "running")) {
          return writeJson(response, 429, { error: "RUN_CONCURRENCY_LIMITED" }, origin);
        }

        session.capabilityUsed = true;
        session.lastRunStartedAt = Date.now();
        const inputHash = canonicalHash(parsed.data);
        const startedAt = new Date().toISOString();
        ledger.start({
          runId: parsed.data.runId,
          projectId: parsed.data.projectId,
          projectRevisionId: parsed.data.projectRevisionId,
          taskType: parsed.data.taskType,
          inputHash,
          provider: "moonshot",
          model: gateway.model,
          startedAt,
        });
        const queued = ledger.append(parsed.data.runId, "queued", 1, null);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
          ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
        });
        const active: ActiveRun = { controller: new AbortController(), response, state: "running", lateRecorded: false };
        activeRuns.set(parsed.data.runId, active);
        response.once("close", () => {
          if (active.state !== "running") return;
          active.state = "cancelled";
          ledger.append(parsed.data.runId, "cancelled", 1, "client-disconnected");
          ledger.complete(parsed.data.runId, "cancelled", null, null);
          active.controller.abort();
        });
        sendSse(response, { type: "queued", event: queued, inputHash, startedAt, model: gateway.model, provider: "moonshot" });

        const recordLate = (attempt: number, detail: string) => {
          if (active.lateRecorded) return;
          active.lateRecorded = true;
          ledger.append(parsed.data.runId, "late", attempt, detail);
        };
        try {
          const result = await gateway.execute({
            userContent: taskContent(parsed.data),
            signal: active.controller.signal,
            onStatus(type, attempt, detail) {
              if (active.state !== "running") return recordLate(attempt, `ignored-${type}`);
              const event = ledger.append(parsed.data.runId, type, attempt, detail);
              sendSse(response, { type, event });
            },
            onChunk(content, attempt) {
              if (active.state !== "running") return recordLate(attempt, "ignored-stream");
              const event = ledger.append(parsed.data.runId, "stream", attempt, content.slice(0, 2_000));
              sendSse(response, { type: "stream", event, content });
            },
          });
          if (active.state !== "running") {
            recordLate(result.attempt, "ignored-completion");
          } else {
            const outputHash = canonicalHash(result.content);
            const event = ledger.append(parsed.data.runId, "succeeded", result.attempt, null);
            ledger.complete(parsed.data.runId, "succeeded", outputHash, result.usage);
            active.state = "settled";
            sendSse(response, { type: "succeeded", event, content: result.content, usage: result.usage, outputHash });
            response.end();
          }
        } catch (error) {
          if (active.state === "cancelled") {
            // Cancellation was already persisted and sent by the DELETE endpoint.
          } else {
            const errorCode = publicErrorCode(error);
            const event = ledger.append(parsed.data.runId, "failed", 1, errorCode);
            ledger.complete(parsed.data.runId, "failed", null, null);
            active.state = "settled";
            sendSse(response, { type: "failed", event, errorCode });
            response.end();
          }
        } finally {
          activeRuns.delete(parsed.data.runId);
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cad-jobs") {
        if (request.headers["x-capability-token"] !== session.cadCapabilityToken || session.cadCapabilityUsed) {
          return writeJson(response, 403, { error: "CAD_CAPABILITY_INVALID" }, origin);
        }
        const body = await readJsonBody(request);
        if (containsForbiddenExternalInput(body)) return writeJson(response, 400, { error: "CAD_EXTERNAL_INPUT_FORBIDDEN" }, origin);
        const parsed = CadJobRequestSchema.safeParse(body);
        if (!parsed.success) return writeJson(response, 400, { error: "CAD_JOB_REQUEST_INVALID", issues: parsed.error.issues }, origin);
        const input = parsed.data;
        if (input.projectId !== input.geometrySpec.projectId || input.projectRevisionId !== input.geometrySpec.projectRevisionId ||
            input.geometrySpec.inputHash !== geometryInputHash(input.geometrySpec)) {
          return writeJson(response, 400, { error: "CAD_INPUT_SNAPSHOT_INVALID" }, origin);
        }
        if (cadLedger.read(input.jobId) || activeCadJobs.has(input.jobId)) {
          return writeJson(response, 409, { error: "CAD_JOB_ALREADY_EXISTS" }, origin);
        }
        if ([...activeCadJobs.values()].some((job) => job.state === "running")) {
          return writeJson(response, 429, { error: "CAD_JOB_CONCURRENCY_LIMITED" }, origin);
        }
        session.cadCapabilityUsed = true;
        const startedAt = new Date().toISOString();
        cadLedger.start({
          jobId: input.jobId, projectId: input.projectId, projectRevisionId: input.projectRevisionId,
          geometrySpecId: input.geometrySpec.id, inputHash: input.geometrySpec.inputHash,
          idempotencyKey: input.idempotencyKey, startedAt,
        });
        const queued = cadLedger.append(input.jobId, "queued", null);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform",
          connection: "keep-alive", "x-content-type-options": "nosniff",
          ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
        });
        sendSse(response, { type: "queued", event: queued, inputHash: input.geometrySpec.inputHash, startedAt });
        let workerRun: CadWorkerRun;
        try {
          workerRun = cadWorker.start({ jobId: input.jobId, geometrySpec: input.geometrySpec });
        } catch (error) {
          const event = cadLedger.append(input.jobId, "failed", "CAD_WORKER_START_FAILED");
          cadLedger.complete(input.jobId, { status: "failed", outputManifestHash: null, outputDirectory: null });
          sendSse(response, { type: "failed", event, errorCode: publicErrorCode(error) });
          return response.end();
        }
        const active: ActiveCadJob = { workerRun, response, state: "running" };
        activeCadJobs.set(input.jobId, active);
        const running = cadLedger.append(input.jobId, "running", null);
        sendSse(response, { type: "running", event: running });
        try {
          const result = await workerRun.result;
          if (active.state === "cancelled") {
            const late = cadLedger.append(input.jobId, "late", "ignored-worker-completion");
            sendSse(response, { type: "late", event: late });
          } else {
            const succeeded = cadLedger.append(input.jobId, "succeeded", result.manifestHash);
            cadLedger.complete(input.jobId, { status: "succeeded", outputManifestHash: result.manifestHash, outputDirectory: result.outputDirectory });
            active.state = "settled";
            sendSse(response, { type: "succeeded", event: succeeded, ...result });
            response.end();
          }
        } catch (error) {
          if (active.state !== "cancelled") {
            const event = cadLedger.append(input.jobId, "failed", publicErrorCode(error));
            cadLedger.complete(input.jobId, { status: "failed", outputManifestHash: null, outputDirectory: null });
            active.state = "settled";
            sendSse(response, { type: "failed", event, errorCode: publicErrorCode(error) });
            response.end();
          }
        } finally {
          activeCadJobs.delete(input.jobId);
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/drawing-jobs") {
        if (request.headers["x-capability-token"] !== session.drawingCapabilityToken || session.drawingCapabilityUsed) {
          return writeJson(response, 403, { error: "DRAWING_CAPABILITY_INVALID" }, origin);
        }
        const body = await readJsonBody(request);
        if (containsForbiddenExternalInput(body)) return writeJson(response, 400, { error: "DRAWING_EXTERNAL_INPUT_FORBIDDEN" }, origin);
        const parsed = DrawingJobRequestSchema.safeParse(body);
        if (!parsed.success) return writeJson(response, 400, { error: "DRAWING_JOB_REQUEST_INVALID", issues: parsed.error.issues }, origin);
        const input = parsed.data;
        const source = cadLedger.read(input.sourceCadJobId);
        if (!source || source.job.status !== "succeeded" || source.job.project_id !== input.projectId ||
            source.job.project_revision_id !== input.projectRevisionId ||
            input.artifactMatrix.projectId !== input.projectId || input.artifactMatrix.projectRevisionId !== input.projectRevisionId ||
            input.artifactMatrix.geometryRevisionId !== input.geometryRevisionId) {
          return writeJson(response, 400, { error: "DRAWING_SOURCE_CLOSURE_INVALID" }, origin);
        }
        if (activeDrawingJobs.size || completedDrawingJobs.has(input.jobId)) return writeJson(response, 409, { error: "DRAWING_JOB_ALREADY_EXISTS" }, origin);
        session.drawingCapabilityUsed = true;
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive" });
        sendSse(response, { type: "queued", jobId: input.jobId });
        let workerRun: DrawingWorkerRun;
        try {
          workerRun = drawingWorker.start({ jobId: input.jobId, sourceCadJobId: input.sourceCadJobId, matrix: input.artifactMatrix });
        } catch (error) {
          sendSse(response, { type: "failed", jobId: input.jobId, errorCode: publicErrorCode(error) });
          return response.end();
        }
        activeDrawingJobs.set(input.jobId, { workerRun, response });
        sendSse(response, { type: "running", jobId: input.jobId });
        try {
          const result = await workerRun.result;
          completedDrawingJobs.set(input.jobId, result);
          sendSse(response, { type: "succeeded", jobId: input.jobId, buildRecordHash: result.buildRecordHash, assets: result.assets });
        } catch (error) {
          sendSse(response, { type: "failed", jobId: input.jobId, errorCode: publicErrorCode(error) });
        } finally {
          activeDrawingJobs.delete(input.jobId);
          response.end();
        }
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/model-runs\/([0-9a-f-]+)$/i);
      if (runMatch && request.method === "DELETE") {
        const runId = runMatch[1] ?? "";
        const active = activeRuns.get(runId);
        if (!active || active.state !== "running") return writeJson(response, 404, { error: "RUN_NOT_ACTIVE" }, origin);
        active.state = "cancelled";
        const event = ledger.append(runId, "cancelled", 1, "user-cancelled");
        ledger.complete(runId, "cancelled", null, null);
        active.controller.abort();
        sendSse(active.response, { type: "cancelled", event });
        active.response.end();
        return writeJson(response, 200, { runId, status: "cancelled" }, origin);
      }
      if (runMatch && request.method === "GET") {
        const entry = ledger.read(runMatch[1] ?? "");
        return entry
          ? writeJson(response, 200, entry, origin)
          : writeJson(response, 404, { error: "RUN_NOT_FOUND" }, origin);
      }
      const cadMatch = url.pathname.match(/^\/api\/cad-jobs\/([0-9a-f-]+)$/i);
      if (cadMatch && request.method === "GET") {
        const entry = cadLedger.read(cadMatch[1] ?? "");
        return entry ? writeJson(response, 200, entry, origin) : writeJson(response, 404, { error: "CAD_JOB_NOT_FOUND" }, origin);
      }
      if (cadMatch && request.method === "DELETE") {
        const jobId = cadMatch[1] ?? "";
        const active = activeCadJobs.get(jobId);
        if (!active || active.state !== "running") return writeJson(response, 404, { error: "CAD_JOB_NOT_ACTIVE" }, origin);
        active.state = "cancelled";
        active.workerRun.process.kill();
        const event = cadLedger.append(jobId, "cancelled", "user-cancelled");
        cadLedger.complete(jobId, { status: "cancelled", outputManifestHash: null, outputDirectory: null });
        sendSse(active.response, { type: "cancelled", event });
        active.response.end();
        return writeJson(response, 200, { jobId, status: "cancelled" }, origin);
      }
      return writeJson(response, 404, { error: "NOT_FOUND" }, origin);
    })().catch((error: unknown) => {
      if (!response.headersSent) writeJson(response, error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400, {
        error: publicErrorCode(error),
      });
      else if (!response.writableEnded) response.end();
    });
  });
  server.once("close", () => {
    if (ownsLedger) ledger.close();
    if (ownsCadLedger) cadLedger.close();
  });
  return server;
}

if (process.env.NODE_ENV !== "test") {
  const server = createWorkbenchServer();
  server.listen(port, host, () => {
    console.log(`古建保护成果工作台服务：http://${host}:${port}`);
  });
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
