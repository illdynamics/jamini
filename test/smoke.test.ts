/**
 * End-to-end Smoke Test
 *
 * Starts the bridge in background, verifies endpoints, kills the bridge, verifies cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

const BRIDGE_SCRIPT = join(process.cwd(), 'bridge/dist/server.js');

let bridgeProcess: ChildProcess | null = null;
let bridgeBaseUrl = '';
let mockServer: Server | null = null;
let mockDeepSeekBaseUrl = '';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('Failed to bind'));
      }
    });
    srv.on('error', reject);
  });
}

async function waitForReady(url: string, path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}${path}`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server at ${url} not ready after ${timeoutMs}ms`);
}

function startMockDeepSeek(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise(async (resolve, reject) => {
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'smoke-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({ server, baseUrl });
    });
    server.on('error', reject);
  });
}

describe('Jamini Smoke Test', () => {
  beforeAll(async () => {
    const mock = await startMockDeepSeek();
    mockServer = mock.server;
    mockDeepSeekBaseUrl = mock.baseUrl;

    // Start bridge
    const port = await findFreePort();
    bridgeBaseUrl = `http://127.0.0.1:${port}`;

    bridgeProcess = spawn('node', [BRIDGE_SCRIPT], {
      env: {
        ...process.env,
        JAMINI_BRIDGE_PORT: String(port),
        JAMINI_BRIDGE_AUTO_START: "1",
        JAMINI_BRIDGE_HOST: '127.0.0.1',
        JAMINI_BRIDGE_LOCAL_API_KEY: 'smoke-test-key',
        DEEPSEEK_API_KEY: 'sk-smoke-test',
        DEEPSEEK_API_BASE: mockDeepSeekBaseUrl,
        JAMINI_MODEL: 'v4-flash',
        JAMINI_REQUEST_MAX_RETRIES: '0',
        BRAVE_API_KEY: '',
        UNSTRUCTURED_API_KEY: '',
      },
      stdio: 'pipe',
    });

    bridgeProcess.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) process.stderr.write(`[smoke-bridge] ${msg}\n`);
    });

    await waitForReady(bridgeBaseUrl, '/readyz');
  }, 15_000);

  afterAll(() => {
    if (bridgeProcess && !bridgeProcess.killed) {
      bridgeProcess.kill('SIGTERM');
    }
    if (mockServer) {
      mockServer.close();
    }
  });

  it('bridge /health responds', async () => {
    const res = await fetch(`${bridgeBaseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('up');
  });

  it('bridge /readyz responds', async () => {
    const res = await fetch(`${bridgeBaseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
  });

  it('bridge /v1beta/models returns 4 models', async () => {
    const res = await fetch(`${bridgeBaseUrl}/v1beta/models`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toHaveLength(4);
  });

  it('bridge handles a simple generateContent', async () => {
    const res = await fetch(`${bridgeBaseUrl}/v1beta/models/v4-flash:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer smoke-test-key',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hello smoke test' }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toBeDefined();
    expect(body.candidates[0].content.role).toBe('model');
  });

  it('bridge cleanup: old PID is gone after kill', async () => {
    // Kill the bridge
    if (bridgeProcess && !bridgeProcess.killed) {
      bridgeProcess.kill('SIGTERM');
      // Wait for exit
      await new Promise<void>((resolve) => {
        if (!bridgeProcess) { resolve(); return; }
        bridgeProcess.on('exit', () => resolve());
        setTimeout(() => resolve(), 2000);
      });
    }

    // Verify bridge is dead — the next request should fail
    let bridgeDead = false;
    try {
      await fetch(`${bridgeBaseUrl}/health`);
    } catch {
      bridgeDead = true;
    }
    expect(bridgeDead).toBe(true);

    // Null out so afterAll doesn't double-kill
    bridgeProcess = null;
  });
});

