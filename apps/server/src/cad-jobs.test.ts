import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import type { CadWorker, CadWorkerRun } from "./cad-worker.js";
import { CadJobLedger } from "./cad-ledger.js";
import { createWorkbenchServer, type ModelGateway } from "./index.js";

const openServers: Array<{ close: () => Promise<void>; ledger: CadJobLedger }> = [];

afterEach(async () => {
  for (const current of openServers.splice(0)) {
    await current.close();
    current.ledger.close();
  }
});

function spec() {
  const projectId = crypto.randomUUID();
  const projectRevisionId = crypto.randomUUID();
  const buildingId = crypto.randomUUID();
  const geometrySpecId = crypto.randomUUID();
  const value = {
    schemaVersion: "2.0" as const, id: geometrySpecId, projectId, projectRevisionId, buildingId,
    inputHash: "0".repeat(64),
    coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ" as const, upAxis: "Z" as const, lengthUnit: "mm" as const, origin: [0, 0, 0] as [number, number, number] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects: [{
      id: crypto.randomUUID(), stableKey: "element-1", parentId: null, componentType: "base",
      displayNameZh: "基础对象", materialCode: "demo", solid: { kind: "box" as const, sizeX: "100", sizeY: "100", sizeZ: "100", centerMm: [0, 0, 50] as [number, number, number] },
      parameters: [], producer: { producerType: "demo" as const, fixtureId: "server-test" },
      factRefs: [], evidenceRefs: [], unknownRefs: [],
    }], interfaces: [], unknowns: [], createdAt: "2026-08-13T12:00:00.000Z",
  };
  return value;
}

async function hashSpec(value: ReturnType<typeof spec>): Promise<string> {
  const canonicalize = (item: unknown): unknown => Array.isArray(item) ? item.map(canonicalize) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]))
    : item;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonicalize({ ...value, inputHash: "0".repeat(64) }))));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function frozenSpec() {
  const value = spec();
  value.inputHash = await hashSpec(value);
  return value;
}

function workerRun(result: Promise<{ geometryRevisionId: string; geometrySignature: string; manifestHash: string; outputDirectory: string }>): CadWorkerRun {
  const process = new EventEmitter() as CadWorkerRun["process"];
  Object.assign(process, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  return { process, result };
}

async function start(worker: CadWorker) {
  const cadLedger = new CadJobLedger(":memory:");
  const gateway: ModelGateway = { configured: false, model: "kimi-k2.6", execute: async () => { throw new Error("not called"); } };
  const server = createWorkbenchServer({ gateway, cadLedger, cadWorker: worker });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  openServers.push({ close, ledger: cadLedger });
  return { baseUrl: `http://127.0.0.1:${address.port}`, cadLedger };
}

async function session(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/session`);
  const value = await response.json() as { csrfToken: string; cadCapabilityToken: string };
  return { ...value, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

describe("controlled CAD jobs", () => {
  it("accepts only a frozen GeometrySpec and streams a successful worker result", async () => {
    const manifestHash = "a".repeat(64);
    const worker: CadWorker = {
      start: () => workerRun(Promise.resolve({ geometryRevisionId: crypto.randomUUID(), geometrySignature: "b".repeat(64), manifestHash, outputDirectory: "server-owned" })),
      readAsset: () => Buffer.from("asset"),
    };
    const { baseUrl, cadLedger } = await start(worker);
    const credentials = await session(baseUrl);
    const geometrySpec = await frozenSpec();
    const jobId = crypto.randomUUID();
    const response = await fetch(`${baseUrl}/api/cad-jobs`, {
      method: "POST", headers: {
        "content-type": "application/json", cookie: credentials.cookie,
        "x-csrf-token": credentials.csrfToken, "x-capability-token": credentials.cadCapabilityToken,
      },
      body: JSON.stringify({ jobId, clientRequestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), projectId: geometrySpec.projectId, projectRevisionId: geometrySpec.projectRevisionId, geometrySpec }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"type":"succeeded"');
    expect(cadLedger.read(jobId)?.events.map((item) => item.eventType)).toEqual(["queued", "running", "succeeded"]);
    expect(cadLedger.read(jobId)?.job.output_manifest_hash).toBe(manifestHash);
  });

  it("rejects a changed input hash and arbitrary path or URL fields", async () => {
    let called = false;
    const worker: CadWorker = { start: () => { called = true; return workerRun(Promise.reject(new Error("not expected"))); }, readAsset: () => Buffer.alloc(0) };
    const { baseUrl } = await start(worker);
    const credentials = await session(baseUrl);
    const geometrySpec = await frozenSpec();
    const forged = { ...geometrySpec, inputHash: "f".repeat(64), path: "D:/Downloads/reference.dwg", url: "https://example.com" };
    const response = await fetch(`${baseUrl}/api/cad-jobs`, {
      method: "POST", headers: {
        "content-type": "application/json", cookie: credentials.cookie,
        "x-csrf-token": credentials.csrfToken, "x-capability-token": credentials.cadCapabilityToken,
      }, body: JSON.stringify({ jobId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), projectId: geometrySpec.projectId, projectRevisionId: geometrySpec.projectRevisionId, geometrySpec: forged }),
    });
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});
