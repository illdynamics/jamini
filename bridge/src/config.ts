// Bridge configuration from environment variables
import dotenv from 'dotenv';
import { homedir } from 'os';

dotenv.config();

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseReasoningEffort = (value: string | undefined): 'high' | 'max' =>
  value === 'max' ? 'max' : 'high';

const parseThinking = (value: string | undefined): boolean =>
  value === 'enabled' || value === 'true' || value === '1';

export const config = {
  port: parsePositiveInt(process.env.JAMINI_BRIDGE_PORT, 7654),
  host: process.env.JAMINI_BRIDGE_HOST || '127.0.0.1',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekApiBase: process.env.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com',
  defaultModel: process.env.JAMINI_MODEL || 'v4-flash-thinking',
  defaultThinking: parseThinking(process.env.JAMINI_THINKING),
  reasoningEffort: parseReasoningEffort(process.env.JAMINI_REASONING_EFFORT),
  requestMaxRetries: parseNonNegativeInt(process.env.JAMINI_REQUEST_MAX_RETRIES, 2),
  streamIdleTimeoutMs: parsePositiveInt(process.env.JAMINI_STREAM_IDLE_TIMEOUT_MS, 600000),
  bridgeLocalApiKey:
    process.env.JAMINI_BRIDGE_LOCAL_API_KEY || 'jamini-local-placeholder',
  braveApiKey: process.env.BRAVE_API_KEY || '',
  unstructuredApiKey: process.env.UNSTRUCTURED_API_KEY || '',

  // ── New production config ──
  pidFile:
    process.env.JAMINI_PID_FILE ||
    `${process.env.JAMINI_HOME || `${homedir()}/.jamini`}/run/bridge.pid`,
  logFile:
    process.env.JAMINI_BRIDGE_LOG ||
    `${process.env.JAMINI_HOME || `${homedir()}/.jamini`}/log/bridge.log`,
  gracefulShutdownTimeoutMs: parsePositiveInt(
    process.env.JAMINI_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    10_000,
  ),
  maxRetryDelayMs: parsePositiveInt(process.env.JAMINI_MAX_RETRY_DELAY_MS, 30_000),
  baseRetryDelayMs: parsePositiveInt(process.env.JAMINI_BASE_RETRY_DELAY_MS, 200),

  systemPrompt: process.env.JAMINI_SYSTEM_PROMPT || '',
};

/**
 * List of env var names whose values must be redacted from logs.
 */
export const REDACTABLE_SECRETS = new Set<string>([
  'DEEPSEEK_API_KEY',
  'BRAVE_API_KEY',
  'UNSTRUCTURED_API_KEY',
  'JAMINI_BRIDGE_LOCAL_API_KEY',
  'GEMINI_API_KEY',
  'JAMINI_LOCAL_PROXY_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);

/**
 * Redact known secrets and any Bearer token from a string.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const name of REDACTABLE_SECRETS) {
    const val = process.env[name];
    if (val && val.length > 4) {
      out = out.split(val).join(`[REDACTED:${name}]`);
    }
  }
  // Also redact the actual bridge local API key value
  const bridgeKey = process.env.JAMINI_BRIDGE_LOCAL_API_KEY;
  if (bridgeKey && bridgeKey.length > 4) {
    out = out.split(bridgeKey).join('[REDACTED:JAMINI_BRIDGE_LOCAL_API_KEY]');
  }
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  out = out.replace(/(x-goog-api-key|x-api-key)[:\s=]+(\S+)/gi, '$1: [REDACTED]');
  return out;
}

