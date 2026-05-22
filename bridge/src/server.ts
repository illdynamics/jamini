import express from 'express';
import cors from 'cors';
import axios, { type AxiosResponse, type AxiosRequestConfig } from 'axios';
import fs from 'fs';
import path from 'path';
import { config, redactSecrets } from './config.js';
import {
  MODEL_CATALOG,
  MODEL_BY_ID,
  MODEL_BY_PROVIDER,
  type ModelEntry,
  type GeminiGenerateContentRequest,
  type GeminiGenerateContentResponse,
  type GeminiCountTokensRequest,
  type GeminiCountTokensResponse,
  type DeepSeekRequest,
} from './types.js';
import { translateGeminiToDeepSeek } from './translate-gemini-to-deepseek.js';
import {
  translateDeepSeekToGemini,
  translateDeepSeekStreamToGemini,
  ToolCallStreamAccumulator,
} from './translate-deepseek-to-gemini.js';

// ═══════════════════════════════════════════════════════════════════════
// UUID v4 (no dependency)
// ═══════════════════════════════════════════════════════════════════════

// exported for tests
export function uuidV4(): string {
  const hex = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      id += '-';
    } else if (i === 14) {
      id += '4';
    } else if (i === 19) {
      id += hex[(Math.random() * 4) | 8];
    } else {
      id += hex[(Math.random() * 16) | 0];
    }
  }
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// Network Egress Blocklist — prevent Google/Gemini outbound contact
// ═══════════════════════════════════════════════════════════════════════

const GOOGLE_HOST_BLOCKLIST: ReadonlyArray<string> = [
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'oauth2.googleapis.com',
  'accounts.google.com',
  'play.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  'cloudtrace.googleapis.com',
  'telemetry.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebase-settings.crashlytics.com',
  'crashlyticsreports-pa.googleapis.com',
  'analytics.google.com',
  'google-analytics.com',
  'www.google-analytics.com',
  'stats.g.doubleclick.net',
  'doubleclick.net',
  'gstatic.com',
  'googleapis.com',
  'googleusercontent.com',
  'google.com',
];

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return GOOGLE_HOST_BLOCKLIST.some((blocked) => {
    if (lower === blocked) return true;
    if (lower.endsWith('.' + blocked)) return true;
    return false;
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Structured logger
// ═══════════════════════════════════════════════════════════════════════

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL: LogLevel =
  (process.env.JAMINI_BRIDGE_LOG_LEVEL as LogLevel) || 'info';

let logStream: fs.WriteStream | null = null;

function initLogStream(): void {
  try {
    const dir = path.dirname(config.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    logStream = fs.createWriteStream(config.logFile, { flags: 'a' });
  } catch {
    // If we can't open log file, console-only
  }
}

function log(level: LogLevel, message: string, requestId?: string): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[CURRENT_LEVEL]) return;

  const ts = new Date().toISOString();
  const rid = requestId || '-';
  const redacted = redactSecrets(message);
  const line = `[${ts}] [${level.toUpperCase()}] [${rid}] ${redacted}`;

  // Console output (only for error/warn by default, or if debug)
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  // File output
  if (logStream) {
    logStream.write(line + '\n');
  }
}

function closeLogStream(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Axios monkey-patch for defense-in-depth egress blocking
// ═══════════════════════════════════════════════════════════════════════

const axiosProto = (axios as any).Axios?.prototype;
const _originalRequest = axiosProto?.request;
if (_originalRequest) {
  axiosProto.request = function (config: AxiosRequestConfig) {
    const url = (config as any).url || '';
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch {
      const base = (config as any).baseURL || '';
      try { hostname = new URL(base).hostname; } catch {}
    }
    if (hostname && isBlockedHost(hostname)) {
      const msg = `[PRIVACY] Blocked outbound axios request to blocked host: ${hostname}`;
      log('warn', msg);
      throw new Error(msg);
    }
    return _originalRequest.call(this, config);
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Model resolution
// ═══════════════════════════════════════════════════════════════════════

const SUPPORTED_IDS = MODEL_CATALOG.map((m) => m.id).join(', ');
const MODEL_BY_ANY = new Map<string, ModelEntry>();

for (const m of MODEL_CATALOG) {
  MODEL_BY_ANY.set(m.id, m);
  MODEL_BY_ANY.set(m.providerModel, m);
  MODEL_BY_ANY.set(`models/${m.id}`, m);
  MODEL_BY_ANY.set(`models/${m.providerModel}`, m);
}

const DEFAULT_MODEL =
  MODEL_BY_ID.get(config.defaultModel) ||
  MODEL_BY_ID.get('v4-flash-thinking')!;

// Patterns that indicate a Google/Gemini model name that should be rejected
const GOOGLE_MODEL_PATTERNS: RegExp[] = [
  /^gemini/i,
  /^models\/gemini/i,
  /^palm/i,
  /^models\/palm/i,
  /^chat-bison/i,
  /^text-bison/i,
  /^code-bison/i,
  /^google/i,
  /^vertex/i,
  /^models\/google/i,
  /^models\/vertex/i,
];

function isGoogleModel(model: string): boolean {
  return GOOGLE_MODEL_PATTERNS.some((p) => p.test(model));
}

// Block patterns for URL paths that target Google/Gemini-native endpoints
const GOOGLE_URL_PATTERNS: RegExp[] = [
  /\/v1beta\/models\/gemini/i,
  /\/v1\/models\/gemini/i,
  /\/v1beta\/models\/palm/i,
  /\/v1\/models\/palm/i,
  /\/v1beta\/models\/chat-bison/i,
  /\/v1\/models\/chat-bison/i,
  /\/v1beta\/models\/code-bison/i,
  /\/v1\/models\/code-bison/i,
  /\/v1beta\/models\/text-bison/i,
  /\/v1\/models\/text-bison/i,
  /\/v1beta\/models\/google/i,
  /\/v1\/models\/google/i,
  /\/v1beta\/models\/vertex/i,
  /\/v1\/models\/vertex/i,
  /\/v1\/tunedModels\//i,
  /\/v1beta\/tunedModels\//i,
  /\/v1\/cachedContents\//i,
  /\/v1beta\/cachedContents\//i,
];

function isBlockedUrlPath(path: string): boolean {
  return GOOGLE_URL_PATTERNS.some((p) => p.test(path));
}

function stripModelPrefix(value: string): string {
  return value.startsWith('models/') ? value.slice('models/'.length) : value;
}

// exported for tests
export function resolveModel(raw: string): ModelEntry {
  const normalized = stripModelPrefix(raw).trim();

  // Explicitly reject Google/Gemini model names
  if (isGoogleModel(normalized)) {
    throw new Error(
      `This is Jamini. Only DeepSeek models are available: ` +
        `${MODEL_CATALOG.map((m) => m.id).join(', ')}. ` +
        `Google/Gemini models are not supported.`,
    );
  }

  const exact = MODEL_BY_ANY.get(normalized);
  if (exact) return exact;
  const provMatch = MODEL_BY_PROVIDER.get(normalized);
  if (provMatch) return provMatch;

  throw new Error(
    `Unsupported Jamini model "${normalized}". Choose one of: ${SUPPORTED_IDS}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PID file
// ═══════════════════════════════════════════════════════════════════════

function writePidFile(): void {
  try {
    const dir = path.dirname(config.pidFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config.pidFile, String(process.pid), 'utf8');
    log('info', `PID ${process.pid} written to ${config.pidFile}`);
  } catch (err: any) {
    log('warn', `Failed to write PID file: ${err.message}`);
  }
}

function removePidFile(): void {
  try {
    if (fs.existsSync(config.pidFile)) {
      fs.unlinkSync(config.pidFile);
      log('info', `PID file removed: ${config.pidFile}`);
    }
  } catch (err: any) {
    log('warn', `Failed to remove PID file: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Express setup
// ═══════════════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ── Request ID middleware ──────────────────────────────────────────

app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  (req as any).requestId = req.header('x-request-id') || uuidV4();
  next();
});

function getRequestId(req: express.Request): string {
  return (req as any).requestId || '-';
}

// ── Request logging middleware ─────────────────────────────────────

function detectAuthSource(req: express.Request): string {
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) return 'bearer';
  if (req.header('x-goog-api-key')) return 'x-goog-api-key';
  if (req.header('x-api-key')) return 'x-api-key';
  return 'none';
}

app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  log(
    'info',
    `${req.method} ${req.url} auth=${detectAuthSource(req)}`,
    getRequestId(req),
  );
  next();
});

// ── Google/Gemini URL path block middleware ────────────────────────

app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (isBlockedUrlPath(req.path)) {
    const rid = getRequestId(req);
    log('error', `[PRIVACY] Blocked Google/Gemini URL path: ${req.method} ${req.path}`, rid);
    res.status(403).json({
      error: {
        code: 403,
        message: 'Blocked Google/Gemini route by privacy policy. Jamini is configured for DeepSeek-only operation.',
        status: 'PERMISSION_DENIED',
      },
    });
    return;
  }
  next();
});

// ── Add x-request-id to responses ──────────────────────────────────

app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('x-request-id', getRequestId(req));
  next();
});

// ── Bridge auth middleware ─────────────────────────────────────────

function extractIncomingApiKey(req: express.Request): string | undefined {
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return (
    req.header('x-goog-api-key')?.trim() ||
    req.header('x-api-key')?.trim()
  );
}

function isPublicRequest(req: express.Request): boolean {
  if (req.method !== 'GET') return false;
  const p = req.path;
  return /^\/v1(beta)?\/models(\/.*)?$/.test(p) || /^\/v1\/tools\/[^/]+$/.test(p);
}

function requireBridgeAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  // ── Feedback endpoints — DISABLED by privacy policy ──
  if (/^\/v1(beta)?\/feedback/i.test(req.path)) {
    res.status(403).json({
      error: {
        code: 403,
        message: 'Feedback is disabled by privacy policy.',
        status: 'PERMISSION_DENIED',
      },
    });
    return;
  }

  if (isPublicRequest(req)) {
    next();
    return;
  }

  // ── Block Google OAuth and Application Credential auth ──
  const authHeader = req.header('authorization') || '';

  // Detect OAuth Bearer tokens (ya29. prefix is Google OAuth)
  if (/^Bearer\s+ya29\./i.test(authHeader)) {
    res.status(403).json({
      error: {
        code: 403,
        message: 'Blocked Google OAuth authentication by privacy policy. Jamini uses local bridge API keys only.',
        status: 'PERMISSION_DENIED',
      },
    });
    return;
  }

  // Detect Google Application Default Credential patterns
  if (/^Bearer\s+.*\.apps\.googleusercontent\.com/i.test(authHeader)) {
    res.status(403).json({
      error: {
        code: 403,
        message: 'Blocked Google Application Credentials by privacy policy. Jamini uses local bridge API keys only.',
        status: 'PERMISSION_DENIED',
      },
    });
    return;
  }

  if (!req.path.startsWith('/v1')) {
    next();
    return;
  }

  const expected = config.bridgeLocalApiKey;
  if (!expected) {
    next();
    return;
  }

  const provided = extractIncomingApiKey(req);
  if (provided !== expected) {
    res.status(401).json({
      error: {
        code: 401,
        message: 'Bridge authentication required',
        status: 'UNAUTHENTICATED',
      },
    });
    return;
  }

  next();
}

app.use(requireBridgeAuth);

// ═══════════════════════════════════════════════════════════════════════
// Health / debug endpoints
// ═══════════════════════════════════════════════════════════════════════

app.get(['/health', '/healthz'], (_req, res) => {
  res.json({
    status: 'up',
    uptime: process.uptime(),
    pid: process.pid,
    defaultModel: DEFAULT_MODEL.id,
    bridgeHost: config.host,
    bridgePort: config.port,
    deepseekConfigured: !!config.deepseekApiKey,
    timestamp: new Date().toISOString(),
  });
});

app.get('/readyz', (_req, res) => {
  if (!config.deepseekApiKey) {
    res.status(503).json({
      status: 'not ready',
      reason: 'DEEPSEEK_API_KEY missing',
    });
    return;
  }
  res.json({
    status: 'ready',
    defaultModel: DEFAULT_MODEL.id,
  });
});

app.get('/version', (_req, res) => {
  res.json({ version: '0.3.0', name: 'jamini-bridge' });
});

app.get('/debug/config', (_req, res) => {
  res.json({
    port: config.port,
    host: config.host,
    deepseekApiBase: config.deepseekApiBase,
    deepseekApiKey: config.deepseekApiKey ? '[REDACTED]' : '<unset>',
    defaultModel: config.defaultModel,
    braveConfigured: !!config.braveApiKey,
    unstructuredConfigured: !!config.unstructuredApiKey,
    bridgeLocalApiKey: config.bridgeLocalApiKey ? '[REDACTED]' : '<unset>',
    pidFile: config.pidFile,
    logFile: config.logFile,
    requestMaxRetries: config.requestMaxRetries,
    gracefulShutdownTimeoutMs: config.gracefulShutdownTimeoutMs,
    maxRetryDelayMs: config.maxRetryDelayMs,
  });
});

app.get('/debug/routes', (_req, res) => {
  const routes = (app as any)._router?.stack
    ?.filter((layer: any) => layer.route || layer.name === 'router')
    .map((layer: any) => {
      if (layer.route) {
        return `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`;
      }
      if (layer.name === 'router' && layer.handle?.stack) {
        return layer.handle.stack
          .filter((s: any) => s.route)
          .map((s: any) => `${Object.keys(s.route.methods).join(',').toUpperCase()} ${s.route.path}`);
      }
      return null;
    })
    .flat()
    .filter(Boolean);

  res.json({ routes: routes || [] });
});

// ═══════════════════════════════════════════════════════════════════════
// Feedback endpoints — DISABLED by privacy policy (belt-and-suspenders)
// ═══════════════════════════════════════════════════════════════════════

app.all(['/v1/feedback', '/v1beta/feedback', '/v1/feedback/*', '/v1beta/feedback/*'], (_req, res) => {
  res.status(403).json({
    error: {
      code: 403,
      message: 'Feedback is disabled by privacy policy.',
      status: 'PERMISSION_DENIED',
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Model list
// ═══════════════════════════════════════════════════════════════════════

function buildModelList() {
  return {
    models: MODEL_CATALOG.map((m) => ({
      name: `models/${m.id}`,
      version: 'jamini-v2',
      displayName: m.displayName,
      description: m.description,
      inputTokenLimit: 128_000,
      outputTokenLimit: 32_000,
      supportedGenerationMethods: [
        'generateContent',
        'streamGenerateContent',
        'countTokens',
      ],
      temperature: { min: 0, max: 2.0, default: 0.7 },
      topP: { min: 0, max: 1.0, default: 1.0 },
    })),
  };
}

app.get(['/v1beta/models', '/v1/models'], (_req, res) => {
  res.json(buildModelList());
});

app.get(['/v1beta/models/:modelId', '/v1/models/:modelId'], (req, res) => {
  try {
    const m = resolveModel(req.params.modelId);
    res.json({
      name: `models/${m.id}`,
      version: 'jamini-v2',
      displayName: m.displayName,
      description: m.description,
      inputTokenLimit: 128_000,
      outputTokenLimit: 32_000,
      supportedGenerationMethods: [
        'generateContent',
        'streamGenerateContent',
        'countTokens',
      ],
    });
  } catch (err: any) {
    res.status(404).json({
      error: { code: 404, message: err.message, status: 'NOT_FOUND' },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Optional tool stubs
// ═══════════════════════════════════════════════════════════════════════

// Brave Search stub
if (config.braveApiKey) {
  app.post('/v1/tools/brave-search', (_req, res) => {
    res.status(501).json({
      error: {
        code: 501,
        message: 'Brave Search tool: not yet fully implemented',
        status: 'NOT_IMPLEMENTED',
      },
    });
  });

  app.get('/v1/tools/brave-search', (_req, res) => {
    res.json({
      name: 'brave-search',
      description: 'Brave Web Search (stub — not yet implemented)',
      enabled: true,
      requiresKey: true,
    });
  });

  log('info', 'Brave Search tool stub registered (BRAVE_API_KEY present)');
}

// Unstructured stub
if (config.unstructuredApiKey) {
  app.post('/v1/tools/unstructured', (_req, res) => {
    res.status(501).json({
      error: {
        code: 501,
        message: 'Unstructured document extraction tool: not yet fully implemented',
        status: 'NOT_IMPLEMENTED',
      },
    });
  });

  app.get('/v1/tools/unstructured', (_req, res) => {
    res.json({
      name: 'unstructured',
      description: 'Unstructured document extraction (stub — not yet implemented)',
      enabled: true,
      requiresKey: true,
    });
  });

  log('info', 'Unstructured tool stub registered (UNSTRUCTURED_API_KEY present)');
}

// ═══════════════════════════════════════════════════════════════════════
// DeepSeek request helpers
// ═══════════════════════════════════════════════════════════════════════

function enrichDeepSeekRequest(
  request: DeepSeekRequest,
  model: ModelEntry,
): DeepSeekRequest {
  request.model = model.providerModel;
  request.thinking = { type: model.thinking ? 'enabled' : 'disabled' };
  if (model.thinking) {
    request.reasoning_effort =
      config.reasoningEffort === 'max' ? 'high' : config.reasoningEffort;
  } else {
    delete request.reasoning_effort;
  }
  return request;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function shouldRetryStatus(status?: number): boolean {
  if (!status) return true;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Post to DeepSeek with exponential backoff + full jitter.
 * Respects Retry-After header from DeepSeek if present.
 */
async function postToDeepSeek(
  dsReq: DeepSeekRequest,
  options: { stream: boolean },
  requestId?: string,
): Promise<AxiosResponse> {
  const attempts = options.stream ? 1 : Math.max(1, config.requestMaxRetries + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      log(
        'debug',
        `DeepSeek request attempt ${attempt}/${attempts} model=${dsReq.model} stream=${options.stream}`,
        requestId,
      );

      // ── Privacy egress guard ──
      const outboundUrl = `${config.deepseekApiBase}/chat/completions`;
      let outboundHost = '';
      try { outboundHost = new URL(outboundUrl).hostname; } catch {}
      if (outboundHost && isBlockedHost(outboundHost)) {
        const msg = `[PRIVACY] Blocked outbound request to blocked host: ${outboundHost}`;
        log('error', msg, requestId);
        throw new Error(msg);
      }

      return await axios.post(
        `${config.deepseekApiBase}/chat/completions`,
        dsReq,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.deepseekApiKey}`,
          },
          responseType: options.stream ? 'stream' : 'json',
          timeout: options.stream ? 300_000 : 120_000,
        },
      );
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status as number | undefined;

      if (attempt >= attempts || !shouldRetryStatus(status)) break;

      // Check Retry-After header
      let delayMs: number;
      const retryAfter = error?.response?.headers?.['retry-after'];
      if (retryAfter) {
        const retrySeconds = Number.parseInt(retryAfter, 10);
        if (Number.isFinite(retrySeconds)) {
          delayMs = retrySeconds * 1000;
        } else {
          delayMs = Math.max(0, new Date(retryAfter).getTime() - Date.now());
        }
        delayMs = Math.min(delayMs, config.maxRetryDelayMs);
      } else {
        const base = config.baseRetryDelayMs;
        const expDelay = Math.min(config.maxRetryDelayMs, base * Math.pow(2, attempt - 1));
        delayMs = expDelay * (0.5 + Math.random());
      }

      log(
        'warn',
        `DeepSeek request failed (attempt ${attempt}/${attempts}, status=${status}), ` +
          `retrying in ${Math.round(delayMs)}ms`,
        requestId,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function ensureProviderKey(): void {
  if (!config.deepseekApiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured');
  }
}

function sendError(
  res: express.Response,
  status: number,
  message: string,
  googleStatus?: string,
  requestId?: string,
): void {
  log('error', `${status} ${message}`, requestId);
  res.status(status).json({
    error: {
      code: status,
      message,
      status: googleStatus || 'INTERNAL',
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Non-streaming generateContent
// ═══════════════════════════════════════════════════════════════════════

function extractModelFromPath(req: express.Request): string {
  const mwa = req.params.modelWithAction;
  if (mwa) {
    const [modelId] = mwa.split(':');
    return modelId || req.params.model || '';
  }
  return req.params.model || '';
}

/**
 * Validate the Gemini request body for unsupported media types.
 * Returns null if valid, or an error message string if unsupported.
 */
function checkUnsupportedMedia(reqBody: GeminiGenerateContentRequest): string | null {
  // Check for cachedContent at request level
  if (reqBody.cachedContent) {
    return 'cachedContent is not supported by Jamini bridge';
  }

  // Check all content parts for inlineData / fileData
  for (const content of reqBody.contents) {
    for (const part of content.parts) {
      if (part.inlineData) {
        return 'inlineData is not supported by Jamini bridge';
      }
      if (part.fileData) {
        return 'fileData is not supported by Jamini bridge';
      }
    }
  }

  // safetySettings — accept but log debug
  if (reqBody.safetySettings && reqBody.safetySettings.length > 0) {
    // silently accepted — logged at debug level by server later
  }

  return null;
}

async function handleGenerateContent(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const requestId = getRequestId(req);
  try {
    ensureProviderKey();

    // Check unsupported media before model resolution
    const mediaError = checkUnsupportedMedia(req.body);
    if (mediaError) {
      sendError(res, 400, mediaError, 'INVALID_ARGUMENT', requestId);
      return;
    }

    // Log safetySettings acceptance
    if (req.body.safetySettings?.length) {
      log('debug', `safetySettings accepted but ignored (${req.body.safetySettings.length} settings)`, requestId);
    }

    const resolvedModel = resolveModel(extractModelFromPath(req));
    log('debug', `Resolved model: ${resolvedModel.id} → ${resolvedModel.providerModel}`, requestId);

    const dsReq = enrichDeepSeekRequest(
      translateGeminiToDeepSeek(req.body, resolvedModel.providerModel, config.systemPrompt),
      resolvedModel,
    );

    const response = await postToDeepSeek(dsReq, { stream: false }, requestId);
    const geminiRes = translateDeepSeekToGemini(response.data);
    res.json(geminiRes);
  } catch (error: any) {
    const upstreamStatus = error?.response?.status;
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      sendError(res, 502, 'DeepSeek authentication failed — check DEEPSEEK_API_KEY', 'UNAUTHENTICATED', requestId);
    } else if (upstreamStatus === 429) {
      sendError(res, 503, 'DeepSeek rate limited — retry later', 'RESOURCE_EXHAUSTED', requestId);
    } else {
      const status = error?.message?.startsWith('This is Jamini') ||
        error?.message?.startsWith('Unsupported Jamini model')
        ? 400
        : 502;
      sendError(res, status, error?.message || 'bridge request failed', undefined, requestId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Streaming generateContent
// ═══════════════════════════════════════════════════════════════════════

async function handleStreamGenerateContent(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const requestId = getRequestId(req);
  try {
    ensureProviderKey();

    // Check unsupported media
    const mediaError = checkUnsupportedMedia(req.body);
    if (mediaError) {
      sendError(res, 400, mediaError, 'INVALID_ARGUMENT', requestId);
      return;
    }

    const resolvedModel = resolveModel(extractModelFromPath(req));
    const dsReq = enrichDeepSeekRequest(
      translateGeminiToDeepSeek(req.body, resolvedModel.providerModel, config.systemPrompt),
      resolvedModel,
    );
    dsReq.stream = true;

    const response = await postToDeepSeek(dsReq, { stream: true }, requestId);
    const stream = response.data;

    // Full SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('x-request-id', requestId);

    // Set stream timeout if available
    if (typeof stream?.setTimeout === 'function') {
      stream.setTimeout(config.streamIdleTimeoutMs, () => {
        log('warn', 'Stream idle timeout, destroying upstream', requestId);
        stream.destroy(new Error('stream idle timeout'));
      });
    }

    // Abort upstream on client disconnect
    req.on('close', () => {
      log('debug', 'Client disconnected, aborting upstream stream', requestId);
      stream.destroy();
    });

    if ((req as any).signal) {
      (req as any).signal.addEventListener('abort', () => {
        log('debug', 'Request aborted, destroying upstream stream', requestId);
        stream.destroy();
      });
    }

    // ── Tool-call streaming accumulator ──
    const toolAccumulator = new ToolCallStreamAccumulator();

    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      if (!chunk || chunk.length === 0) return;
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const dsChunk = JSON.parse(payload);

          // 1. Feed tool-call deltas into the accumulator
          if (dsChunk.choices?.[0]?.delta?.tool_calls) {
            toolAccumulator.ingest(dsChunk.choices[0].delta);
          }

          // 2. Emit text/reasoning deltas immediately (stateless translator)
          const geminiChunk = translateDeepSeekStreamToGemini(dsChunk);
          if (geminiChunk) {
            res.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
          }

          // 3. Emit any completed tool calls from the accumulator
          const completedTools = toolAccumulator.getCompletedToolCallParts();
          if (completedTools.length > 0) {
            const toolChunk: GeminiGenerateContentResponse = {
              candidates: [
                {
                  content: { role: 'model', parts: completedTools },
                  index: dsChunk.choices?.[0]?.index ?? 0,
                  finishReason:
                    dsChunk.choices?.[0]?.finish_reason === 'tool_calls'
                      ? 'STOP'
                      : undefined,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
          }
        } catch {
          // Ignore malformed chunks
        }
      }
    });

    stream.on('end', () => {
      log('debug', 'Upstream stream ended normally', requestId);

      // Finalize any remaining tool calls
      const remainingTools = toolAccumulator.finalizeAll();
      if (remainingTools.length > 0) {
        const toolChunk: GeminiGenerateContentResponse = {
          candidates: [
            {
              content: { role: 'model', parts: remainingTools },
              index: 0,
              finishReason: 'STOP',
            },
          ],
        };
        res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
      }

      res.end();
    });

    stream.on('error', (error: Error) => {
      log('error', `Stream error: ${error.message}`, requestId);
      if (!res.headersSent) {
        sendError(res, 502, error.message, 'BAD_GATEWAY', requestId);
      } else {
        res.end();
      }
    });
  } catch (error: any) {
    log('error', `Stream setup failed: ${error?.message}`, requestId);
    if (!res.headersSent) {
      sendError(res, 502, error?.message || 'stream request failed', undefined, requestId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// countTokens (improved estimator)
// ═══════════════════════════════════════════════════════════════════════

const WORD_RE = /\S+/g;

// exported for tests
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Method 1: word-based (English text: ~1.3 tokens per word)
  const words = (text.match(WORD_RE) || []).length;
  const wordEstimate = Math.ceil(words * 1.3);

  // Method 2: character-based (code: ~3.5 chars per token)
  const charEstimate = Math.ceil(text.length / 3.5);

  // Return the higher of the two, capped
  return Math.max(wordEstimate, charEstimate, 1);
}

function countTokensInParts(parts: any[]): number {
  let total = 0;
  for (const p of parts) {
    if (p.text) total += estimateTokens(p.text);
    if (p.functionCall) {
      total += estimateTokens(p.functionCall.name);
      total += estimateTokens(JSON.stringify(p.functionCall.args || {}));
    }
    if (p.functionResponse) {
      total += estimateTokens(p.functionResponse.name);
      total += estimateTokens(JSON.stringify(p.functionResponse.response || {}));
    }
  }
  return total;
}

async function handleCountTokens(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const requestId = getRequestId(req);
  try {
    const body = req.body as GeminiCountTokensRequest;
    let totalTokens = 0;

    if (body.systemInstruction) {
      totalTokens += countTokensInParts(body.systemInstruction.parts);
    }
    if (body.contents) {
      for (const c of body.contents) {
        totalTokens += countTokensInParts(c.parts);
        totalTokens += 4; // role overhead
      }
    }
    if (body.tools) {
      for (const t of body.tools) {
        if (t.functionDeclarations) {
          for (const fd of t.functionDeclarations) {
            totalTokens += estimateTokens(JSON.stringify(fd));
          }
        }
      }
    }

    const response: GeminiCountTokensResponse = {
      totalTokens: Math.max(totalTokens, 1),
      promptTokens: totalTokens,
    };

    log('debug', `countTokens: estimated totalTokens=${response.totalTokens}`, requestId);

    res.json(response);
  } catch (error: any) {
    sendError(res, 500, error?.message || 'countTokens failed', undefined, requestId);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════

app.post('/v1beta/models/:modelWithAction', (req, res) => {
  const action = req.params.modelWithAction || '';
  if (action.endsWith(':streamGenerateContent')) {
    return handleStreamGenerateContent(req, res);
  }
  if (action.endsWith(':countTokens')) {
    return handleCountTokens(req, res);
  }
  return handleGenerateContent(req, res);
});

app.post('/v1/models/:modelWithAction', (req, res) => {
  const action = req.params.modelWithAction || '';
  if (action.endsWith(':streamGenerateContent')) {
    return handleStreamGenerateContent(req, res);
  }
  if (action.endsWith(':countTokens')) {
    return handleCountTokens(req, res);
  }
  return handleGenerateContent(req, res);
});

app.post('/v1beta/models/:model', handleGenerateContent);
app.post('/v1/models/:model', handleGenerateContent);

app.post('/v1beta/tokens:count', handleCountTokens);
app.post('/v1/tokens:count', handleCountTokens);

// ═══════════════════════════════════════════════════════════════════════
// Graceful shutdown
// ═══════════════════════════════════════════════════════════════════════

let server: ReturnType<typeof app.listen> | null = null;

let shuttingDown = false;

// Track active connections for graceful shutdown draining.
const activeSockets = new Set<import('node:net').Socket>();

function gracefulShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  
  log('info', `Received ${signal}, starting graceful shutdown...`);

  // Force exit after timeout in case connections don't drain
  const forceExit = setTimeout(() => {
    log('warn', `Graceful shutdown timed out after ${config.gracefulShutdownTimeoutMs}ms, forcing exit`);
    // Destroy any remaining open sockets
    for (const sock of activeSockets) {
      try { sock.destroy(); } catch {}
    }
    removePidFile();
    closeLogStream();
    process.exit(1);
  }, config.gracefulShutdownTimeoutMs);
  forceExit.unref();

  // After a short drain window, destroy lingering connections
  const drainTimeout = setTimeout(() => {
    log('info', 'Drain window expired, closing remaining connections');
    for (const sock of activeSockets) {
      try { sock.destroy(); } catch {}
    }
  }, Math.min(config.gracefulShutdownTimeoutMs / 3, 3000));
  drainTimeout.unref();

  if (server) {
    // Stop accepting new connections
    server.close(() => {
      clearTimeout(drainTimeout);
      clearTimeout(forceExit);
      log('info', 'All connections drained, exiting');
      removePidFile();
      closeLogStream();
      process.exit(0);
    });
  } else {
    clearTimeout(drainTimeout);
    clearTimeout(forceExit);
    removePidFile();
    closeLogStream();
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.message}`);
  removePidFile();
  closeLogStream();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

// ═══════════════════════════════════════════════════════════════════════
// Start (only when run directly, not when imported)
// ═══════════════════════════════════════════════════════════════════════

function startBridge(): ReturnType<typeof app.listen> {
  initLogStream();
  writePidFile();

  server = app.listen(config.port, config.host, () => {
    log('info', `Jamini bridge v0.3.0 listening on http://${config.host}:${config.port}`);
    log('info', `Default model: ${DEFAULT_MODEL.id}`);
    log('info', `DeepSeek: ${config.deepseekApiKey ? 'configured' : 'MISSING'}`);
    log('info', `Brave Search: ${config.braveApiKey ? 'key present but tool disabled' : 'disabled'}`);
    log('info', `Unstructured: ${config.unstructuredApiKey ? 'key present but tool disabled' : 'disabled'}`);
    log('info', `Log file: ${config.logFile}`);
    log('info', `PID file: ${config.pidFile}`);
  });

  // Track connections for graceful shutdown draining
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });
  return server;
}

// Auto-start unless explicitly suppressed (for tests/imports)
// CLI wrapper sets JAMINI_BRIDGE_AUTO_START=1 when spawning bridge process
// Tests import helpers without setting this flag, so server won't start
if (process.env.JAMINI_BRIDGE_AUTO_START === '1') {
  startBridge();
}

export { app, startBridge, gracefulShutdown };
