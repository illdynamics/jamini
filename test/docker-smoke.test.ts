/**
 * Docker Smoke Test
 *
 * Builds the Docker image and verifies jamini works inside the container.
 * Skipped if docker is not available or image can't be built.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';

const IMAGE = 'jamini:test';

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function buildImage(): void {
  execSync(`docker build -t ${IMAGE} .`, {
    cwd: process.cwd(),
    stdio: 'pipe',
    timeout: 120_000,
  });
}

function runInContainer(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  const result = spawnSync(
    'docker',
    ['run', '--rm', ...envArgs, IMAGE, ...args],
    { encoding: 'utf-8', timeout: 60_000, maxBuffer: 10_000_000 },
  );
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? -1,
  };
}

function runInContainerWithEntrypoint(
  entrypoint: string,
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--entrypoint', entrypoint, ...envArgs, IMAGE, ...args],
    { encoding: 'utf-8', timeout: 60_000, maxBuffer: 10_000_000 },
  );
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? -1,
  };
}

// Only run if Docker is available
const RUN_TESTS = dockerAvailable();

describe.runIf(RUN_TESTS)('Docker Smoke Test', () => {
  beforeAll(() => {
    buildImage();
  }, 180_000);

  it('jamini --help works inside container', () => {
    const result = runInContainer(['jamini', '--help']);
    expect(result.stdout).toContain('Jamini');
    expect(result.stdout).toContain('v4-flash');
    expect(result.exitCode).toBe(0);
  });

  it('jamini --version works inside container', () => {
    const result = runInContainer(['jamini', '--version']);
    expect(result.stdout).toContain('jamini v');
    expect(result.exitCode).toBe(0);
  });

  it('jamini with DEEPSEEK_API_KEY exits cleanly (no Google auth attempt)', () => {
    const result = runInContainer(
      ['jamini', '--version'],
      { DEEPSEEK_API_KEY: 'sk-test-key' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('Google');
    expect(result.stderr).not.toContain('OAuth');
  });

  it('gemini CLI is available inside container', () => {
    const result = runInContainer(['gemini', '--version']);
    expect(result.exitCode).toBe(0);
  });

  it('bridge scripts are present', () => {
    // --entrypoint ls overrides the image ENTRYPOINT so we can
    // check for file existence without invoking the Jamini CLI
    const result = runInContainerWithEntrypoint('ls', ['/opt/jamini/bridge/dist/server.js']);
    expect(result.exitCode).toBe(0);
  });

  it('model catalog is present', () => {
    // --entrypoint cat overrides the image ENTRYPOINT so we can
    // check the catalog contents without invoking the Jamini CLI
    const result = runInContainerWithEntrypoint('cat', ['/opt/jamini/config/model-catalog.json']);
    expect(result.stdout).toContain('v4-flash');
    expect(result.stdout).toContain('v4-pro');
    expect(result.exitCode).toBe(0);
  });
});

