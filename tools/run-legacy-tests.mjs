// 旧原型（交互原型/02_AI工作台）不在 pnpm workspace 里，它有自己的 package.json
// 与 package-lock.json，用 npm 装。纳入 workspace 试过：依赖解析变化会让它两条
// 测试失败，因此保持隔离。
//
// 这里先确认依赖装没装。不确认的话，全新克隆跑 pnpm check 会报
// ERR_MODULE_NOT_FOUND: @vitejs/plugin-react，看不出该做什么。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const legacy = resolve(root, "交互原型/02_AI工作台");

if (!existsSync(resolve(legacy, "node_modules"))) {
  console.error("旧原型的依赖没装，test:legacy 无法执行。");
  console.error("先跑：corepack pnpm run install:legacy");
  console.error("它用旧原型自己的 package-lock.json 装锁定版本，不走 pnpm workspace。");
  process.exit(1);
}

const result = spawnSync("npm", ["run", "test", "--prefix", legacy], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
