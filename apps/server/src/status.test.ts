import { afterEach, describe, expect, it } from "vitest"

import { createWorkbenchServer } from "./index.js"

let closeCurrent: (() => Promise<void>) | undefined

afterEach(async () => {
  await closeCurrent?.()
  closeCurrent = undefined
})

describe("workbench server", () => {
  it("只在 loopback 地址提供无密钥状态", async () => {
    const server = createWorkbenchServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    closeCurrent = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("测试服务未启动")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/status`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      service: "gujian-workbench-server",
      model: "kimi-k2.6",
      projectStorage: "browser-indexeddb-v3",
    })
  })
})
