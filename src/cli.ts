#!/usr/bin/env node

/**
 * Jamini CLI — drop-in Gemini CLI replacement routing to DeepSeek V4.
 *
 * Usage:
 *   jamini [same flags and args as gemini]
 *
 * Bridge modes (JAMINI_BRIDGE_MODE):
 *   auto      – try process, fall back to container if runtime available
 *   process   – start bridge as local child process (default path)
 *   external  – use JAMINI_BRIDGE_URL, don't start/stop anything
 *   container – start bridge in Docker/Podman
 *
 * Translator modes (JAMINI_TRANSLATOR_MODE):
 *   auto    – use custom bridge
 *   custom  – Jamini TypeScript Gemini→DeepSeek bridge
 */

import { spawn, execSync, spawnSync, type ChildProcess } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  createWriteStream,
  type WriteStream,

  unlinkSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';

import dotenv from 'dotenv';
import { loadConfig, updateConfig, type JaminiConfig, type BridgeMode, type TranslatorMode } from './config.js';
import { filterStderrLine } from './stderr-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Debug & logging ────────────────────────────────────────────────

const DEBUG = process.env.JAMINI_DEBUG === '1' || process.argv.includes('--debug');
let logStream: WriteStream | null = null;

// ── Logging redaction ──────────────────────────────────────────────
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED:API_KEY]'],
  [/(?:DEEPSEEK_API_KEY|GEMINI_API_KEY|BRAVE_API_KEY|UNSTRUCTURED_API_KEY|JAMINI_BRIDGE_LOCAL_API_KEY)=([^\s,;]+)/gi, '$1=[REDACTED]'],
  [/Bearer\s+\S+/gi, 'Bearer [REDACTED]'],
];

function redactLog(input: string): string {
  let out = input;
  // Redact API key values
  for (const [regex, replacement] of REDACT_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  // Redact the DEEPSEEK_API_KEY env var value specifically
  const dsk = process.env.DEEPSEEK_API_KEY;
  if (dsk && dsk.length > 4) {
    out = out.split(dsk).join('[REDACTED:DEEPSEEK_API_KEY]');
  }
  const bak = process.env.BRAVE_API_KEY;
  if (bak && bak.length > 4) {
    out = out.split(bak).join('[REDACTED:BRAVE_API_KEY]');
  }
  const uak = process.env.UNSTRUCTURED_API_KEY;
  if (uak && uak.length > 4) {
    out = out.split(uak).join('[REDACTED:UNSTRUCTURED_API_KEY]');
  }
  const blk = BRIDGE_LOCAL_API_KEY;
  if (blk && blk.length > 4) {
    out = out.split(blk).join('[REDACTED:BRIDGE_LOCAL_API_KEY]');
  }
  return out;
}


function logFile(msg: string): void {
  try {
    if (!logStream) {
      const logDir = join(getJaminiHome(), 'log');
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      logStream = createWriteStream(join(logDir, 'jamini.log'), { flags: 'a', mode: 0o600 });
    }
    const ts = new Date().toISOString();
    logStream.write(`[${ts}] ${redactLog(msg)}\n`);
  } catch {
    // silently ignore log failures
  }
}

function log(...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const redacted = redactLog(msg);
  if (DEBUG) console.error('[jamini]', redacted);
  logFile('[debug] ' + redacted);
}

function warn(...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const redacted = redactLog(msg);
  console.error('[jamini:warn]', redacted);
  logFile('[warn] ' + redacted);
}

function die(...args: unknown[]): never {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const redacted = redactLog(msg);
  console.error('[jamini:error]', redacted);
  logFile('[error] ' + redacted);
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === 'jamini') return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const candidate = resolve(__dirname, '..');
  if (existsSync(join(candidate, 'bridge', 'dist', 'server.js'))) return candidate;
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();
const BRIDGE_SCRIPT = join(REPO_ROOT, 'bridge', 'dist', 'server.js');

function getJaminiHome(): string {
  return process.env.JAMINI_HOME || join(homedir(), '.jamini');
}

const JAMINI_HOME = getJaminiHome();
const GEMINI_CLI_HOME = process.env.GEMINI_CLI_HOME || join(JAMINI_HOME, 'gemini-cli-home');

function getLocalProxyKey(): string {
  // Use env override if set, otherwise generate a random key
  if (process.env.JAMINI_LOCAL_PROXY_KEY) return process.env.JAMINI_LOCAL_PROXY_KEY;
  if (process.env.JAMINI_BRIDGE_LOCAL_API_KEY) return process.env.JAMINI_BRIDGE_LOCAL_API_KEY;
  // Generate a stable key once per JAMINI_HOME
  const keyFile = join(JAMINI_HOME, 'run', '.local-proxy-key');
  try {
    if (existsSync(keyFile)) {
      return readFileSync(keyFile, 'utf8').trim();
    }
  } catch {}
  const key = crypto.randomUUID();
  try {
    mkdirSync(join(JAMINI_HOME, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, key + '\n', { mode: 0o600 });
  } catch {}
  return key;
}

const BRIDGE_LOCAL_API_KEY = getLocalProxyKey();
let bridgePort = 0;

// ── Key checks ──────────────────────────────────────────────────────

function ensureApiKey(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    die('DEEPSEEK_API_KEY is required.\n  export DEEPSEEK_API_KEY="sk-..."');
  }
}

function isHelpOrVersion(args: string[]): boolean {
  return args.some((a) => a === '--help' || a === '-h' || a === 'help' ||
    a === '--version' || a === '-V' || a === 'version');
}

// ── Directory setup ─────────────────────────────────────────────────

function ensureJaminiDirs(): void {
  const dirs = [
    join(JAMINI_HOME, 'run'),
    join(JAMINI_HOME, 'log'),
    GEMINI_CLI_HOME,
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

// ── PID file management ─────────────────────────────────────────────

function pidFilePath(): string {
  return join(JAMINI_HOME, 'run', 'bridge.pid');
}

function writePidFile(pid: number): void {
  try {
    writeFileSync(pidFilePath(), String(pid) + '\n', { mode: 0o600 });
    log('PID file written', pidFilePath(), 'pid=', pid);
  } catch (err) {
    warn('Failed to write PID file:', err);
  }
}

function readStalePidFile(): number | null {
  const path = pidFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      unlinkSync(path);
      return null;
    }
    // Check if process is still alive
    try {
      // Sending signal 0 tests existence without actually sending
      process.kill(pid, 0);
      return pid; // process exists
    } catch {
      // Process doesn't exist — stale PID
      log('Removing stale PID file, pid', pid, 'no longer exists');
      unlinkSync(path);
      return null;
    }
  } catch {
    return null;
  }
}

function removePidFile(): void {
  try {
    const path = pidFilePath();
    if (existsSync(path)) unlinkSync(path);
    log('PID file removed');
  } catch {}
}

// ── Gemini CLI settings ─────────────────────────────────────────────

function writeGeminiSettings(cfg: JaminiConfig): void {
  const settingsDir = join(GEMINI_CLI_HOME, '.gemini');
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 });

  const settingsPath = join(settingsDir, 'settings.json');
  const settings = {
    model: { name: cfg.defaultModel },
    security: {
      auth: {
        selectedType: 'gemini-api-key',
        enforcedType: 'gemini-api-key',
      },
    },
    general: { defaultApprovalMode: 'default' },
    privacy: { usageStatisticsEnabled: false },
    telemetry: {
      enabled: false,
      logPrompts: false,
      target: 'local',
      otlpEndpoint: '',
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  log('Gemini settings written to', settingsPath);
}

function buildGeminiEnv(bridgeUrl: string, cfg: JaminiConfig): Record<string, string> {
  const safeEnv: Record<string, string> = {};

  // Minimal runtime
  safeEnv.HOME = process.env.HOME || homedir();
  safeEnv.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  safeEnv.LANG = process.env.LANG || 'en_US.UTF-8';
  safeEnv.TERM = process.env.TERM || 'xterm-256color';
  safeEnv.SHELL = process.env.SHELL || '/bin/bash';
  safeEnv.USER = process.env.USER || '';
  safeEnv.TMPDIR = process.env.TMPDIR || '/tmp';

  // Jamini bridge routing
  safeEnv.GEMINI_CLI_HOME = GEMINI_CLI_HOME;
  safeEnv.GEMINI_API_KEY = BRIDGE_LOCAL_API_KEY;
  safeEnv.GOOGLE_GEMINI_BASE_URL = bridgeUrl;
  safeEnv.GOOGLE_GENAI_API_VERSION = 'v1beta';

  // Force-disable all Google/Gemini/Vertex auth paths
  safeEnv.GOOGLE_APPLICATION_CREDENTIALS = '';
  safeEnv.GOOGLE_CLOUD_PROJECT = '';
  safeEnv.GOOGLE_CLOUD_LOCATION = '';
  safeEnv.GOOGLE_GENAI_USE_VERTEXAI = 'false';

  // Gemini CLI trust workspace
  safeEnv.GEMINI_CLI_TRUST_WORKSPACE = 'true';

  // Telemetry: FORCE DISABLE ALL
  safeEnv.GEMINI_TELEMETRY_ENABLED = 'false';
  safeEnv.GEMINI_TELEMETRY_LOG_PROMPTS = 'false';
  safeEnv.GEMINI_TELEMETRY_USE_COLLECTOR = 'false';
  safeEnv.GEMINI_TELEMETRY_USE_CLI_AUTH = 'false';
  safeEnv.GEMINI_TELEMETRY_OTLP_ENDPOINT = '';
  safeEnv.GEMINI_TELEMETRY_TARGET = 'local';

  // OpenTelemetry: FORCE DISABLE ALL
  safeEnv.OTEL_SDK_DISABLED = 'true';
  safeEnv.OTEL_TRACES_EXPORTER = 'none';
  safeEnv.OTEL_METRICS_EXPORTER = 'none';
  safeEnv.OTEL_LOGS_EXPORTER = 'none';
  safeEnv.OTEL_EXPORTER_OTLP_ENDPOINT = '';
  safeEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = '';
  safeEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = '';
  safeEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = '';
  safeEnv.OTEL_SERVICE_NAME = '';
  safeEnv.OTEL_RESOURCE_ATTRIBUTES = '';

  // No auto-update
  safeEnv.NO_UPDATE_NOTIFIER = '1';
  safeEnv.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  safeEnv.NPM_CONFIG_AUDIT = 'false';
  safeEnv.NPM_CONFIG_FUND = 'false';

  // Pass through Jamini config to bridge
  safeEnv.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
  safeEnv.DEEPSEEK_BASE_URL = cfg.deepseekBaseUrl;
  safeEnv.JAMINI_BRIDGE_LOCAL_API_KEY = BRIDGE_LOCAL_API_KEY;
  safeEnv.JAMINI_BRIDGE_PORT = String(bridgePort);
  safeEnv.JAMINI_BRIDGE_HOST = '127.0.0.1';
  safeEnv.JAMINI_BRIDGE_AUTO_START = '1';
  safeEnv.JAMINI_MODEL = process.env.JAMINI_MODEL || cfg.defaultModel;
  safeEnv.JAMINI_THINKING = process.env.JAMINI_THINKING || '';
  safeEnv.JAMINI_REASONING_EFFORT = process.env.JAMINI_REASONING_EFFORT || 'high';
  safeEnv.JAMINI_SYSTEM_PROMPT = process.env.JAMINI_SYSTEM_PROMPT || cfg.systemPrompt || '';
  // Only pass Brave/Unstructured if explicitly on
  safeEnv.BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
  safeEnv.UNSTRUCTURED_API_KEY = process.env.UNSTRUCTURED_API_KEY || '';

  // Additional privacy blocks for analytics/tracking SDKs
  safeEnv.SENTRY_DSN = '';
  safeEnv.DD_API_KEY = '';
  safeEnv.DD_APP_KEY = '';
  safeEnv.NEW_RELIC_LICENSE_KEY = '';
  safeEnv.POSTHOG_API_KEY = '';
  safeEnv.SEGMENT_WRITE_KEY = '';
  safeEnv.AMPLITUDE_API_KEY = '';
  safeEnv.MIXPANEL_TOKEN = '';
  safeEnv.BUGSNAG_API_KEY = '';
  safeEnv.ROLLBAR_ACCESS_TOKEN = '';

  return safeEnv;
}

// ── Bridge management — port selection ──────────────────────────────

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('Failed to bind'));
      }
    });
    server.on('error', reject);
  });
}

// ── Health check ───────────────────────────────────────────────────

async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { log('Bridge is ready at', url); return; }
      lastErr = `HTTP ${res.status}`;
    } catch (err: unknown) {
      lastErr = String(err) || String(err);
    }
    await sleep(200);
  }
  die('Bridge failed to become ready within', timeoutMs, 'ms. Last error:', lastErr);
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Bridge management — process mode ────────────────────────────────

let bridgeProcess: ChildProcess | null = null;

async function startProcessBridge(cfg: JaminiConfig): Promise<string> {
  bridgePort = parseInt(process.env.JAMINI_BRIDGE_PORT || '0', 10) || await findFreePort();
  const url = `http://127.0.0.1:${bridgePort}`;
  log('Starting process bridge on', url);

  // Open bridge log file
  const logDir = join(JAMINI_HOME, 'log');
  const bridgeLogPath = join(logDir, 'bridge.log');
  const bridgeLogStream = createWriteStream(bridgeLogPath, { flags: 'a', mode: 0o600 });

  const bridgeEnv: Record<string, string> = {
    HOME: process.env.HOME || homedir(),
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: process.env.TERM || 'xterm-256color',
    USER: process.env.USER || '',
    SHELL: process.env.SHELL || '/bin/bash',
    NODE_ENV: process.env.NODE_ENV || '',
    TMPDIR: process.env.TMPDIR || '/tmp',

    JAMINI_BRIDGE_LOCAL_API_KEY: BRIDGE_LOCAL_API_KEY,
    JAMINI_BRIDGE_PORT: String(bridgePort),
    JAMINI_BRIDGE_HOST: '127.0.0.1',
    JAMINI_BRIDGE_AUTO_START: '1',
    JAMINI_MODEL: process.env.JAMINI_MODEL || cfg.defaultModel,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    DEEPSEEK_BASE_URL: cfg.deepseekBaseUrl,
    JAMINI_HOME: JAMINI_HOME,
    JAMINI_BRIDGE_LOG_LEVEL: process.env.JAMINI_BRIDGE_LOG_LEVEL || 'info',
    JAMINI_REASONING_EFFORT: process.env.JAMINI_REASONING_EFFORT || 'high',
    JAMINI_SYSTEM_PROMPT: process.env.JAMINI_SYSTEM_PROMPT || cfg.systemPrompt || '',
    JAMINI_THINKING: process.env.JAMINI_THINKING || '',

    GEMINI_API_KEY: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    GOOGLE_CLOUD_PROJECT: '',
    GOOGLE_CLOUD_LOCATION: '',
    GOOGLE_GENAI_USE_VERTEXAI: 'false',

    GEMINI_TELEMETRY_ENABLED: 'false',
    GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
    GEMINI_TELEMETRY_USE_COLLECTOR: 'false',
    GEMINI_TELEMETRY_OTLP_ENDPOINT: '',
    GEMINI_TELEMETRY_TARGET: 'local',
    OTEL_SDK_DISABLED: 'true',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OTEL_SERVICE_NAME: '',
    OTEL_RESOURCE_ATTRIBUTES: '',

    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',

    SENTRY_DSN: '',
    DD_API_KEY: '',
    NEW_RELIC_LICENSE_KEY: '',
    POSTHOG_API_KEY: '',
    SEGMENT_WRITE_KEY: '',
    AMPLITUDE_API_KEY: '',
    MIXPANEL_TOKEN: '',
    BUGSNAG_API_KEY: '',
    ROLLBAR_ACCESS_TOKEN: '',

    BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
    UNSTRUCTURED_API_KEY: process.env.UNSTRUCTURED_API_KEY || '',
  };

  const bp = spawn(
    process.execPath,
    [BRIDGE_SCRIPT],
    {
      env: bridgeEnv,
      stdio: DEBUG ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    },
  );

  if (!bp.pid) {
    bridgeLogStream.end();
    die('Failed to start bridge process (no PID)');
  }

  writePidFile(bp.pid);

  // Pipe bridge stdout/stderr to log file
  const ts = new Date().toISOString();
  bridgeLogStream.write(`[${ts}] Bridge process started, pid=${bp.pid}\n`);
  bp.stdout?.on('data', (d: Buffer) => {
    bridgeLogStream.write(d);
    if (DEBUG) process.stderr.write(d);
  });
  bp.stderr?.on('data', (d: Buffer) => {
    bridgeLogStream.write(d);
    if (DEBUG) process.stderr.write(d);
  });

  bp.on('error', (err) => {
    bridgeLogStream.write(`[error] ${err.message}\n`);
    die('Failed to start bridge:', err.message);
  });

  bp.on('exit', (code, signal) => {
    const exitTs = new Date().toISOString();
    bridgeLogStream.write(`[${exitTs}] Bridge exited code=${code} signal=${signal}\n`);
    bridgeLogStream.end();
    removePidFile();
  });

  bridgeProcess = bp;

  // Wait for bridge to be ready
  await waitForReady(url);
  return url;
}

async function stopProcessBridge(): Promise<void> {
  if (bridgeProcess && !bridgeProcess.killed) {
    log('Shutting down bridge process...');
    bridgeProcess.kill('SIGTERM');

    // Wait up to 3s for graceful shutdown
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (bridgeProcess.killed) break;
      await sleep(100);
    }

    if (!bridgeProcess.killed) {
      log('Bridge did not shut down gracefully, force killing');
      bridgeProcess.kill('SIGKILL');
    }
    bridgeProcess = null;
  }
  removePidFile();
}

// ── Bridge management — external mode ───────────────────────────────

function getExternalBridgeUrl(): string {
  return (
    process.env.JAMINI_BRIDGE_URL ||
    process.env.GOOGLE_GEMINI_BASE_URL ||
    'http://127.0.0.1:7654'
  );
}

async function verifyExternalBridge(url: string): Promise<string> {
  const healthy = await checkHealth(url);
  if (!healthy) {
    // Try /models as fallback health check
    try {
      const res = await fetch(`${url}/v1beta/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        die('External bridge unreachable at', url, `(HTTP ${res.status})`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      die('External bridge unreachable at', url + ':', msg || 'connection refused');
    }
  }
  log('External bridge verified at', url);
  return url;
}

// ── Bridge management — container mode ──────────────────────────────

function findContainerRuntime(): string | null {
  // Check for Docker or Podman
  const candidates = ['docker', 'podman'];
  for (const bin of candidates) {
    try {
      const out = execSync(`command -v ${bin}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (out) {
        log('Found container runtime:', out);
        return bin;
      }
    } catch {}
  }
  return null;
}

async function startContainerBridge(cfg: JaminiConfig): Promise<string> {
  const runtime = findContainerRuntime();
  if (!runtime) {
    die(
      'Container bridge mode requires Docker or Podman. Install one or use JAMINI_BRIDGE_MODE=process.',
    );
  }

  bridgePort = parseInt(process.env.JAMINI_BRIDGE_PORT || '0', 10) || await findFreePort();
  const url = `http://127.0.0.1:${bridgePort}`;

  log('Starting container bridge with', runtime, 'on port', bridgePort);

  // Build the docker/podman run command
  const imageName = process.env.JAMINI_CONTAINER_IMAGE || 'jamini:latest';
  const extraArgs = process.env.JAMINI_CONTAINER_EXTRA_ARGS || '';

  const args: string[] = [
    'run',
    '--rm',
    '--name', `jamini-bridge-${bridgePort}`,
    '--entrypoint', 'node',
    '-p', `127.0.0.1:${bridgePort}:${bridgePort}`,
    '-e', `JAMINI_BRIDGE_PORT=${bridgePort}`,
    '-e', `JAMINI_BRIDGE_HOST=0.0.0.0`,
    '-e', `JAMINI_BRIDGE_LOCAL_API_KEY=${BRIDGE_LOCAL_API_KEY}`,
    '-e', `DEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY || ''}`,
    '-e', `DEEPSEEK_BASE_URL=${cfg.deepseekBaseUrl}`,
    '-e', `JAMINI_MODEL=${process.env.JAMINI_MODEL || cfg.defaultModel}`,
    '-e', `BRAVE_API_KEY=${process.env.BRAVE_API_KEY || ''}`,
    '-e', `UNSTRUCTURED_API_KEY=${process.env.UNSTRUCTURED_API_KEY || ''}`,
    '--init',
  ];

  if (extraArgs) {
    args.push(...extraArgs.split(' ').filter(Boolean));
  }

  args.push(imageName, '/opt/jamini/bridge/dist/server.js');

  const containerProcess = spawn(runtime, args, {
    stdio: DEBUG ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: process.env as Record<string, string>,
  });

  // Log container output
  const logDir = join(JAMINI_HOME, 'log');
  const containerLogPath = join(logDir, 'container-bridge.log');
  const containerLogStream = createWriteStream(containerLogPath, { flags: 'a', mode: 0o600 });
  const ts = new Date().toISOString();
  containerLogStream.write(`[${ts}] Container bridge started, port=${bridgePort}, runtime=${runtime}\n`);

  containerProcess.stdout?.on('data', (d: Buffer) => containerLogStream.write(d));
  containerProcess.stderr?.on('data', (d: Buffer) => containerLogStream.write(d));
  containerProcess.on('exit', (code, signal) => {
    containerLogStream.write(`[${new Date().toISOString()}] Container bridge exited code=${code} signal=${signal}\n`);
    containerLogStream.end();
  });

  bridgeProcess = containerProcess;

  // Wait for bridge to be ready in container
  await waitForReady(url, 60_000);
  return url;
}

async function stopContainerBridge(): Promise<void> {
  const runtime = findContainerRuntime();
  if (!runtime || !bridgeProcess) return;

  if (!bridgeProcess.killed) {
    log('Stopping container bridge');
    bridgeProcess.kill('SIGTERM');
    await sleep(2000);
    if (!bridgeProcess.killed) {
      bridgeProcess.kill('SIGKILL');
    }
  }
  bridgeProcess = null;
}

// ── Bridge management — auto mode ────────────────────────────────────

async function startBridgeAuto(cfg: JaminiConfig): Promise<string> {
  let mode: BridgeMode = 'process';

  // Check if JAMINI_BRIDGE_URL is set — implies external
  if (process.env.JAMINI_BRIDGE_URL || process.env.GOOGLE_GEMINI_BASE_URL) {
    mode = 'external';
  }

  if (mode === 'process') {
    try {
      return await startProcessBridge(cfg);
    } catch (err) {
      warn('Process bridge mode failed:', err);
      // Try container fallback
      const runtime = findContainerRuntime();
      if (runtime) {
        warn('Falling back to container bridge mode with', runtime);
        try {
          return await startContainerBridge(cfg);
        } catch (err2) {
          die('Both process and container bridge modes failed:', err2);
        }
      }
      die('Process bridge mode failed and no container runtime found. Install Docker/Podman or set JAMINI_BRIDGE_MODE=external.');
    }
  }
  // Unreachable normally but kept for clarity
  return await startProcessBridge(cfg);
}

// ── Translator mode resolution ──────────────────────────────────────

function resolveTranslatorMode(cfg: JaminiConfig): TranslatorMode {
  let mode = cfg.translatorMode;
  if (mode === 'auto') mode = 'custom';
  if (mode === 'litellm') {
    die('LiteLLM translator mode is not yet implemented. Use JAMINI_TRANSLATOR_MODE=custom or auto.');
  }
  if (mode !== 'custom') {
    die(`Unsupported translator mode: ${mode}. Use: auto, custom, or litellm.`);
  }
  return mode;
}

// ── Bridge dispatch ─────────────────────────────────────────────────

let actualBridgeMode: BridgeMode = 'process';

async function startBridge(cfg: JaminiConfig): Promise<string> {
  let mode = cfg.bridgeMode;
  if (mode === 'auto') {
    actualBridgeMode = 'auto';
    return await startBridgeAuto(cfg);
  }
  actualBridgeMode = mode;

  switch (mode) {
    case 'process':
      return await startProcessBridge(cfg);

    case 'external':
      return await verifyExternalBridge(getExternalBridgeUrl());

    case 'container':
      return await startContainerBridge(cfg);

    default:
      die('Unknown bridge mode:', mode);
  }
}

async function stopBridge(): Promise<void> {
  if (actualBridgeMode === 'external' || actualBridgeMode === 'auto') {
    // For auto mode, stop whatever was started
    // For external, never stop
    if (actualBridgeMode === 'external') return;
  }

  // Check if we're in container mode
  if (actualBridgeMode === 'container') {
    await stopContainerBridge();
    return;
  }

  // Default: process mode cleanup
  await stopProcessBridge();
}

// ── Find Gemini CLI ──────────────────────────────────────────────────

function findGeminiCli(): string {
  // 1. Explicit override from env
  const override = process.env.JAMINI_GEMINI_BIN;
  if (override) {
    if (existsSync(override)) {
      log('Using JAMINI_GEMINI_BIN override:', override);
      return override;
    }
    die('JAMINI_GEMINI_BIN is set but file not found:', override);
  }

  // 2. Local node_modules from @google/gemini-cli dependency
  const localBin = join(REPO_ROOT, 'node_modules', '.bin', 'gemini');
  if (existsSync(localBin)) {
    log('Found local Gemini CLI:', localBin);
    return localBin;
  }

  // 3. Resolved from @google/gemini-cli package
  try {
    const resolved = execSync(
      `node -e 'console.log(require.resolve("@google/gemini-cli/package.json"))'`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: REPO_ROOT },
    ).trim();
    if (resolved) {
      const pkgDir = dirname(resolved);
      const pkg = JSON.parse(readFileSync(resolved, 'utf8'));
      if (pkg.bin?.gemini) {
        const binPath = join(pkgDir, pkg.bin.gemini);
        if (existsSync(binPath)) {
          log('Found Gemini CLI from package:', binPath);
          return binPath;
        }
      }
    }
  } catch { /* continue */ }

  // 4. Global gemini on PATH
  try {
    const globalBin = execSync(
      'command -v gemini 2>/dev/null || which gemini 2>/dev/null || echo ""',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (globalBin && existsSync(globalBin)) {
      log('Found global Gemini CLI:', globalBin);
      return globalBin;
    }
  } catch { /* continue */ }

  // 5. Fatal: not found
  die(
    'Upstream Gemini CLI binary was not found.',
    'Jamini wraps unmodified Gemini CLI and needs @google/gemini-cli available.',
    'Try:',
    '  npm install',
    '  npm install -g @google/gemini-cli',
    'or set JAMINI_GEMINI_BIN=/path/to/gemini',
  );
}

// ── Spawn Gemini CLI ─────────────────────────────────────────────────

function spawnGeminiCli(
  geminiPath: string,
  args: string[],
  bridgeUrl: string,
  cfg: JaminiConfig,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const env = buildGeminiEnv(bridgeUrl, cfg);
    log('Spawning Gemini CLI:', geminiPath, args.join(' '));
    log('GOOGLE_GEMINI_BASE_URL=', bridgeUrl);

    // Pipe stderr to filter known Gemini CLI startup warnings
    const child = spawn(geminiPath, args, {
      env,
      stdio: ['inherit', 'inherit', 'pipe'],  // inherit stdin/stdout so child detects TTY for interactive mode
      cwd: process.cwd(),
      shell: platform() === 'win32',
    });

    // Filter stderr — suppress known noisy startup warnings
    if (child.stderr) {
      let stderrBuffer = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data) => {
        stderrBuffer += data;
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          const filtered = filterStderrLine(line);
          if (filtered) {
            process.stderr.write(filtered + '\n');
          }
        }
      });
      child.stderr.on('end', () => {
        if (stderrBuffer) {
          const filtered = filterStderrLine(stderrBuffer);
          if (filtered) process.stderr.write(filtered + '\n');
        }
      });
    }

    child.on('error', (err) => reject(new Error(`Failed to spawn Gemini CLI: ${err.message}`)));
    child.on('exit', (code, signal) => {
      log(`Gemini CLI exited code=${code} signal=${signal}`);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

// ── CLI helpers ─────────────────────────────────────────────────────

const SUPPORTED_MODELS = new Set([
  'v4-flash', 'v4-flash-thinking', 'v4-pro', 'v4-pro-thinking',
]);

function validateModelArg(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Handle both --model value and --model=value and -m value forms
    let model: string | null = null;
    if (arg === '-m' || arg === '--model') {
      if (i + 1 < args.length) model = args[i + 1];
    } else if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
    } else if (arg.startsWith('-m=')) {
      model = arg.slice('-m='.length);
    }

    if (model && !SUPPORTED_MODELS.has(model)) {
      die(
        `Unsupported Jamini model: ${model}\n`,
        'Choose one of: v4-flash, v4-flash-thinking, v4-pro, v4-pro-thinking',
      );
    }
  }
}

// ── System subcommand ────────────────────────────────────────────────

function handleSystemSubcommand(args: string[], cfg: JaminiConfig): void {
  const sub = args[0];
  
  if (sub === 'add') {
    // jamini system add -f <file>
    const fileIdx = args.indexOf('-f') !== -1 ? args.indexOf('-f') : args.indexOf('--file');
    if (fileIdx === -1 || !args[fileIdx + 1]) {
      die('Usage: jamini system add -f <file.md>');
    }
    const filePath = args[fileIdx + 1];
    if (!existsSync(filePath)) {
      die(`File not found: ${filePath}`);
    }
    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) {
      die(`File is empty: ${filePath}`);
    }
    updateConfig('systemPrompt', content);
    console.log(`System prompt loaded from ${filePath} (${content.length} chars)`);
    console.log('');
    console.log('Preview:');
    console.log('──────────────────────────────────────────────');
    console.log(content.slice(0, 200) + (content.length > 200 ? '...' : ''));
    console.log('──────────────────────────────────────────────');
    process.exit(0);
  }

  if (sub === 'list' || sub === 'show') {
    if (!cfg.systemPrompt) {
      console.log('No system prompt set. Use: jamini system add -f <file.md>');
    } else {
      console.log(`System prompt (${cfg.systemPrompt.length} chars):`);
      console.log('──────────────────────────────────────────────');
      console.log(cfg.systemPrompt);
      console.log('──────────────────────────────────────────────');
    }
    process.exit(0);
  }

  if (sub === 'remove' || sub === 'clear' || sub === 'delete') {
    if (!cfg.systemPrompt) {
      console.log('No system prompt to remove.');
    } else {
      updateConfig('systemPrompt', '');
      console.log('System prompt removed.');
    }
    process.exit(0);
  }

  if (sub === 'help') {
    console.log(`Jamini System Subcommand

Manage a persistent system prompt injected into every conversation.

Usage:
  jamini system add -f <file.md>     Load system prompt from file
  jamini system list                 Show current system prompt
  jamini system show                 Same as list
  jamini system remove               Remove system prompt
  jamini system help                 This help

Shortcuts:
  jamini -U, --uncensored-mode       Load uncensored prompt from config/uncensored.md
  jamini -u, --uncensored-off        Remove system prompt

The system prompt is stored in $JAMINI_HOME/config.json and injected
as a system instruction in every conversation via the bridge.
`);
    process.exit(0);
  }

  die(`Unknown system subcommand: ${sub}. Use: add, list, show, remove, help`);
}


function printHelp(cfg: JaminiConfig): void {
  console.log(`Jamini — Gemini CLI drop-in routing to DeepSeek V4

Usage:
  jamini [same flags and args as gemini]

Examples:
  jamini                    # interactive mode
  jamini "explain this code"
  jamini -m v4-flash "quick question"
  jamini -m v4-flash-thinking "think through this bug"
  jamini -m v4-pro "refactor this file"
  jamini -y -m v4-pro-thinking "fix all tests"
  jamini --approval-mode=yolo -m v4-pro-thinking

Jamini Models:
  v4-flash             Fast daily coding (non-thinking)
  v4-flash-thinking    Fast reasoning, debugging (thinking)
  v4-pro               Heavy coding, reviews (non-thinking)
  v4-pro-thinking      Deep reasoning, architecture (thinking)

Default model: ${cfg.defaultModel}

System Prompt:
  jamini system add -f <file.md>   Load persistent system prompt
  jamini system list               Show current system prompt
  jamini system remove             Clear system prompt
  jamini -U, --uncensored-mode     Quick-load uncensored prompt
  jamini -u, --uncensored-off      Disable uncensored mode

Bridge Modes (JAMINI_BRIDGE_MODE):
  auto       Try process, fall back to container (default)
  process    Local child process (preferred)
  container  Docker/Podman container
  external   User-managed bridge (set JAMINI_BRIDGE_URL)

Translator Modes (JAMINI_TRANSLATOR_MODE):
  auto       Use custom bridge (default)
  custom     Jamini TypeScript Gemini→DeepSeek bridge

Environment:
  DEEPSEEK_API_KEY       Required. Your DeepSeek API key.
  JAMINI_MODEL           Default model to use.
  JAMINI_HOME            Jamini config directory (default ~/.jamini).
  JAMINI_DEBUG=1         Enable debug logging.
  JAMINI_BRIDGE_MODE     Bridge launch mode (auto|process|container|external).
  JAMINI_BRIDGE_URL      External bridge URL (required for external mode).
  JAMINI_BRIDGE_PORT     Fixed bridge port (default: ephemeral).
  JAMINI_TRANSLATOR_MODE Translator implementation (auto|custom).
  BRAVE_API_KEY          Optional. Enable web search tool.
  UNSTRUCTURED_API_KEY   Optional. Enable document extraction tool.

YOLO / Dangerous Mode:
  jamini -y ...
  jamini --yolo ...
  jamini --approval-mode=yolo ...
  ⚠  Only use in disposable VMs/containers/trusted workspaces.

Gemini CLI flags not listed here are passed through unchanged.
`);
}

function printVersion(): void {
  console.log('jamini v0.2.3');
}

// ── Signal handling & cleanup ───────────────────────────────────────

let isCleaningUp = false;

async function doCleanup(): Promise<void> {
  if (isCleaningUp) return;
  isCleaningUp = true;
  log('Running cleanup...');

  await stopBridge();

  // Close log stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

function setupCleanup(): void {
  // Single cleanup gate
  const cleanup = () => {
    doCleanup().catch(() => {});
  };

  process.on('exit', () => {
    // Synchronous cleanup on exit — kill bridge if still alive
    if (bridgeProcess && !bridgeProcess.killed) {
      try { bridgeProcess.kill('SIGKILL'); } catch {}
    }
    removePidFile();
  });

  process.on('SIGINT', () => {
    // Do not call log() here — logFile() may lazily create streams
    // inside a signal handler, which is unsafe.  Instead, we use
    // console.error which is signal-safe.
    console.error('[jamini] Received SIGINT');
    
    // Fire-and-forget async cleanup; exit after timeout backstop.
    const doExit = () => {
      if (bridgeProcess && !bridgeProcess.killed) {
        try { bridgeProcess.kill('SIGKILL'); } catch {}
      }
      removePidFile();
      process.exit(130);
    };
    doCleanup().finally(doExit);
    // If cleanup doesn't finish within 5 seconds, force exit.
    setTimeout(doExit, 5000).unref();
  });

  process.on('SIGTERM', () => {
    console.error('[jamini] Received SIGTERM');
    const doExit = () => {
      if (bridgeProcess && !bridgeProcess.killed) {
        try { bridgeProcess.kill('SIGKILL'); } catch {}
      }
      removePidFile();
      process.exit(143);
    };
    doCleanup().finally(doExit);
    setTimeout(doExit, 5000).unref();
  });

  process.on('SIGHUP', () => {
    log('Received SIGHUP');
    // Don't exit on SIGHUP, just log
  });

  process.on('uncaughtException', (err) => {
    logFile(`[fatal] uncaughtException: ${err.message}\n${err.stack || ''}`);
    cleanup();
    console.error('[jamini:fatal]', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logFile(`[fatal] unhandledRejection: ${String(reason)}`);
    console.error('[jamini:fatal:rejection]', reason);
    cleanup();
    process.exit(1);
  });
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load .env before reading any config
  dotenv.config();
  const args = process.argv.slice(2);

  // Load config (reads from file + env)
  const cfg = loadConfig();
  log('[privacy] Google/Gemini: BLOCKED | Telemetry: OFF | History: ' + cfg.historyMode + ' | Auto-update: OFF');
  log('Config loaded. bridgeMode=', cfg.bridgeMode, 'translatorMode=', cfg.translatorMode, 'defaultModel=', cfg.defaultModel);

  // ── System subcommand ──────────────────────────────────────────────
  if (args[0] === 'system') {
    handleSystemSubcommand(args.slice(1), cfg);
    // handleSystemSubcommand exits, but just in case:
    process.exit(0);
  }

  // ── Uncensored mode shortcut ───────────────────────────────────────
  const uncensoredIdx = args.indexOf('-U') !== -1 ? args.indexOf('-U') : args.indexOf('--uncensored-mode');
  const uncensoredOffIdx = args.indexOf('-u') !== -1 ? args.indexOf('-u') : args.indexOf('--uncensored-off');
  
  if (uncensoredIdx !== -1) {
    // Find uncensored.md relative to repo root or cwd
    const candidates = [
      join(REPO_ROOT, 'config', 'uncensored.md'),
      join(process.cwd(), 'config', 'uncensored.md'),
    ];
    let found = '';
    for (const c of candidates) {
      if (existsSync(c)) { found = c; break; }
    }
    if (!found) {
      die('Uncensored prompt not found. Expected at: config/uncensored.md');
    }
    const content = readFileSync(found, 'utf8').trim();
    updateConfig('systemPrompt', content);
    log(`Uncensored mode ON — system prompt loaded (${content.length} chars)`);
    // Remove the -U/--uncensored-mode flag from args so it doesn't go to Gemini CLI
    args.splice(uncensoredIdx, 1);
  }
  
  if (uncensoredOffIdx !== -1) {
    updateConfig('systemPrompt', '');
    log('Uncensored mode OFF — system prompt cleared');
    args.splice(uncensoredOffIdx, 1);
  }

  // Handle help/version early — no API key or bridge needed
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    printHelp(cfg);
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-V') || args.includes('version')) {
    printVersion();
    process.exit(0);
  }

  // Validate model arguments
  validateModelArg(args);

  // For real model calls, require DEEPSEEK_API_KEY
  if (!isHelpOrVersion(args)) {
    ensureApiKey();
  }

  // Set up dirs and cleanup
  ensureJaminiDirs();

  // Initialize log stream early so signal handlers never lazily create
  // it (lazy creation inside signal handlers risks deadlocks).
  logFile('jamini startup');
  setupCleanup();
  writeGeminiSettings(cfg);

  // Resolve translator mode
  resolveTranslatorMode(cfg);

  // Check for stale PID file (warn but don't block)
  const stalePid = readStalePidFile();
  if (stalePid) {
    warn('A bridge process is already running with PID', stalePid);
    warn('If this is stale, remove', pidFilePath(), 'or set JAMINI_BRIDGE_PORT');
    // Try to use the existing bridge
    const existingPort = parseInt(process.env.JAMINI_BRIDGE_PORT || '0', 10);
    if (existingPort > 0) {
      const existingUrl = `http://127.0.0.1:${existingPort}`;
      if (await checkHealth(existingUrl)) {
        log('Reusing existing bridge at', existingUrl);
        bridgePort = existingPort;
        const geminiPath = findGeminiCli();
        const exitCode = await spawnGeminiCli(geminiPath, args, existingUrl, cfg);
        process.exitCode = exitCode;
        return;
      }
      warn('Existing bridge is not healthy, will start a new one');
    }
  }

  // Start the bridge (with overall startup timeout)
  const STARTUP_TIMEOUT_MS = 60_000;
  const startupTimer = setTimeout(() => {
    die('Startup timed out after ' + STARTUP_TIMEOUT_MS/1000 + 's. Check bridge health and DEEPSEEK_API_KEY.');
  }, STARTUP_TIMEOUT_MS);
  startupTimer.unref();

  const bridgeUrl = await startBridge(cfg);
  clearTimeout(startupTimer);

  // ── No-input UX check ──────────────────────────────────────────
  // When invoked with zero arguments and TTY stdin (no pipe), show
  // a friendly Jamini-branded hint before entering interactive mode.
  if (args.length === 0 && process.stdin.isTTY) {
    process.stderr.write(
      '┌' + '─'.repeat(61) + '┐\n' +
      '│  Jamini v0.2.2 — AI coding agent (DeepSeek V4)           │\n' +
      '│  Type your question or use:                              │\n' +
      '│    jamini "your question here"                           │\n' +
      '│    jamini --prompt "your question here"                  │\n' +
      '│    jamini -m v4-flash "quick question"                   │\n' +
      '│    jamini --help                                         │\n' +
      '│  Piping: echo "question" | jamini -y                     │\n' +
      '└' + '─'.repeat(61) + '┘\n\n',
    );
  }

  // Spawn Gemini CLI
  const geminiPath = findGeminiCli();
  const exitCode = await spawnGeminiCli(geminiPath, args, bridgeUrl, cfg);

  // Cleanup
  await stopBridge();
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error('[jamini:fatal]', err);
  logFile(`[fatal] ${err instanceof Error ? err.message + '\n' + (err.stack || '') : String(err)}`);
  process.exit(1);
});

