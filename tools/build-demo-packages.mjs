import "fake-indexeddb/auto";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ProjectCommandService } from "../packages/application/dist/index.js";
import { createWorkbenchServer } from "../apps/server/dist/index.js";
import {
  CadJobClient, DeliveryService, DrawingJobClient,
  DEMO_PROJECTS, HERITAGE_BASELINE_RULE_DATA,
  IndexedDbProjectRepository, LocalAuthorization,
  buildArchetypeGeometrySpec, buildFullDemoProject, buildT0bDefinition, demoSeededUuid,
  openWorkbenchDatabase, resolveViewTargets, sha256Hex, translateLegacyGeometry,
} from "../packages/infrastructure/dist/index.js";

// 演示项目包构建：三个项目共用一条流程，从任务书跑到交付草案。
// 全程走产品自身的命令服务与真实作业进程，不为演示另做一套代码路径。
//
// 几何来源按项目不同：高都由形制参数经构件生成器产出；团队构造样板由
// 已验收的 r2 成果翻译得到；Dai Loy 的尺寸要先从 HABS 图纸读出来，
// 本轮不出三维，前面的环节照常保留。
//
// 三个项目共用一条链路。团队构造样板此前走独立脚本只跑几何，
// 图纸、检查与交付三格因此是空的，08 表 3 判定为演示不成立。

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "apps/workbench/public/demo");

function liftRatios(ruleSetId) {
  const set = HERITAGE_BASELINE_RULE_DATA.ruleSets.find((item) => item.ruleSetId === ruleSetId);
  if (!set) throw new Error(`RULE_SET_NOT_FOUND:${ruleSetId}`);
  return set.rules
    .filter((rule) => /^lift\d+$/.test(rule.ruleId))
    .sort((left, right) => Number(left.ruleId.slice(4)) - Number(right.ruleId.slice(4)))
    .map((rule) => {
      const matched = /\*\s*([0-9.]+)\s*$/.exec(rule.formula);
      if (!matched) throw new Error(`LIFT_RATIO_UNPARSEABLE:${rule.ruleId}`);
      return Number(matched[1]);
    });
}

const server = createWorkbenchServer({
  gateway: { configured: false, model: "none", execute: async () => { throw new Error("模型通道未用于演示包构建"); } },
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

// Node 内置 fetch 的响应体超时固定五分钟且不可配置，构件密集项目的制图
// 作业在这段时间里不发事件，流会被切断。构建脚本改用原生 http 读作业流，
// 并自己带会话 cookie。浏览器侧不受影响，产品代码不动。
const { request: httpRequest } = await import("node:http");

let cookie = "";
// 构建卡住时要能看出卡在哪一个请求上，作业本身不发事件的时段可能很长。
const trace = (text) => console.log(`    [http] ${new Date().toISOString().slice(11, 19)} ${text}`);

const fetchImpl = (input, init = {}) => new Promise((settle, fail) => {
  const url = new URL(String(input).startsWith("http") ? String(input) : `${base}${input}`);
  trace(`> ${init.method ?? "GET"} ${url.pathname}`);
  const headers = { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) };
  const outgoing = httpRequest({
    hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET", headers,
  }, (incoming) => {
    trace(`< ${incoming.statusCode} ${url.pathname}`);
    incoming.on("end", () => trace(`. end ${url.pathname}`));
    const setCookie = incoming.headers["set-cookie"]?.[0];
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    const chunks = [];
    // 响应体的结束状态必须在响应回调里同步记住。json 与 text 是等到调用时
    // 才执行的，短响应在调用方从 await 恢复之前就已经 end，那时再挂监听器
    // 永远等不到事件，整条构建会静默挂住。
    const finished = new Promise((done, fail2) => {
      incoming.on("end", done);
      incoming.on("error", fail2);
    });
    const body = new ReadableStream({
      start(controller) {
        incoming.on("data", (chunk) => { chunks.push(chunk); controller.enqueue(new Uint8Array(chunk)); });
        incoming.on("end", () => controller.close());
        incoming.on("error", (error) => controller.error(error));
      },
    });
    settle({
      ok: (incoming.statusCode ?? 500) < 400,
      status: incoming.statusCode ?? 500,
      headers: { get: (name) => incoming.headers[name.toLowerCase()] ?? null },
      body,
      json: () => finished.then(() => JSON.parse(Buffer.concat(chunks).toString("utf8"))),
      text: () => finished.then(() => Buffer.concat(chunks).toString("utf8")),
      arrayBuffer: () => finished.then(() => Buffer.concat(chunks)),
    });
  });
  outgoing.setTimeout(0);
  outgoing.on("error", (error) => { trace(`! ${url.pathname} ${error.message}`); fail(error); });
  if (init.body) outgoing.write(init.body);
  outgoing.end();
});

// 团队构造样板的定义由已验收的 r2 清单现算，数值不抄进源码
const t0bManifestPath = "文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v3-outputs/r2-geometry/geometry-manifest.json";
const t0bManifest = JSON.parse(await readFile(resolve(root, t0bManifestPath), "utf8"));
const definitions = [buildT0bDefinition(t0bManifest), ...DEMO_PROJECTS];

const entries = [];
try {
  for (const definition of definitions) {
    const files = new Map();
    for (const source of definition.sources) {
      if (source.filePath) files.set(source.filePath, new Uint8Array(await readFile(resolve(root, source.filePath))));
    }
    const repository = new IndexedDbProjectRepository(
      await openWorkbenchDatabase(`gujian-demo-build-${definition.demoId}`),
    );
    const commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
    const started = Date.now();
    const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

    const result = await buildFullDemoProject({
      definition, files, repository,
      resolveViewTargets: (view) => resolveViewTargets(t0bManifest, view),
      pipeline: {
        commands,
        cadJobs: new CadJobClient({ repository, commands, fetchImpl }),
        drawingJobs: new DrawingJobClient({ repository, commands, fetchImpl }),
        deliveries: new DeliveryService({ repository, commands }),
        geometrySourceZh: definition.demoId === "t0b-construction-sample"
          ? "已验收的构造样板几何成果翻译为本产品的几何契约，构件不改动"
          : "形制参数经构件生成器产出，尺寸来自照片估算与规则推算",
        geometrySpec: (head) => definition.demoId === "t0b-construction-sample"
          ? translateLegacyGeometry({
            manifest: t0bManifest,
            sourceFiles: [...files].map(([filePath, bytes]) => ({
              fileName: filePath.split("/").pop(), mimeType: "application/octet-stream",
              bytes, evidenceType: "other", title: filePath,
            })),
            fixtureId: t0bManifest.fixtureId,
            createdAt: definition.createdAt,
            projectId: head.snapshot.project.id,
            buildingId: head.snapshot.buildings[0].id,
            projectRevisionId: head.revisionId,
            manifestEvidenceId: demoSeededUuid(definition.demoId, "evidence/geometry-manifest"),
          }).spec
          : definition.archetype
          ? buildArchetypeGeometrySpec({
            head,
            archetype: definition.archetype,
            liftRatios: liftRatios(definition.archetype.ruleSetId),
            fixtureId: definition.demoId,
            formEvidenceRefs: head.snapshot.evidences.map((item) => item.id),
            keyPrefix: definition.demoId,
          })
          : null,
        onMatrix: (matrix) => { void writeFile(resolve(root, "apps/server/.data/_last-matrix.json"), JSON.stringify(matrix)); },
        onStage: (stage) => console.log(`  ${definition.demoId} ${stage} ${elapsed()}`),
      },
    });

    const fileName = `${definition.demoId}.gujian.zip`;
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, fileName), result.packageBytes);
    entries.push({
      demoId: result.demoId,
      fileName,
      projectName: definition.projectName,
      buildingName: definition.buildingName,
      limitationZh: definition.limitationZh,
      projectId: result.projectId,
      packageSha256: result.packageSha256,
      packageBytes: result.packageBytes.byteLength,
      evidenceCount: result.evidenceCount,
      missingEvidenceCount: result.missingEvidenceCount,
      factCount: result.factCount,
      issueCount: result.issueCount,
      geometryRevisionCount: result.geometryRevisionCount,
      geometryObjectCount: result.geometryObjectCount,
      artifactCount: result.artifactCount,
      checkRunCount: result.checkRunCount,
      deliveryCount: result.deliveryCount,
      stagesCompleted: result.stagesCompleted,
    });
    console.log(`${definition.demoId} ${(result.packageBytes.byteLength / 1024 / 1024).toFixed(2)} MiB 环节 ${result.stagesCompleted.length}`);
  }

  const manifest = {
    schemaVersion: "demo-library-1",
    generatedFrom: "tools/build-demo-packages.mjs",
    // 08 演示项目定义表 1 的顺序：专业深度、完整链路、阻断行为
    projects: entries,
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(output, "manifest.json"), manifestBytes);
  console.log(`manifest sha256=${sha256Hex(manifestBytes).slice(0, 16)}`);
} finally {
  server.close();
}
