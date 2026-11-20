import { defineConfig } from '@playwright/test';
// Each spec starts its own web/src/server.mjs on a free port (temp data, projects and relay folders) against app/dist:
// run `npm run web:build` first.
export default defineConfig({ testDir: './e2e', workers: 1, retries: 0, timeout: 300_000, reporter: [['line']],
  use: { viewport: { width: 1440, height: 900 },
    launchOptions: {
      // SQ_E2E_CHROMIUM: a preinstalled Chromium when the runner's own browser download is absent.
      ...(process.env.SQ_E2E_CHROMIUM ? { executablePath: process.env.SQ_E2E_CHROMIUM } : {}),
      // Every request goes to a server on this machine: never through an HTTP(S)_PROXY from the environment (on Linux,
      // Chromium honours it, and a proxy would reset the remote-access test's connections to this machine's address).
      args: ['--no-proxy-server'],
    } } });
