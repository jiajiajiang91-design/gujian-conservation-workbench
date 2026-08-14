import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import type { ArtifactRequirementMatrix } from "@gujian/domain";
import { afterEach, describe, expect, it } from "vitest";

import { CadJobLedger } from "./cad-ledger.js";
import type { CadWorker, CadWorkerRun } from "./cad-worker.js";
import type { DrawingWorker, DrawingWorkerRun } from "./drawing-worker.js";
import { createWorkbenchServer, type ModelGateway } from "./index.js";

const openServers: Array<{ close: () => Promise<void>; ledger: CadJobLedger }> = [];

afterEach(async () => {
  for (const current of openServers.splice(0)) {
    await current.close();
    current.ledger.close();
  }
});

function workerRun(result: Promise<Awaited<DrawingWorkerRun["result"]>>): DrawingWorkerRun {
  const process = new EventEmitter() as DrawingWorkerRun["process"];
  Object.assign(process, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  return { process, result };
}

function cadRun(): CadWorkerRun {
  const process = new EventEmitter() as CadWorkerRun["process"];
  Object.assign(process, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  return { process, result: Promise.reject(new Error("not called")) };
}

function matrix(projectId: string, projectRevisionId: string, geometryRevisionId: string): ArtifactRequirementMatrix {
  const sheetId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  return {
    schemaVersion: "1.0", id: crypto.randomUUID(), projectId, projectRevisionId, geometryRevisionId,
    titleZh: "测试代理成果图", buildingDisplayNameZh: "测试建筑", issueState: "proxy-unissued", issueDate: null,
    revisionLabel: "P1", createdAt: "2026-08-14T00:00:00.000Z", observationCandidates: [],
    views: [{
      id: viewId, key: "floor-plan", displayLabelZh: "平面图", drawingRef: "平-01", kind: "floorPlan",
      scaleDenominator: 50, sheetId, viewportRectMm: [20, 70, 380, 220], direction: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0],
      sectionPlane: { normal: [0, 0, 1], offsetMm: 500 }, sourceTypes: [],
    }],
    sheets: [{ id: sheetId, drawingNumber: "P-01", displayLabelZh: "平面图", pageMm: [841, 594], viewIds: [viewId] }],
  };
}

async function start(drawingWorker: DrawingWorker) {
  const ledger = new CadJobLedger(":memory:");
  const gateway: ModelGateway = { configured: false, model: "kimi-k2.6", execute: async () => { throw new Error("not called"); } };
  const cadWorker: CadWorker = { start: cadRun, readAsset: () => Buffer.alloc(0) };
  const server = createWorkbenchServer({ gateway, cadLedger: ledger, cadWorker, drawingWorker });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  openServers.push({ close, ledger });
  return { baseUrl: `http://127.0.0.1:${address.port}`, ledger };
}

async function session(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/session`);
  const value = await response.json() as { csrfToken: string; drawingCapabilityToken: string };
  return { ...value, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

describe("controlled drawing jobs", () => {
  it("uses a successful geometry job and protects declared assets with the session cookie", async () => {
    const asset = Buffer.from("drawing");
    const drawingWorker: DrawingWorker = {
      start: () => workerRun(Promise.resolve({
        buildRecordHash: "b".repeat(64), outputDirectory: "server-owned",
        assets: [{ kind: "pdf", fileName: "sheet.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), byteLength: asset.length }],
      })),
      readAsset: (_jobId, fileName) => fileName === "sheet.pdf" ? asset : Buffer.alloc(0),
    };
    const { baseUrl, ledger } = await start(drawingWorker);
    const projectId = crypto.randomUUID();
    const projectRevisionId = crypto.randomUUID();
    const sourceCadJobId = crypto.randomUUID();
    ledger.start({ jobId: sourceCadJobId, projectId, projectRevisionId, geometrySpecId: crypto.randomUUID(), inputHash: "c".repeat(64), idempotencyKey: crypto.randomUUID(), startedAt: "2026-08-14T00:00:00.000Z" });
    ledger.append(sourceCadJobId, "succeeded", "d".repeat(64));
    ledger.complete(sourceCadJobId, { status: "succeeded", outputManifestHash: "d".repeat(64), outputDirectory: "server-owned" });
    const credentials = await session(baseUrl);
    const geometryRevisionId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const response = await fetch(`${baseUrl}/api/drawing-jobs`, {
      method: "POST", headers: { "content-type": "application/json", cookie: credentials.cookie, "x-csrf-token": credentials.csrfToken, "x-capability-token": credentials.drawingCapabilityToken },
      body: JSON.stringify({ jobId, clientRequestId: crypto.randomUUID(), sourceCadJobId, projectId, projectRevisionId, geometryRevisionId, artifactMatrix: matrix(projectId, projectRevisionId, geometryRevisionId) }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"type":"succeeded"');
    expect((await fetch(`${baseUrl}/api/drawing-jobs/${jobId}/assets/sheet.pdf`)).status).toBe(403);
    const downloaded = await fetch(`${baseUrl}/api/drawing-jobs/${jobId}/assets/sheet.pdf`, { headers: { cookie: credentials.cookie } });
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(asset);
  });

  it("rejects external paths and unknown matrix fields before starting the worker", async () => {
    let called = false;
    const drawingWorker: DrawingWorker = { start: () => { called = true; return workerRun(Promise.reject(new Error("not expected"))); }, readAsset: () => Buffer.alloc(0) };
    const { baseUrl } = await start(drawingWorker);
    const credentials = await session(baseUrl);
    const projectId = crypto.randomUUID();
    const projectRevisionId = crypto.randomUUID();
    const geometryRevisionId = crypto.randomUUID();
    const response = await fetch(`${baseUrl}/api/drawing-jobs`, {
      method: "POST", headers: { "content-type": "application/json", cookie: credentials.cookie, "x-csrf-token": credentials.csrfToken, "x-capability-token": credentials.drawingCapabilityToken },
      body: JSON.stringify({ jobId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), sourceCadJobId: crypto.randomUUID(), projectId, projectRevisionId, geometryRevisionId, artifactMatrix: { ...matrix(projectId, projectRevisionId, geometryRevisionId), source: "D:/Downloads/reference.dwg" } }),
    });
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});
