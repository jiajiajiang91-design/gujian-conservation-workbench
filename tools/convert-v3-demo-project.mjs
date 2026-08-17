import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildDemoProjectPackage } from "../packages/infrastructure/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v3-outputs/r2-geometry");
const output = resolve(root, "apps/server/.data/acceptance/milestone-three/third-project");
const [manifestText, sourceMeshes, glb] = await Promise.all([
  readFile(resolve(source, "geometry-manifest.json"), "utf8"),
  readFile(resolve(source, "source-meshes.ndjson.gz")),
  readFile(resolve(source, "local-construction-sample.glb")),
]);
const manifest = JSON.parse(manifestText);
const result = buildDemoProjectPackage({
  manifest,
  createdAt: "2026-08-14T12:00:00Z",
  projectName: "团队演示构造项目（跨项目泛化）",
  buildingName: "团队演示构造样本",
  fixtureId: "v3-r2-proportioned-team-demo-2026-08-14",
  sourceFiles: [
    { fileName: "v3-geometry-manifest.json", mimeType: "application/json", bytes: new TextEncoder().encode(manifestText), evidenceType: "document", title: "示例构件清单" },
    { fileName: "v3-source-meshes.ndjson.gz", mimeType: "application/gzip", bytes: sourceMeshes, evidenceType: "other", title: "示例三维网格数据" },
    { fileName: "v3-local-construction-sample.glb", mimeType: "model/gltf-binary", bytes: glb, evidenceType: "other", title: "示例三维模型" },
  ],
});
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "third-project-input.gujian.zip"), result.packageBytes);
await writeFile(resolve(output, "third-project-input-summary.json"), `${JSON.stringify({
  schemaVersion: "third-project-input-summary-1",
  ...result,
  packageBytes: undefined,
  status: "generated-not-qualified",
  l1Eligible: false,
  formalEligibility: false,
  restrictions: ["团队 demo", "未签发", "不可用于正式交付或施工", "参数化包络不等于原网格曲面"],
}, null, 2)}\n`);
console.log(JSON.stringify({ ...result, packageBytes: undefined }, null, 2));
