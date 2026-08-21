import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = "8796";
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: port },
  stdio: ["ignore", "pipe", "pipe"]
});
let errors = "";
server.stderr.on("data", chunk => { errors += chunk.toString("utf8"); });

async function waitUntilReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch { /* 等待服务启动 */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("本地服务未启动");
}

try {
  await waitUntilReady();
  const response = await fetch(`http://127.0.0.1:${port}/api/ai`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task_id: "service.health",
      messages: [{ role: "user", content: "Reply with exactly: OK" }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  console.log(JSON.stringify({
    ok: true,
    text: data.choices?.[0]?.message?.content || "",
    task: data.gujian_meta?.taskId,
    provider: data.gujian_meta?.provider,
    model: data.gujian_meta?.model,
    usage: data.gujian_meta?.usage,
    cost: data.gujian_meta?.cost
  }));
} catch (error) {
  if (errors.trim()) console.error(errors.trim().slice(0, 500));
  throw error;
} finally {
  server.kill("SIGTERM");
}
