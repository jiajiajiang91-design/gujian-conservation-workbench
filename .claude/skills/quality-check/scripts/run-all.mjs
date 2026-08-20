// 串起全部机器检查。用法：node .claude/skills/quality-check/scripts/run-all.mjs [--full]
// 默认跑静态检查与类型检查；--full 追加单元测试与演示矩阵，耗时数分钟。
// 退出码 0 表示全过，1 表示至少一步未过。

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const HERE = import.meta.dirname;
const FULL = process.argv.includes("--full");

const steps = [
  ["文档与引用", `node "${resolve(HERE, "check-docs.mjs")}"`],
  ["单元与状态", `node "${resolve(HERE, "check-state.mjs")}"`],
  ["类型", "npm run typecheck"],
];
if (FULL) {
  steps.push(["测试", "npm run test"]);
  steps.push(["演示矩阵", "node tools/check-demo-matrix.mjs"]);
}

const results = [];
for (const [name, cmd] of steps) {
  console.log(`\n${"=".repeat(50)}\n${name}\n${"=".repeat(50)}`);
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: "inherit" });
  results.push([name, r.status === 0]);
}

console.log(`\n${"=".repeat(50)}`);
for (const [name, ok] of results) console.log(`${ok ? "通过" : "未过"}  ${name}`);
if (!FULL) console.log("\n未跑测试与演示矩阵，收口前加 --full 再跑一次");
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
