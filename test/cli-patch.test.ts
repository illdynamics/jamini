/**
 * Additional CLI tests for new Jamini features.
 * These are in a separate file to avoid modifying the original test structure.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const CLI_PATH = resolve(process.cwd(), 'dist/cli.js');

async function runCli(
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 8_000,
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

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: null, signal: 'SIGKILL' });
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, signal });
    });
  });
}

describe('jamini CLI — advanced features', () => {
  it('rejects litellm translator mode early', async () => {
    // This must NOT use --help (which exits before translator check)
    const { stderr, exitCode } = await runCli(
      ['-m', 'v4-flash', 'hello'],
      {
        DEEPSEEK_API_KEY: 'sk-test',
        JAMINI_TRANSLATOR_MODE: 'litellm',
      },
      6_000,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not yet implemented');
  });

  it('accepts --model=v4-flash syntax', async () => {
    const { exitCode } = await runCli(
      ['--model=v4-flash', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });

  it('rejects --model=invalid', async () => {
    const { stderr, exitCode } = await runCli(
      ['--model=gemini-ultra', 'hello'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unsupported Jamini model');
  });

  it('fails with clear error on external mode unreachable bridge', async () => {
    const { stderr, exitCode } = await runCli(
      ['-m', 'v4-flash', 'hello'],
      {
        DEEPSEEK_API_KEY: 'sk-test',
        JAMINI_BRIDGE_MODE: 'external',
        JAMINI_BRIDGE_URL: 'http://127.0.0.1:19999',
      },
      6_000,
    );
    expect(exitCode).toBe(1);
    expect(stderr.toLowerCase()).toMatch(/unreachable|connection refused/i);
  });

  it('help shows bridge and translator mode info', async () => {
    const { stdout, exitCode } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Bridge Modes');
    expect(stdout).toContain('Translator Modes');
    expect(stdout).toContain('JAMINI_BRIDGE_MODE');
    expect(stdout).toContain('JAMINI_TRANSLATOR_MODE');
  });

  it('help shows default model from JAMINI_MODEL env', async () => {
    const { stdout, exitCode } = await runCli(
      ['--help'],
      { JAMINI_MODEL: 'v4-pro', DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('v4-pro');
  });
});

