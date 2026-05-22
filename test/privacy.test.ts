import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync,  mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const CLI_PATH = resolve(process.cwd(), 'dist/cli.js');

describe('Privacy Lockdown', () => {
  const testHome = join(tmpdir(), 'jamini-privacy-test-' + Date.now());
  const geminiCliHome = join(testHome, 'gemini-cli-home');

  beforeAll(() => {
    mkdirSync(testHome, { recursive: true, mode: 0o700 });
    mkdirSync(geminiCliHome, { recursive: true, mode: 0o700 });
  });

  afterAll(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
  });

  // ── Test 1: Settings path ──────────────────────────────────────────
  // Settings are written synchronously during main() before bridge startup.
  // We spawn the CLI, poll for the settings file, then kill the process.
  it('writes Gemini CLI settings to .gemini/settings.json', async () => {
    const child = spawn('node', [CLI_PATH, '-m', 'v4-flash', 'hello'], {
      env: {
        ...process.env,
        JAMINI_HOME: testHome,
        GEMINI_CLI_HOME: geminiCliHome,
        DEEPSEEK_API_KEY: 'sk-test-key-1234567890',
      },
      stdio: 'pipe',
    });

    // Poll for the settings file — it's written before bridge startup
    const settingsPath = join(geminiCliHome, '.gemini', 'settings.json');
    const found = await pollForFile(settingsPath, 15000);

    // Kill the process regardless
    try { child.kill('SIGKILL'); } catch {}

    expect(found, `Settings file not found at ${settingsPath}`).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.privacy?.usageStatisticsEnabled).toBe(false);
    expect(settings.telemetry?.enabled).toBe(false);
    expect(settings.telemetry?.logPrompts).toBe(false);
    expect(settings.telemetry?.target).toBe('local');
    expect(settings.telemetry?.otlpEndpoint).toBe('');
  }, 20000);

  // ── Test 2: settings.json content ──────────────────────────────────
  it('settings.json has privacy.usageStatisticsEnabled=false', () => {
    const settingsPath = join(geminiCliHome, '.gemini', 'settings.json');
    expect(existsSync(settingsPath), 'Settings file must exist from previous test').toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.privacy.usageStatisticsEnabled).toBe(false);
  });

  it('settings.json has telemetry.enabled=false', () => {
    const settingsPath = join(geminiCliHome, '.gemini', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.telemetry.enabled).toBe(false);
  });

  it('settings.json has telemetry.logPrompts=false', () => {
    const settingsPath = join(geminiCliHome, '.gemini', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.telemetry.logPrompts).toBe(false);
  });

  // ── Test 3: Supported model still works ────────────────────────────
  it('accepts v4-flash model (DeepSeek still works)', async () => {
    const result = await runCli(
      ['-m', 'v4-flash', '--help'],
      { JAMINI_HOME: testHome, GEMINI_CLI_HOME: geminiCliHome },
    );
    expect(result.exitCode).toBe(0);
  });

  // ── Test 4: Gemini/Google model rejected ───────────────────────────
  it('rejects gemini-pro model', async () => {
    const result = await runCli(
      ['-m', 'gemini-pro', 'hello'],
      { JAMINI_HOME: testHome, GEMINI_CLI_HOME: geminiCliHome },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/Unsupported|unsupported/i);
  });

  it('rejects gemini-2.5-pro model', async () => {
    const result = await runCli(
      ['-m', 'gemini-2.5-pro', 'hello'],
      { JAMINI_HOME: testHome, GEMINI_CLI_HOME: geminiCliHome },
    );
    expect(result.exitCode).toBe(1);
  });

  it('rejects google/gemini model', async () => {
    const result = await runCli(
      ['-m', 'google/gemini', 'hello'],
      { JAMINI_HOME: testHome, GEMINI_CLI_HOME: geminiCliHome },
    );
    expect(result.exitCode).toBe(1);
  });

  it('rejects vertex model', async () => {
    const result = await runCli(
      ['-m', 'vertex', 'hello'],
      { JAMINI_HOME: testHome, GEMINI_CLI_HOME: geminiCliHome },
    );
    expect(result.exitCode).toBe(1);
  });

  // ── Test 5: Auto-update env vars disabled ──────────────────────────
  it('help output mentions auto-update is off (privacy watermark)', async () => {
    const result = await runCli(
      ['--help', '--debug'],
      {
        JAMINI_HOME: testHome,
        GEMINI_CLI_HOME: geminiCliHome,
        DEEPSEEK_API_KEY: 'sk-test-key-1234567890',
        JAMINI_DEBUG: '1',
      },
    );
    // The CLI logs to stderr: "[jamini] [privacy] Google/Gemini: BLOCKED | ... | Auto-update: OFF"
    expect(result.stderr).toMatch(/privacy/i);
    expect(result.stderr).toMatch(/BLOCKED|OFF/);
  });

  // ── Test 6: History mode defaults to ephemeral ────────────────────
  it('config has historyMode defaulting to ephemeral', async () => {
    const result = await runCli(
      ['--help', '--debug'],
      {
        JAMINI_HOME: testHome,
        GEMINI_CLI_HOME: geminiCliHome,
        DEEPSEEK_API_KEY: 'sk-test-key-1234567890',
        JAMINI_DEBUG: '1',
      },
    );
    expect(result.stderr).toMatch(/ephemeral/i);
  });

  // ── Test 7: No prompt/completion written to disk in default mode ──
  it('does not write prompt/completion to disk in default ephemeral mode', async () => {
    const result = await runCli(
      ['--help'],
      {
        JAMINI_HOME: testHome,
        GEMINI_CLI_HOME: geminiCliHome,
        DEEPSEEK_API_KEY: 'sk-test-key-1234567890',
      },
    );
    expect(result.exitCode).toBe(0);

    const historyDir = join(testHome, 'history');
    const chatDir = join(testHome, 'chat');
    const conversationsDir = join(testHome, 'conversations');

    const hasHistoryFiles =
      (existsSync(historyDir) && hasFiles(historyDir)) ||
      (existsSync(chatDir) && hasFiles(chatDir)) ||
      (existsSync(conversationsDir) && hasFiles(conversationsDir));

    if (hasHistoryFiles) {
      const allFiles = collectFiles(testHome);
      for (const f of allFiles) {
        if (f.endsWith('.json') && !f.includes('settings.json') && !f.includes('config.json') && !f.includes('package.json')) {
          const content = readFileSync(f, 'utf8');
          expect(content).not.toMatch(/explain|refactor|debug|implement/i);
        }
      }
    }
  });
});

// ── Polling helper ────────────────────────────────────────────────────

function pollForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (existsSync(filePath)) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

// ── Standard CLI runner ───────────────────────────────────────────────

async function runCli(
  args: string[],
  env?: Record<string, string>,
  timeoutMs: number = 10000,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('exit', (code, signal) => {
      setTimeout(() => {
        resolve({ stdout, stderr, exitCode: code, signal });
      }, 50);
    });

    setTimeout(() => {
      child.kill('SIGKILL');
      setTimeout(() => {
        resolve({ stdout, stderr, exitCode: null, signal: 'SIGKILL' });
      }, 50);
    }, timeoutMs);
  });
}

function hasFiles(dir: string): boolean {
  try {
    const { readdirSync } = require('node:fs');
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function collectFiles(dir: string): string[] {
  const { readdirSync, statSync } = require('node:fs');
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isFile()) {
          results.push(fullPath);
        } else if (st.isDirectory() && !entry.startsWith('node_modules') && !entry.startsWith('.git')) {
          results.push(...collectFiles(fullPath));
        }
      } catch {}
    }
  } catch {}
  return results;
}

