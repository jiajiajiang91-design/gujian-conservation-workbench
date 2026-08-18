import "fake-indexeddb/auto";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEMO_PROJECTS,
  IndexedDbProjectRepository,
  buildDemoProject,
  openWorkbenchDatabase,
  sha256Hex,
} from "../packages/infrastructure/dist/index.js";

// 生成演示项目包。同一份输入必须得到同一份字节，重跑不产生新哈希。
// 输出进 apps/workbench/public/demo，工作台首次打开时按 manifest 装载。

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "apps/workbench/public/demo");

const entries = [];
for (const definition of DEMO_PROJECTS) {
  const paths = definition.sources.map((source) => source.filePath).filter((path) => path !== null);
  const files = new Map();
  for (const path of paths) {
    files.set(path, new Uint8Array(await readFile(resolve(root, path))));
  }
  const repository = new IndexedDbProjectRepository(
    await openWorkbenchDatabase(`gujian-demo-build-${definition.demoId}`),
  );
  const result = await buildDemoProject({ definition, files, repository });
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
    measurementCount: result.measurementCount,
    completeMeasurementCount: result.completeMeasurementCount,
    issueCount: result.issueCount,
  });
  console.log(`${definition.demoId} ${result.packageBytes.byteLength} bytes sha256=${result.packageSha256.slice(0, 16)}`);
}

// T0-B 演示包由 build-t0b-demo-package.mjs 单独生成（几何管线在 Python 侧），
// 这里只把它的清单条目并进来。条目不存在时清单少一项，装载器逐条处理不受影响。
const extra = [];
try {
  const entry = JSON.parse(await readFile(resolve(output, "t0b-construction-sample.entry.json"), "utf8"));
  extra.push(entry);
  console.log(`并入 ${entry.demoId} ${Math.round(entry.packageBytes / 1024 / 1024 * 100) / 100} MiB`);
} catch {
  console.log("未找到 T0-B 清单条目，清单只含本脚本生成的项目。补齐命令：node tools/build-t0b-demo-package.mjs");
}

const manifest = {
  schemaVersion: "demo-library-1",
  generatedFrom: "tools/build-demo-library.mjs",
  // 08 演示项目定义表 1 的顺序：专业深度、完整链路、阻断行为
  projects: [...extra, ...entries],
};
const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(output, "manifest.json"), manifestBytes);
console.log(`manifest sha256=${sha256Hex(manifestBytes).slice(0, 16)}`);
