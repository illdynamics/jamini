/**
 * Real Gemini CLI Integration Test
 *
 * Starts a mock DeepSeek server, runs jamini with real Gemini CLI,
 * and asserts the full end-to-end flow works without Google auth.
 *
 * Skip if JAMINI_RUN_REAL_GEMINI_TESTS is not set to '1'.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const JAMINI_CLI = resolve(process.cwd(), 'dist/cli.js');
const RUN_TESTS = process.env.JAMINI_RUN_REAL_GEMINI_TESTS === '1';

let mockServer: ReturnType<typeof createServer>;
let mockPort = 0;
let mockBaseUrl = '';
let receivedRequests: { method: string; url: string; body: string }[] = [];

function startMockDeepSeek(): Promise<void> {
  return new Promise((resolve, reject) => {
    mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        receivedRequests.push({ method: req.method || '', url: req.url || '', body });
        
        if (req.url === '/chat/completions') {
          // Simulate a streaming DeepSeek response
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const chunks = [
            JSON.stringify({
              id: 'mock-1',
              object: 'chat.completion.chunk',
              created: Date.now(),
              model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: { content: 'Hello from ' }, finish_reason: null }],
            }),
            JSON.stringify({
              id: 'mock-2',
              object: 'chat.completion.chunk',
              created: Date.now(),
              model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: { content: 'mock DeepSeek!' }, finish_reason: null }],
            }),
            JSON.stringify({
              id: 'mock-3',
              object: 'chat.completion.chunk',
              created: Date.now(),
              model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }),
          ];
          for (const c of chunks) {
            res.write(`data: ${c}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(404);
          res.end('{}');
        }
      });
    });

    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address();
      if (addr && typeof addr === 'object') {
        mockPort = addr.port;
        mockBaseUrl = `http://127.0.0.1:${mockPort}`;
        resolve();
      } else {
        reject(new Error('Failed to get mock server port'));
      }
    });
    mockServer.on('error', reject);
  });
}

function stopMockDeepSeek(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) mockServer.close(() => resolve());
    else resolve();
  });
}

function runJamini(args: string[], env: Record<string, string>, timeoutMs = 30000): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolve) => {
    const child = spawn('node', [JAMINI_CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ stdout, stderr, exitCode: null });
      }
    }, timeoutMs);

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: -1 });
      }
    });
  });
}

describe.runIf(RUN_TESTS)('Real Gemini CLI E2E', () => {
  let tempHome: string;

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'jamini-e2e-'));
    await startMockDeepSeek();
  }, 15000);

  afterAll(async () => {
    await stopMockDeepSeek();
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  it('jamini with real Gemini CLI routes through mock DeepSeek', async () => {
    const env = {
      HOME: tempHome,
      JAMINI_HOME: join(tempHome, '.jamini'),
      DEEPSEEK_API_KEY: 'sk-test-mock-key',
      DEEPSEEK_BASE_URL: mockBaseUrl,
      JAMINI_BRIDGE_MODE: 'process',
      JAMINI_TRANSLATOR_MODE: 'custom',
      JAMINI_GEMINI_BIN: '/opt/homebrew/bin/gemini',
      JAMINI_BRIDGE_PORT: '',
      JAMINI_DEBUG: '1',
    };

    const result = await runJamini(
      ['-m', 'v4-flash', '-p', 'say hi', '--output-format', 'text'],
      env,
      45000,
    );

    // Assertions
    // 1. No Google auth
    expect(result.stderr).not.toContain('accounts.google.com');
    expect(result.stderr).not.toContain('OAuth');
    
    // 2. Mock DeepSeek received request
    const chatRequests = receivedRequests.filter(r => r.url === '/chat/completions');
    expect(chatRequests.length).toBeGreaterThan(0);
    expect(chatRequests[0].body).toContain('say hi');
    
    // 3. Response contains mock output  
    expect(result.stdout + result.stderr).toMatch(/mock DeepSeek|Hello from/i);
    
    // 4. No SSE SyntaxError
    expect(result.stderr).not.toContain('SyntaxError');
    expect(result.stderr).not.toContain('[DONE]');
  }, 60000);
});
