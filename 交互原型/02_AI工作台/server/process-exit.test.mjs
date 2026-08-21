import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function waitForStatus(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return response.json();
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("本地服务未在限定时间内启动");
}

function waitForExit(child, timeoutMs = 5_000) {
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("本地服务未在限定时间内退出")), timeoutMs)),
  ]);
}

test("旧服务启动后可终止，不留占用端口的进程", { timeout: 15_000 }, async () => {
  const port = String(18_000 + Math.floor(Math.random() * 1_000));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const status = await waitForStatus(port);
    assert.equal(typeof status.configured, "boolean");
    child.kill("SIGTERM");
    const result = await waitForExit(child);
    assert.ok(result.code === 0 || result.signal === "SIGTERM", stderr);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
