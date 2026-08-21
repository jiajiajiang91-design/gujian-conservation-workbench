import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
// 令牌与基础组件先于页面样式加载（07 第 5 节：先建组件再拼页面）
import "./tokens.css"
import "./components.css"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
