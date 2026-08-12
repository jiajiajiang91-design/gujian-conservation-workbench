import { defineConfig } from '@playwright/test'

const externallyManagedServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: externallyManagedServer
    ? undefined
    : {
        command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort',
        url: 'http://127.0.0.1:5174/',
        reuseExistingServer: false,
        timeout: 30_000,
      },
})
