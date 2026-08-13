import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { App } from "./App"

describe("App", () => {
  it("显示项目档案台与服务端密钥边界", () => {
    render(<App />)
    expect(screen.getByRole("heading", { name: /古建保护/ })).toBeInTheDocument()
    expect(screen.getByText("密钥不进入浏览器")).toBeInTheDocument()
  })
})
