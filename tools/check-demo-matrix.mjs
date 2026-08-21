// 对已构建的演示包逐格核对 08 演示项目定义表 3。
// 判定规则在 packages/infrastructure/src/demo-library/demo-matrix.ts，
// 这里只负责读包与排版，因为包有几十兆，不适合放进单元测试。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync } from "../packages/infrastructure/node_modules/fflate/esm/browser.js";
import { DEMO_MATRIX_STEPS, evaluateDemoMatrix } from "../packages/infrastructure/dist/index.js";
const names = ["t0b-construction-sample", "dai-loy-habs-ca-2071-w", "gaodu-yuhuang-temple-main-hall"];
const rows = [];
for (const name of names) {
  const zip = unzipSync(new Uint8Array(await readFile(resolve(import.meta.dirname, "..", `apps/workbench/public/demo/${name}.gujian.zip`))));
  rows.push([name, evaluateDemoMatrix(JSON.parse(new TextDecoder().decode(zip["project.json"])))]);
}
const pad = (text, width) => text + " ".repeat(Math.max(0, width - [...text].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0)));
console.log(pad("步骤 视图", 20) + names.map((n) => pad(n.slice(0, 14), 16)).join(""));
DEMO_MATRIX_STEPS.forEach((step, index) => {
  console.log(pad(`${step.stepZh} ${step.viewZh}`, 20)
    + rows.map(([, cells]) => pad(cells[index].filled ? `有 ${Object.values(cells[index].counts).reduce((a, b) => a + b, 0)}` : "空", 16)).join(""));
});
for (const [name, cells] of rows) {
  const empty = cells.filter((c) => !c.filled).map((c) => c.viewZh);
  console.log(`${name}: ${empty.length ? `空 ${empty.join("、")}` : "七格全满"}`);
}
