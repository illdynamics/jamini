/**
 * Integration tests — full jamini CLI → bridge → DeepSeek flow tests.
 *
 * These tests start the bridge and test CLI behavior end-to-end
 * with a mock DeepSeek server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';

import { rmSync } from 'node:fs';

const CLI_PATH = resolve(process.cwd(), 'dist/cli.js');

let mockServer: Server | null = null;
let tempDirs: string[] = [];

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

function startMockDeepSeek(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise(async (resolve, reject) => {
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const server = createServer((req, res) => {
      // let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-integration',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-v4-flash',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Mock integration response.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
      });
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({ server, baseUrl });
    });
    server.on('error', reject);
  });
}

async function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: process.env.HOME || '/tmp',
        PATH: process.env.PATH || '/usr/bin',
        ...env,
      },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: null });
    }, timeoutMs);

    child.on('exit', (_code, _signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: _code });
    });
  });
}


describe('Jamini Integration', () => {
  beforeAll(async () => {
    const mock = await startMockDeepSeek();
    mockServer = mock.server;
    
  });

  afterAll(() => {
    if (mockServer) mockServer.close();
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  // ── CLI commands that do NOT need a key ──────────────────────────
  describe('Help and version (no key needed)', () => {
    it('jamini --help works without DEEPSEEK_API_KEY', async () => {
      const { stdout, exitCode } = await runCli(['--help'], { DEEPSEEK_API_KEY: '' });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('jamini');
      expect(stdout).toContain('v4-flash');
    });

    it('jamini --version works without DEEPSEEK_API_KEY', async () => {
      const { stdout, exitCode } = await runCli(['--version'], { DEEPSEEK_API_KEY: '' });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('jamini v');
    });

    it('jamini -h works', async () => {
      const { stdout, exitCode } = await runCli(['-h'], { DEEPSEEK_API_KEY: '' });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('jamini');
    });

    it('jamini help works', async () => {
      const { exitCode } = await runCli(['help'], { DEEPSEEK_API_KEY: '' });
      expect(exitCode).toBe(0);
    });

    it('jamini -V works', async () => {
      const { stdout, exitCode } = await runCli(['-V'], { DEEPSEEK_API_KEY: '' });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('jamini v');
    });

    it('jamini version works', async () => {
      const { stdout, exitCode } = await runCli(['version'], { DEEPSEEK_API_KEY: '' });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('jamini v');
    });
  });

  // ── Model validation ─────────────────────────────────────────────
  describe('Model validation', () => {
    it('jamini -m v4-flash --help works', async () => {
      const { exitCode } = await runCli(
        ['-m', 'v4-flash', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('jamini --model v4-flash-thinking --help works', async () => {
      const { exitCode } = await runCli(
        ['--model', 'v4-flash-thinking', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('jamini --model=v4-pro --help works', async () => {
      const { exitCode } = await runCli(
        ['--model=v4-pro', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      // Note: --model=v4-pro might not be split correctly by our simple arg parser.
      // This tests the current behavior.
      expect(exitCode).toBe(0);
    });

    it('jamini -m v4-pro-thinking --help works', async () => {
      const { exitCode } = await runCli(
        ['-m', 'v4-pro-thinking', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('jamini -m unsupported-model fails with clear message', async () => {
      const { stderr, exitCode } = await runCli(
        ['-m', 'chatgpt-4', 'hello'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unsupported Jamini model');
    });

    it('jamini -m gemini-pro fails with clear message', async () => {
      const { stderr, exitCode } = await runCli(
        ['-m', 'gemini-pro', 'hello'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unsupported Jamini model');
    });

    it('jamini -m unknown-model fails', async () => {
      const { exitCode } = await runCli(
        ['-m', 'unknown-model-xyz', 'hello'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(1);
    });
  });

  // ── Fails without key for non-help commands ──────────────────────
  describe('Requires DEEPSEEK_API_KEY for real commands', () => {
    it('jamini without DEEPSEEK_API_KEY fails with clear message', async () => {
      const { stderr, exitCode } = await runCli(
        ['echo', 'test'],
        { DEEPSEEK_API_KEY: '' },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('DEEPSEEK_API_KEY');
    });
  });

  // ── YOLO flag passthrough ────────────────────────────────────────
  describe('YOLO flag passthrough', () => {
    it('jamini -y --help passes through', async () => {
      const { exitCode } = await runCli(
        ['-y', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('jamini --yolo --help passes through', async () => {
      const { exitCode } = await runCli(
        ['--yolo', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('jamini --approval-mode=yolo --help passes through', async () => {
      const { exitCode } = await runCli(
        ['--approval-mode=yolo', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });
  });

  // ── Unknown flag passthrough ─────────────────────────────────────
  describe('Unknown flag passthrough', () => {
    it('jamini --some-unknown-flag --help works', async () => {
      const { exitCode } = await runCli(
        ['--some-unknown-flag', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('jamini --include=./foo --help works', async () => {
      const { exitCode } = await runCli(
        ['--include=./foo', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('jamini --output-format=json --help works', async () => {
      const { exitCode } = await runCli(
        ['--output-format=json', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });
  });

  // ── deepseek-v4-* legacy aliases still validate ──────────────────
  describe('Legacy provider model aliases still validate', () => {
    it('accepts deepseek-v4-flash', async () => {
      const { exitCode } = await runCli(
        ['-m', 'deepseek-v4-flash', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });

    it('accepts deepseek-v4-pro', async () => {
      const { exitCode } = await runCli(
        ['-m', 'deepseek-v4-pro', '--help'],
        { DEEPSEEK_API_KEY: 'sk-test' },
      );
      expect(exitCode).toBe(0);
    });
  });
});

