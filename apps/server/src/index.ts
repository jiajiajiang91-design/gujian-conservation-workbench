import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { z } from "zod";

import { KimiGateway, RunCancelledError, type GatewayResult } from "./kimi-gateway.js";
import { ModelRunLedger } from "./model-ledger.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.GUJIAN_SERVER_PORT ?? "8787", 10);
const defaultAllowedOrigin = process.env.GUJIAN_ALLOWED_ORIGIN ?? "http://127.0.0.1:5173";
const sessionLifetimeMs = 30 * 60 * 1_000;
const maxBodyBytes = 2 * 1_024 * 1_024;
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

interface SessionRecord {
  csrfToken: string;
  capabilityToken: string;
  capabilityUsed: boolean;
  expiresAt: number;
  lastRunStartedAt: number;
}

interface ActiveRun {
  controller: AbortController;
  response: ServerResponse;
  state: "running" | "cancelled" | "settled";
  lateRecorded: boolean;
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
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  allowedOrigin?: string;
} = {}) {
  const gateway = options.gateway ?? new KimiGateway();
  const ownsLedger = options.ledger === undefined;
  const ledger = options.ledger ?? new ModelRunLedger(process.env.NODE_ENV === "test" ? ":memory:" : undefined);
  const allowedOrigin = options.allowedOrigin ?? defaultAllowedOrigin;
  const sessions = new Map<string, SessionRecord>();
  const activeRuns = new Map<string, ActiveRun>();

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
      if (request.method === "GET" && url.pathname === "/api/status") {
        return writeJson(response, 200, {
          service: "gujian-workbench-server",
          ready: true,
          provider: "moonshot",
          model: gateway.model,
          modelConfigured: gateway.configured,
          projectStorage: "browser-indexeddb-v3",
        }, origin);
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        const sessionId = randomToken();
        const record: SessionRecord = {
          csrfToken: randomToken(), capabilityToken: randomToken(), capabilityUsed: false,
          expiresAt: Date.now() + sessionLifetimeMs, lastRunStartedAt: 0,
        };
        sessions.set(sessionId, record);
        response.setHeader("set-cookie", `gujian_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=1800`);
        return writeJson(response, 200, {
          csrfToken: record.csrfToken,
          capabilityToken: record.capabilityToken,
          expiresAt: new Date(record.expiresAt).toISOString(),
        }, origin);
      }

      const sessionId = parseCookies(request).get("gujian_session");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session || session.expiresAt < Date.now() || request.headers["x-csrf-token"] !== session.csrfToken) {
        return writeJson(response, 403, { error: "SESSION_OR_CSRF_INVALID" }, origin);
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
      return writeJson(response, 404, { error: "NOT_FOUND" }, origin);
    })().catch((error: unknown) => {
      if (!response.headersSent) writeJson(response, error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400, {
        error: publicErrorCode(error),
      });
      else if (!response.writableEnded) response.end();
    });
  });
  if (ownsLedger) server.once("close", () => ledger.close());
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
