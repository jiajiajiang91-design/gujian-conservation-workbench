import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@gujian/domain": fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url)),
      "@gujian/application": fileURLToPath(new URL("../../packages/application/src/index.ts", import.meta.url)),
      "@gujian/infrastructure": fileURLToPath(new URL("../../packages/infrastructure/src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
})
