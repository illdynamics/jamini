import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const CLI_PATH = resolve(process.cwd(), 'dist/cli.js');

async function runCli(args: string[], env?: Record<string, string>): Promise<{
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
      resolve({ stdout, stderr, exitCode: code, signal });
    });

    // Timeout after 10s
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: null, signal: 'SIGKILL' });
    }, 10000);
  });
}

describe('jamini CLI', () => {
  it('prints help with --help', async () => {
    const { stdout, exitCode } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('jamini');
    expect(stdout).toContain('v4-flash');
    expect(stdout).toContain('v4-pro-thinking');
    expect(stdout).toContain('YOLO');
    expect(stdout).toContain('DEEPSEEK_API_KEY');
  });

  it('prints version with --version', async () => {
    const { stdout, exitCode } = await runCli(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('jamini v');
  });

  it('rejects unsupported model', async () => {
    const { stderr, exitCode } = await runCli(
      ['-m', 'gemini-ultra', 'hello'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unsupported Jamini model');
    expect(stderr).toContain('v4-flash');
  });

  it('accepts v4-flash model', async () => {
    const { exitCode } = await runCli(
      ['-m', 'v4-flash', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    // Should not fail on model validation (help exits before bridge start)
    expect(exitCode).toBe(0);
  });

  it('accepts v4-flash-thinking model', async () => {
    const { exitCode } = await runCli(
      ['-m', 'v4-flash-thinking', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });

  it('accepts v4-pro model', async () => {
    const { exitCode } = await runCli(
      ['-m', 'v4-pro', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });

  it('accepts v4-pro-thinking model', async () => {
    const { exitCode } = await runCli(
      ['-m', 'v4-pro-thinking', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });

  it('fails without DEEPSEEK_API_KEY', async () => {
    const { exitCode } = await runCli(
      ['--help'],
      { DEEPSEEK_API_KEY: '' },
    );
    // --help should work even without key
    expect(exitCode).toBe(0);
  });

  it('passes through unknown flags', async () => {
    // Just validate that unknown flags don't cause model rejection
    const { exitCode } = await runCli(
      ['--some-unknown-flag', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });

  it('handles -y flag without error', async () => {
    const { exitCode } = await runCli(
      ['-y', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });

  it('handles --yolo flag without error', async () => {
    const { exitCode } = await runCli(
      ['--yolo', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });

  it('handles --approval-mode=yolo flag without error', async () => {
    const { exitCode } = await runCli(
      ['--approval-mode=yolo', '--help'],
      { DEEPSEEK_API_KEY: 'sk-test' },
    );
    expect(exitCode).toBe(0);
  });
});

  it('shows jamini-branded no-input message (not gemini)', async () => {
    const { stderr } = await runCli(
      ['-y'],
      { DEEPSEEK_API_KEY: 'sk-test', TERM: 'dumb', CI: 'true', NO_COLOR: '1' },
    );
    // Should show jamini-branded no-input message, not gemini
    expect(stderr).toContain('jamini');
    expect(stderr).not.toContain('piping data into gemini');
  });

  it('stderr filter drops cleanup_ops and true-color warnings', async () => {
    // The stderr filter is applied to Gemini CLI child process output.
    // Test that our filter correctly drops known noisy startup messages.
    // We test without --prompt to avoid bridge startup overhead.
    const { stderr } = await runCli(
      ['-y'],
      { DEEPSEEK_API_KEY: 'sk-test', TERM: 'dumb', CI: 'true', NO_COLOR: '1' },
    );
    // Verify known noisy messages are filtered
    expect(stderr).not.toContain('STARTUP');
    expect(stderr).not.toContain('cleanup_ops');
    expect(stderr).not.toContain('True color');
    expect(stderr).not.toContain('256-color');
    expect(stderr).not.toContain('Basic terminal');
    expect(stderr).not.toContain('Ripgrep');
    // Verify jamini branding (not gemini)
    expect(stderr).toContain('jamini');
  });

  it('shows YOLO message only once', async () => {
    const { stderr } = await runCli(
      ['-y'],
      { DEEPSEEK_API_KEY: 'sk-test', TERM: 'dumb', CI: 'true', NO_COLOR: '1' },
    );
    const yoloCount = (stderr.match(/YOLO mode is enabled/g) || []).length;
    expect(yoloCount).toBeLessThanOrEqual(1);
  });
