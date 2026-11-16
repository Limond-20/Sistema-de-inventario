import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('No se pudo reservar un puerto para E2E.'));
      return;
    }
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});

const dataRoot = mkdtempSync(join(tmpdir(), 'abarrotes-e2e-'));
const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
process.once('exit', () => rmSync(dataRoot, { recursive: true, force: true }));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: `https://127.0.0.1:${port}`,
    browserName: 'chromium',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: [
      'python -m lansync',
      '--host 0.0.0.0',
      `--port ${port}`,
      '--static ../abarrotes-app/dist/abarrotes-app/browser',
      `--cert-dir ${quote(join(dataRoot, 'certs'))}`,
      `--data-dir ${quote(join(dataRoot, 'data'))}`,
      '--sin-usb',
    ].join(' '),
    cwd: '../local-server',
    url: `https://127.0.0.1:${port}/api/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});