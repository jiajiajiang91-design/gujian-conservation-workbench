import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

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

// 永不自行结束的子进程：只有被 kill 后 result 才落定，用于检验退出收口确实等待了子进程。
function hangingRun<T>() {
  let killed = false;
  let settle: () => void = () => undefined;
  const result = new Promise<T>((_resolve, reject) => { settle = () => reject(new Error("WORKER_KILLED")); });
  const process = new EventEmitter() as CadWorkerRun["process"];
  Object.assign(process, {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { killed = true; settle(); return true; },
  });
  return { run: { process, result } as unknown as CadWorkerRun & DrawingWorkerRun, wasKilled: () => killed };
}

function spec() {
  const projectId = crypto.randomUUID();
  const projectRevisionId = crypto.randomUUID();
  return {
    schemaVersion: "2.0" as const, id: crypto.randomUUID(), projectId, projectRevisionId, buildingId: crypto.randomUUID(),
    inputHash: "0".repeat(64),
    coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ" as const, upAxis: "Z" as const, lengthUnit: "mm" as const, origin: [0, 0, 0] as [number, number, number] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects: [{
      id: crypto.randomUUID(), stableKey: "element-1", parentId: null, componentType: "base",
      displayNameZh: "基础对象", materialCode: "demo",
      solid: { kind: "box" as const, sizeX: "100", sizeY: "100", sizeZ: "100", centerMm: [0, 0, 50] as [number, number, number] },
      parameters: [], producer: { producerType: "demo" as const, fixtureId: "server-test" },
      factRefs: [], evidenceRefs: [], unknownRefs: [],
    }], interfaces: [], unknowns: [], createdAt: "2026-08-13T12:00:00.000Z",
  };
}

async function frozenSpec() {
  const value = spec();
  const canonicalize = (item: unknown): unknown => Array.isArray(item) ? item.map(canonicalize) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]))
    : item;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonicalize({ ...value, inputHash: "0".repeat(64) }))));
  value.inputHash = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return value;
}

async function start(cadWorker: CadWorker) {
  const cadLedger = new CadJobLedger(":memory:");
  const gateway: ModelGateway = { configured: false, model: "kimi-k2.6", execute: async () => { throw new Error("not called"); } };
  const server = createWorkbenchServer({ gateway, cadLedger, cadWorker });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  openServers.push({ close, ledger: cadLedger });
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, cadLedger };
}

async function session(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/session`);
  const value = await response.json() as { csrfToken: string; cadCapabilityToken: string };
  return { ...value, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

describe("服务退出收口", () => {
  it("取消在途 CAD 作业：终止子进程、记账为 cancelled 并结束流", async () => {
    const hanging = hangingRun<never>();
    const worker: CadWorker = { start: () => hanging.run, readAsset: () => Buffer.alloc(0) };
    const { server, baseUrl, cadLedger } = await start(worker);
    const credentials = await session(baseUrl);
    const geometrySpec = await frozenSpec();
    const jobId = crypto.randomUUID();
    const streamed = fetch(`${baseUrl}/api/cad-jobs`, {
      method: "POST", headers: {
        "content-type": "application/json", cookie: credentials.cookie,
        "x-csrf-token": credentials.csrfToken, "x-capability-token": credentials.cadCapabilityToken,
      },
      body: JSON.stringify({
        jobId, clientRequestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
        projectId: geometrySpec.projectId, projectRevisionId: geometrySpec.projectRevisionId, geometrySpec,
      }),
    });
    // 等作业进入 running 再收口，否则测的是未开工状态
    const response = await streamed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.cancelActiveWork();

    expect(hanging.wasKilled()).toBe(true);
    expect(cadLedger.read(jobId)?.job.status).toBe("cancelled");
    expect(cadLedger.read(jobId)?.events.map((item) => item.eventType)).toContain("cancelled");
    expect(await response.text()).toContain('"type":"queued"');
  });

  it("没有在途作业时收口不报错", async () => {
    const worker: CadWorker = {
      start: () => hangingRun<never>().run,
      readAsset: () => Buffer.alloc(0),
    };
    const { server } = await start(worker);
    await expect(server.cancelActiveWork()).resolves.toBeUndefined();
  });
});
