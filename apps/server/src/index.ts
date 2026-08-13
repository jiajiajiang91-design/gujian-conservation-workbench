import { createServer } from "node:http"

const host = "127.0.0.1"
const port = Number.parseInt(process.env.GUJIAN_SERVER_PORT ?? "8787", 10)
const allowedOrigin = process.env.GUJIAN_ALLOWED_ORIGIN ?? "http://127.0.0.1:5173"

function writeJson(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(JSON.stringify(payload))
}

export function createWorkbenchServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`)
    if (request.headers.origin && request.headers.origin !== allowedOrigin) {
      return writeJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" })
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return writeJson(response, 200, {
        service: "gujian-workbench-server",
        ready: true,
        model: "kimi-k2.6",
        modelConfigured: Boolean(process.env.KIMI_API_KEY),
        projectStorage: "browser-indexeddb-v3",
      })
    }
    return writeJson(response, 404, { error: "NOT_FOUND" })
  })
}

if (process.env.NODE_ENV !== "test") {
  const server = createWorkbenchServer()
  server.listen(port, host, () => {
    console.log(`古建保护成果工作台服务：http://${host}:${port}`)
  })
  const close = () => server.close(() => process.exit(0))
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
}
