import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { buildDemoProjectPackage, sha256Hex } from "../packages/infrastructure/dist/index.js";

// T0-B 团队构造样板演示包（08 演示项目定义 3.1）。
//
// 几何来源是已验收的 r2 成果，不是 fixture：fixture 是验收期望值不是输入。
// 但 r2 目录只有清单、源网格与 GLB，缺 ifc 与 preview，凑不齐
// GeometryRevision 要求的六类资产。所以先把清单翻译成 GeometrySpec，
// 再交给几何管线跑一次补齐七类，最后把成果随包携带，做到导入即可见。

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v3-outputs/r2-geometry");
const python = resolve(root, "workers/cad/.venv/Scripts/python.exe");

// 与 r2 独立验证报告核对的口径：只比可比的量。
// 比的是 r2 源数据本身与 geometry-verification.json 记录的已验收结果。
// 不比签名：r2 的 geometrySignature 出自 t0b_v3 链路，几何管线对翻译后 spec
// 另算一个签名，两者不是同一个量。
// 也不比接口条数与携带条数：转换器按设计只携带竖向承重链接口，
// 其余记为结构化未知项，携带数少于源数是预期行为不是偏差。

const GEOMETRY_MIME = {
  ifc: "application/x-step",
  glb: "model/gltf-binary",
  brepBundle: "application/zip",
  manifest: "application/json",
  sourceMap: "application/x-ndjson",
  report: "application/json",
  preview: "image/png",
};

function run(command, args) {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", fail);
    child.on("close", (code) => code === 0 ? settle(out) : fail(new Error(`${command} exited ${code}: ${err.slice(-2000)}`)));
  });
}

// 源网格必须随包：它是构件翻译的功能输入，不是可选资料。
// 去掉后每个构件退化成轴对齐包围盒，几何校验直接失败。
// 原始 GLB 只是同一份几何的另一种渲染，与生成的 model.glb 重复，按技术架构
// 12.4 不随包，改在来源记录里留路径与哈希。
async function readSource() {
  const [manifestText, meshes, glb] = await Promise.all([
    readFile(resolve(source, "geometry-manifest.json"), "utf8"),
    readFile(resolve(source, "source-meshes.ndjson.gz")),
    readFile(resolve(source, "local-construction-sample.glb")),
  ]);
  const provenance = {
    schemaVersion: "t0b-demo-provenance-1",
    descriptionZh: "本演示项目的几何来自下列已验收成果。原始文件按技术架构 12.4 留在忽略目录，此处记录路径与哈希供核对。",
    sourceDirectory: "文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v3-outputs/r2-geometry",
    files: [
      { path: "geometry-manifest.json", sha256: sha256Hex(new TextEncoder().encode(manifestText)), byteLength: Buffer.byteLength(manifestText) },
      { path: "source-meshes.ndjson.gz", sha256: sha256Hex(new Uint8Array(meshes)), byteLength: meshes.byteLength },
      { path: "local-construction-sample.glb", sha256: sha256Hex(new Uint8Array(glb)), byteLength: glb.byteLength },
    ],
    rebuildCommand: "node tools/build-t0b-demo-package.mjs",
  };
  const provenanceText = `${JSON.stringify(provenance, null, 2)}
`;
  return {
    manifest: JSON.parse(manifestText),
    sourceFiles: [
      { fileName: "geometry-manifest.json", mimeType: "application/json", bytes: new TextEncoder().encode(manifestText), evidenceType: "document", title: "构件清单与接口关系" },
      { fileName: "source-meshes.ndjson.gz", mimeType: "application/gzip", bytes: new Uint8Array(meshes), evidenceType: "other", title: "构件网格数据" },
      { fileName: "来源记录.json", mimeType: "application/json", bytes: new TextEncoder().encode(provenanceText), evidenceType: "document", title: "几何来源与哈希记录" },
    ],
  };
}

const DEMO_ID = "t0b-construction-sample";
const PACKAGE_FILE = `${DEMO_ID}.gujian.zip`;

const BASE = {
  createdAt: "2026-08-18T00:00:00Z",
  projectName: "团队构造样板：古建局部构造",
  buildingName: "古建局部构造样板",
  fixtureId: "t0b-v3-construction-sample",
};

// 08 演示项目定义 3.1 的局限声明，随包进界面，不改写。
const LIMITATION = "数据为团队自建参数化模型，不是任何真实建筑的实测结果，不具备正式资格。它证明技术路线能生成何种深度的成果，不代表已完成某栋真实建筑的测绘。";

const { manifest, sourceFiles } = await readSource();

const accepted = JSON.parse(await readFile(resolve(source, "geometry-verification.json"), "utf8"));
const sourceCounts = {
  entityCount: manifest.entities.length,
  interfaceCount: (manifest.interfaces ?? []).length,
  componentTypeCount: new Set(manifest.entities.map((entity) => entity.componentType)).size,
};
const mismatches = Object.entries(sourceCounts)
  .filter(([key, value]) => value !== accepted.checks.entities[key] && value !== accepted.checks.interfaces[key])
  .map(([key, value]) => `${key} 源数据 ${value} 与已验收结果对不上`);
if (mismatches.length) throw new Error(`r2 源数据与已验收结果不一致：${mismatches.join("；")}`);
console.log(`源数据核对通过 ${JSON.stringify(sourceCounts)}`);

// 第一遍只为拿到翻译后的 GeometrySpec，不落盘。
const translated = buildDemoProjectPackage({ manifest, sourceFiles, ...BASE });
console.log(`翻译结果 携带接口=${translated.interfaceCount} 结构化未知项=${translated.unknownCount}`);

const work = await mkdtemp(join(tmpdir(), "gujian-t0b-"));
try {
  const specPath = join(work, "spec.json");
  await writeFile(specPath, JSON.stringify(translated.geometrySpec));

  const outputDir = join(work, "geometry");
  console.log("几何管线运行中，约需一分钟");
  await run(python, ["-m", "workers.cad.project_geometry.build_job", "--input", specPath, "--output", outputDir]);
  const built = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));

  const assets = [];
  for (const asset of built.assets) {
    assets.push({
      kind: asset.kind, fileName: asset.fileName,
      mimeType: GEOMETRY_MIME[asset.kind] ?? asset.mimeType ?? "application/octet-stream",
      bytes: new Uint8Array(await readFile(join(outputDir, asset.fileName))),
    });
  }
  const manifestBytes = new Uint8Array(await readFile(join(outputDir, "manifest.json")));
  assets.push({ kind: "manifest", fileName: "geometry-manifest.json", mimeType: GEOMETRY_MIME.manifest, bytes: manifestBytes });

  const result = buildDemoProjectPackage({
    manifest, sourceFiles, ...BASE,
    geometry: {
      assets,
      inputHash: built.inputHash,
      entityClosureHash: built.entityClosureHash,
      interfaceClosureHash: built.interfaceClosureHash,
      geometrySignature: built.geometrySignature,
      blockers: built.blockers?.length ? built.blockers : ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"],
    },
  });

  const outDir = resolve(root, "apps/workbench/public/demo");
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, PACKAGE_FILE), result.packageBytes);
  // 清单条目单独落盘，由 build-demo-library.mjs 合并进 manifest.json。
  // 两个脚本走不同的构建路径，合并点放在清单侧最省事也最不容易漏。
  await writeFile(resolve(outDir, `${DEMO_ID}.entry.json`), `${JSON.stringify({
    demoId: DEMO_ID,
    fileName: PACKAGE_FILE,
    projectName: BASE.projectName,
    buildingName: BASE.buildingName,
    limitationZh: LIMITATION,
    projectId: result.projectId,
    packageSha256: result.packageSha256,
    packageBytes: result.packageBytes.byteLength,
    geometryRevisionId: result.geometryRevisionId,
    geometryAssetCount: result.geometryAssetCount,
    geometrySignature: built.geometrySignature,
    r2GeometrySignature: result.originalGeometrySignature,
    sourceCounts,
    carriedInterfaceCount: result.interfaceCount,
    unknownCount: result.unknownCount,
    rebuildCommand: "node tools/build-t0b-demo-package.mjs",
  }, null, 2)}
`);
  console.log(JSON.stringify({
    packageBytes: result.packageBytes.byteLength,
    packageMiB: Number((result.packageBytes.byteLength / 1024 / 1024).toFixed(2)),
    packageSha256: result.packageSha256,
    projectId: result.projectId,
    geometryRevisionId: result.geometryRevisionId,
    geometryAssetCount: result.geometryAssetCount,
    geometrySignature: built.geometrySignature,
    r2GeometrySignature: result.originalGeometrySignature,
    sourceCounts,
    carriedInterfaceCount: result.interfaceCount,
    unknownCount: result.unknownCount,
    assets: assets.map((asset) => ({ kind: asset.kind, fileName: asset.fileName, kiB: Math.round(asset.bytes.byteLength / 1024) })),
  }, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}
