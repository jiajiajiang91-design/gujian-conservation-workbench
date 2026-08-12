import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

const node = process.execPath
const vite = spawn(
  node,
  ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'],
  {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  },
)

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:5174/')
      if (response.ok) return
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Vite test server did not become ready within 30 seconds.')
}

function stopServer() {
  if (vite.exitCode !== null || vite.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(-vite.pid, 'SIGTERM')
  }
}

let exitCode = 1
try {
  await waitForServer()
  exitCode = await new Promise((resolve, reject) => {
    const playwright = spawn(node, ['./node_modules/@playwright/test/cli.js', 'test'], {
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: '1' },
    })
    playwright.once('error', reject)
    playwright.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  stopServer()
}

process.exit(exitCode)
