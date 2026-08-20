import type { ProjectCommandService, ProjectHead } from "@gujian/application";
import type { IndexedDbProjectRepository } from "@gujian/infrastructure";
import { describe, expect, it, vi } from "vitest";

import { ModelRunClient } from "./model-run-client";

function head(): ProjectHead {
  const projectId = crypto.randomUUID();
  const buildingId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  return {
    projectId,
    revisionId: crypto.randomUUID(),
    auditEventId: crypto.randomUUID(),
    snapshot: {
      schemaVersion: "3.0",
      project: { id: projectId, name: "演示项目", status: "active", locationText: null, createdAt: new Date().toISOString() },
      buildings: [{ id: buildingId, projectId, name: "演示建筑", periodText: null, addressText: null, status: "existing" }],
      taskDefinitions: [],
      evidences: [{
        id: evidenceId, projectId, assetId, evidenceType: "document", title: "记录.txt",
        rightsDeclaration: null, intendedUse: null, recordedAt: null, relatedEntityRefs: [buildingId], dataStatus: "available",
      }],
      parseRecords: [{
        id: crypto.randomUUID(), projectId, assetId, evidenceId, parser: "utf8-text", parserVersion: "1.0.0",
        status: "parsed", extractedText: "仅有正立面照片，未提供现场尺寸。", warnings: [], createdAt: new Date().toISOString(),
      }],
      entities: [], exclusionRecords: [], relations: [], observations: [], measurements: [], facts: [], candidates: [], issues: [], dependencyEdges: [], geometrySpecs: [], geometryRevisions: [], adoptedRecordRefs: [],
    },
  };
}

describe("ModelRunClient", () => {
  it("保留浏览器原生 fetch 的调用上下文", async () => {
    const current = head();
    const asset = {
      id: current.snapshot.evidences[0]!.assetId,
      projectId: current.projectId,
      fileName: "记录.txt", mimeType: "text/plain", byteLength: 18, sha256: "a".repeat(64),
      contentStatus: "available" as const, createdAt: new Date().toISOString(),
    };
    const repository = {
      getProjectAssets: async () => [{ record: asset, content: new Blob(["test"]) }],
    } as unknown as IndexedDbProjectRepository;
    const commands = { execute: async () => ({}) } as unknown as ProjectCommandService;
    let receiver: unknown;
    vi.stubGlobal("fetch", function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response(JSON.stringify({ error: "EXPECTED_TEST_STOP" }), { status: 503 }));
    });
    try {
      const client = new ModelRunClient({ repository, commands });
      await expect(client.runEvidenceSummary(current, crypto.randomUUID(), () => undefined))
        .rejects.toThrow("EXPECTED_TEST_STOP");
      expect(receiver).toBe(globalThis);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("只把成功模型输出作为未审核候选提交", async () => {
    const current = head();
    const asset = {
      id: current.snapshot.evidences[0]!.assetId,
      projectId: current.projectId,
      fileName: "记录.txt", mimeType: "text/plain", byteLength: 18, sha256: "b".repeat(64),
      contentStatus: "available" as const, createdAt: new Date().toISOString(),
    };
    let committed: unknown;
    const repository = {
      getProjectAssets: async () => [{ record: asset, content: new Blob(["test"]) }],
      getProjectHead: async () => current,
    } as unknown as IndexedDbProjectRepository;
    const commands = {
      execute: async (command: unknown) => { committed = command; return {}; },
    } as unknown as ProjectCommandService;
    const event = (type: string, sequence: number, detail: string | null = null) => ({
      id: crypto.randomUUID(), runId: "RUN_ID", sequence, eventType: type, attempt: 1, detail, occurredAt: new Date().toISOString(),
    });
    let requestedRunId = "";
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (url === "/api/session") return new Response(JSON.stringify({ csrfToken: "csrf", capabilityToken: "cap", expiresAt: new Date().toISOString() }));
      const request = JSON.parse(String(init?.body)) as { runId: string };
      requestedRunId = request.runId;
      const content = '{"summary":"资料不足","findings":["有正立面照片"],"missingInformation":["现场尺寸"]}';
      return new Response([
        `data: ${JSON.stringify({ type: "queued", event: { ...event("queued", 0), runId: requestedRunId }, inputHash: "c".repeat(64), startedAt: new Date().toISOString(), model: "kimi-k2.6", provider: "moonshot" })}`,
        `data: ${JSON.stringify({ type: "running", event: { ...event("running", 1), runId: requestedRunId } })}`,
        `data: ${JSON.stringify({ type: "stream", event: { ...event("stream", 2, content), runId: requestedRunId }, content })}`,
        `data: ${JSON.stringify({ type: "succeeded", event: { ...event("succeeded", 3), runId: requestedRunId }, content, usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18, cachedTokens: 0 }, outputHash: "d".repeat(64) })}`,
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const client = new ModelRunClient({ repository, commands, fetchImpl });
    const result = await client.runEvidenceSummary(current, crypto.randomUUID(), () => undefined);
    expect(result.candidate?.producer).toEqual({ producerType: "model", runId: requestedRunId });
    expect(result.candidate?.reviewStatus).toBe("unreviewed");
    expect(result.candidate?.structured?.missingInformation).toEqual(["现场尺寸"]);
    expect(committed).toMatchObject({
      commandType: "CommitModelRunResult",
      expectedRevisionId: current.revisionId,
      payload: { run: { status: "succeeded" }, candidate: { reviewStatus: "unreviewed" } },
    });
  });
});


// 图纸尺寸转写（技术架构 7.2、用户旅程第二步）。模型读出的尺寸进待确认区，
// 人工确认后才写入项目。这里锁住输入侧的两条边界：请求发出去之前就该拦住。
describe("图纸尺寸转写的输入边界", () => {
  const stubClient = (calls: string[], current: ProjectHead) => {
    const evidence = current.snapshot.evidences[0]!;
    const asset = {
      id: evidence.assetId, projectId: current.projectId,
      fileName: "记录.txt", mimeType: "text/plain", byteLength: 18, sha256: "a".repeat(64),
      contentStatus: "available" as const, createdAt: new Date().toISOString(),
    };
    return new ModelRunClient({
      repository: { getProjectAssets: async () => [{ record: asset, content: new Blob(["x"]) }] } as unknown as IndexedDbProjectRepository,
      commands: {} as unknown as ProjectCommandService,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        throw new Error("不该走到这里");
      }) as unknown as typeof fetch,
    });
  };

  it("没有选中资料时不发请求", async () => {
    const calls: string[] = [];
    const current = head();
    await expect(stubClient(calls, current).runMeasurementTranscription(current, crypto.randomUUID(), [], () => {}))
      .rejects.toThrow("NO_DRAWING_EVIDENCE_SELECTED");
    expect(calls).toEqual([]);
  });

  it("选中的资料不是图像时不发请求", async () => {
    const calls: string[] = [];
    const current = head();
    const textEvidenceId = current.snapshot.evidences[0]!.id;
    await expect(stubClient(calls, current).runMeasurementTranscription(current, crypto.randomUUID(), [textEvidenceId], () => {}))
      .rejects.toThrow("NO_READABLE_DRAWING_FOR_MODEL");
    expect(calls).toEqual([]);
  });
});
