/**
 * Bridge API Contract Tests
 *
 * Starts the bridge as a child process, then tests all endpoints against it.
 * A mock DeepSeek server is started on a free port to capture and respond to
 * translated requests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
const BRIDGE_SCRIPT = join(process.cwd(), 'bridge/dist/server.js');
let bridgeProcess: ChildProcess | null = null;
let mockServer: Server | null = null;
let bridgeBaseUrl = '';
let mockDeepSeekBaseUrl = '';
let bridgeAuthKey = 'contract-test-key-123';
// ── Helper to find a free port ────────────────────────────────────────
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
// ── Helper to wait for a URL to respond ───────────────────────────────
async function waitForReady(url: string, path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}${path}`);
      if (res.ok || res.status === 503) return; // 503 on readyz without key is fine
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} not ready after ${timeoutMs}ms`);
}
// ── Mock DeepSeek server response builders ────────────────────────────
function mockChatCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mock-resp-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from mock DeepSeek!' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  };
}
function mockToolCallResponse() {
  return {
    id: 'mock-tool-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_mock_abc',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: JSON.stringify({ city: 'London' }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}
function mockParallelToolCallsResponse() {
  return {
    id: 'mock-parallel-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_search_1',
              type: 'function',
              function: {
                name: 'search',
                arguments: JSON.stringify({ query: 'first query' }),
              },
            },
            {
              id: 'call_search_2',
              type: 'function',
              function: {
                name: 'search',
                arguments: JSON.stringify({ query: 'second query' }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}
function mockJSONResponse() {
  return {
    id: 'mock-json-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '{"result": "ok"}' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 6,
      total_tokens: 14,
    },
  };
}
// ── Mock SSE stream helper ────────────────────────────────────────────
function createSSEStream(chunks: string[]): string {
  return chunks.map((chunk) => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n';
}
// ── Mock DeepSeek server ──────────────────────────────────────────────
function startMockDeepSeekServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise(async (resolve, reject) => {
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = createServer((req, res) => {
      const bodyChunks: Buffer[] = [];
      req.on('data', (chunk) => bodyChunks.push(chunk));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
        } catch {}
        // Verify auth
        const auth = req.headers['authorization'] || '';
        if (auth !== 'Bearer sk-mock-deepseek-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
          return;
        }
        // Handle SSE streaming
        if (body.stream === true) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const streamChunks: string[] = body.tools
            ? [
                JSON.stringify({
                  id: 'stream-chunk-1',
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || 'deepseek-v4-flash',
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_stream_xyz',
                            type: 'function',
                            function: {
                              name: 'get_weather',
                              arguments: JSON.stringify({ city: 'Berlin' }),
                            },
                          },
                        ],
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                }),
              ]
            : [
                JSON.stringify({
                  id: 'stream-chunk-1',
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || 'deepseek-v4-flash',
                  choices: [
                    {
                      index: 0,
                      delta: { content: 'Hello' },
                      finish_reason: null,
                    },
                  ],
                }),
                JSON.stringify({
                  id: 'stream-chunk-2',
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || 'deepseek-v4-flash',
                  choices: [
                    {
                      index: 0,
                      delta: { content: ' from' },
                      finish_reason: null,
                    },
                  ],
                }),
                JSON.stringify({
                  id: 'stream-chunk-3',
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || 'deepseek-v4-flash',
                  choices: [
                    {
                      index: 0,
                      delta: { content: ' stream!' },
                      finish_reason: 'stop',
                    },
                  ],
                }),
              ];
          const sseData = createSSEStream(streamChunks);
          res.write(sseData);
          res.end();
          return;
        }
        // Handle tool call request
        if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
          // Check if this is a repeated same-function call
          const messages = body.messages as Array<Record<string, unknown>> | undefined;
          const lastMsg = messages?.[messages.length - 1];
          if (lastMsg?.tool_calls && Array.isArray(lastMsg.tool_calls) && lastMsg.tool_calls.length > 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mockParallelToolCallsResponse()));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockToolCallResponse()));
          return;
        }
        // Handle JSON mode
        if (body.response_format && (body.response_format as Record<string, unknown>).type === 'json_object') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockJSONResponse()));
          return;
        }
        // Default: simple text response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockChatCompletion()));
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, baseUrl });
    });
    server.on('error', reject);
  });
}
// ── Bridge lifecycle ──────────────────────────────────────────────────
async function startBridge(): Promise<string> {
  const port = await findFreePort();
  bridgeBaseUrl = `http://127.0.0.1:${port}`;
  bridgeProcess = spawn(
    'node',
    [BRIDGE_SCRIPT],
    {
      env: {
        ...process.env,
        JAMINI_BRIDGE_PORT: String(port),
        JAMINI_BRIDGE_AUTO_START: "1",
        JAMINI_BRIDGE_HOST: '127.0.0.1',
        JAMINI_BRIDGE_LOCAL_API_KEY: bridgeAuthKey,
        DEEPSEEK_API_KEY: 'sk-mock-deepseek-key',
        DEEPSEEK_API_BASE: mockDeepSeekBaseUrl,
        JAMINI_MODEL: 'v4-flash',
        JAMINI_REQUEST_MAX_RETRIES: '0',
        BRAVE_API_KEY: '',
        UNSTRUCTURED_API_KEY: '',
      },
      stdio: 'pipe',
      cwd: process.cwd(),
    },
  );
  // Log bridge output to stderr for debugging
  bridgeProcess.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) process.stderr.write(`[bridge-contract-test] ${msg}\n`);
  });
  await waitForReady(bridgeBaseUrl, '/readyz', 10_000);
  return bridgeBaseUrl;
}
function stopBridge(): void {
  if (bridgeProcess && !bridgeProcess.killed) {
    bridgeProcess.kill('SIGTERM');
    setTimeout(() => {
      if (bridgeProcess && !bridgeProcess.killed) bridgeProcess.kill('SIGKILL');
    }, 2000);
  }
}
// ── Helper: authenticated fetch to bridge ─────────────────────────────
function bridgeFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${bridgeBaseUrl}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridgeAuthKey}`,
      ...(options.headers as Record<string, string>),
    },
  });
}
// ── Test suite ────────────────────────────────────────────────────────
describe('Bridge API Contract', () => {
  beforeAll(async () => {
    const mock = await startMockDeepSeekServer();
    mockServer = mock.server;
    mockDeepSeekBaseUrl = mock.baseUrl;
    await startBridge();
  }, 15_000);
  afterAll(() => {
    stopBridge();
    if (mockServer) {
      mockServer.close();
    }
  });
  // ── Health endpoints ──────────────────────────────────────────────
  describe('Health endpoints', () => {
    it('GET /health returns 200 with status up', async () => {
      const res = await bridgeFetch('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('up');
    });
    it('GET /readyz returns 200 when DeepSeek key is set', async () => {
      const res = await bridgeFetch('/readyz');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ready');
    });
    it('GET /version returns version string', async () => {
      const res = await bridgeFetch('/version');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBeTruthy();
      expect(typeof body.version).toBe('string');
      expect(body.name).toBe('jamini-bridge');
    });
    it('GET /debug/config redacts secrets', async () => {
      const res = await bridgeFetch('/debug/config');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deepseekApiKey).toBe('[REDACTED]');
      expect(body.port).toBeGreaterThan(0);
      expect(body.host).toBe('127.0.0.1');
    });
  });
  // ── Model list endpoints ──────────────────────────────────────────
  describe('Model list endpoints', () => {
    it('GET /v1beta/models returns exactly 4 models', async () => {
      const res = await bridgeFetch('/v1beta/models');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.models).toHaveLength(4);
      const names = body.models.map((m: { name: string }) => m.name);
      expect(names).toContain('models/v4-flash');
      expect(names).toContain('models/v4-flash-thinking');
      expect(names).toContain('models/v4-pro');
      expect(names).toContain('models/v4-pro-thinking');
      // No Google/Gemini model names
      for (const name of names) {
        expect(name).not.toContain('gemini');
        expect(name).not.toContain('google');
      }
    });
    it('GET /v1/models returns same 4 models', async () => {
      const res = await bridgeFetch('/v1/models');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.models).toHaveLength(4);
    });
    it('GET /v1beta/models has supportedGenerationMethods', async () => {
      const res = await bridgeFetch('/v1beta/models');
      const body = await res.json();
      for (const m of body.models) {
        expect(m.supportedGenerationMethods).toContain('generateContent');
        expect(m.supportedGenerationMethods).toContain('streamGenerateContent');
        expect(m.supportedGenerationMethods).toContain('countTokens');
        expect(m.displayName).toBeTruthy();
        expect(m.description).toBeTruthy();
      }
    });
    it('GET /v1beta/models/v4-flash returns single model info', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('models/v4-flash');
    });
    it('GET /v1/models/v4-pro-thinking returns single model info', async () => {
      const res = await bridgeFetch('/v1/models/v4-pro-thinking');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('models/v4-pro-thinking');
    });
    it('GET /v1beta/models/gemini-pro returns 403 (privacy blocked)', async () => {
      const res = await bridgeFetch('/v1beta/models/gemini-pro');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('privacy policy');
    });
    it('Model list works without auth', async () => {
      const res = await fetch(`${bridgeBaseUrl}/v1beta/models`);
      expect(res.status).toBe(200);
    });
  });
  // ── generateContent (non-streaming) ───────────────────────────────
  describe('generateContent', () => {
    it('POST with simple text prompt returns text', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.candidates).toBeDefined();
      expect(body.candidates.length).toBeGreaterThan(0);
      expect(body.candidates[0].content.role).toBe('model');
      expect(body.candidates[0].content.parts[0].text).toBeTruthy();
    });
    it('POST with systemInstruction sends it correctly', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are a helpful AI.' }] },
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.candidates[0].content.parts[0].text).toBeTruthy();
    });
    it('POST with temperature/topP maps correctly', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
          generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 500 },
        }),
      });
      expect(res.status).toBe(200);
    });
    it('POST with responseMimeType:application/json maps to JSON mode', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Give me JSON' }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The mock returns {"result": "ok"} for JSON mode
      expect(body.candidates[0].content.parts[0].text).toContain('"result"');
    });
    it('POST with unsupported model returns 403 (privacy blocked)', async () => {
      const res = await bridgeFetch('/v1beta/models/gemini-ultra:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('privacy policy');
    });
    it('POST via /v1/models path also works', async () => {
      const res = await bridgeFetch('/v1/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        }),
      });
      expect(res.status).toBe(200);
    });
  });
  // ── countTokens ───────────────────────────────────────────────────
  describe('countTokens', () => {
    it('POST with text returns totalTokens > 0', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:countTokens', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalTokens).toBeGreaterThan(0);
      expect(typeof body.totalTokens).toBe('number');
    });
    it('POST with systemInstruction includes system tokens', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:countTokens', {
        method: 'POST',
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalTokens).toBeGreaterThan(0);
    });
    it('Returns valid Gemini countTokens response shape', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:countTokens', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        }),
      });
      const body = await res.json();
      expect(body).toHaveProperty('totalTokens');
      expect(body).toHaveProperty('promptTokens');
    });
    it('/v1beta/tokens:count also works', async () => {
      const res = await bridgeFetch('/v1beta/tokens:count', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        }),
      });
      expect(res.status).toBe(200);
    });
  });
  // ── Streaming ─────────────────────────────────────────────────────
  describe('Streaming', () => {
    it('POST streamGenerateContent returns SSE text/event-stream', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:streamGenerateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Stream test' }] }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });
    it('Stream chunks contain data: prefix (no [DONE] — Gemini spec)', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:streamGenerateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Stream test' }] }],
        }),
      });
      const text = await res.text();
      expect(text).toContain('data: ');
      // Gemini SSE must NOT contain [DONE] (would crash real Gemini CLI)
      expect(text).not.toContain('[DONE]');
      // Verify at least one chunk has text content
      const dataLines = text
        .split('\n')
        .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map((line) => line.slice(6));
      expect(dataLines.length).toBeGreaterThan(0);
      for (const line of dataLines) {
        const chunk = JSON.parse(line);
        expect(chunk.candidates).toBeDefined();
      }
    });
    it('Stream handles tool call chunks', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:streamGenerateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  description: 'Get weather',
                  parameters: { type: 'object', properties: { city: { type: 'string' } } },
                },
              ],
            },
          ],
        }),
      });
      const text = await res.text();
      // Gemini SSE must NOT contain [DONE] (would crash real Gemini CLI)
      expect(text).not.toContain('[DONE]');
      const dataLines = text
        .split('\n')
        .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map((line) => line.slice(6));
      // Verify at least one chunk has content (text or tool call)
      const hasContent = dataLines.some((line) => {
        try {
          const chunk = JSON.parse(line);
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          return parts.length > 0;
        } catch { return false; }
      });
      expect(hasContent).toBe(true);
    });
  });
  // ── Tool calls ────────────────────────────────────────────────────
  describe('Tool calls', () => {
    it('Function declarations are accepted', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  description: 'Get weather',
                  parameters: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                  },
                },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
    });
    it('Tool call response contains functionCall parts', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  description: 'Get weather',
                  parameters: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                  },
                },
              ],
            },
          ],
        }),
      });
      const body = await res.json();
      const parts = body.candidates[0].content.parts;
      const hasFunctionCall = parts.some((p: { functionCall?: unknown }) => p.functionCall);
      expect(hasFunctionCall).toBe(true);
      // Verify the functionCall shape
      const fc = parts.find((p: { functionCall?: unknown }) => p.functionCall)?.functionCall;
      expect(fc).toBeDefined();
      expect(fc.id).toBeDefined();
      expect(fc.name).toBe('get_weather');
      expect(fc.args).toEqual({ city: 'London' });
    });
    it('functionResponse is accepted back', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [
            {
              role: 'model',
              parts: [
                {
                  functionCall: { id: 'call_mock_abc', name: 'get_weather', args: { city: 'London' } },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: { id: 'call_mock_abc', name: 'get_weather', response: { temp: 22 } },
                },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.candidates[0].content.parts[0].text).toBeTruthy();
    });
    it('Repeated same function name with different args works', async () => {
      // The mock returns parallel tool calls for requests with multiple tools
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [
            {
              role: 'model',
              parts: [
                { functionCall: { id: 'call_aaa', name: 'search', args: { query: 'first' } } },
                { functionCall: { id: 'call_bbb', name: 'search', args: { query: 'second' } } },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
    });
  });
  // ── Auth tests ────────────────────────────────────────────────────
  describe('Auth', () => {
    it('Unauthenticated generateContent is rejected with 401', async () => {
      const res = await fetch(`${bridgeBaseUrl}/v1beta/models/v4-flash:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        }),
      });
      expect(res.status).toBe(401);
    });
    it('Authenticated generateContent with correct key works', async () => {
      const res = await bridgeFetch('/v1beta/models/v4-flash:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        }),
      });
      expect(res.status).toBe(200);
    });
    it('Model list works without auth key', async () => {
      const res = await fetch(`${bridgeBaseUrl}/v1beta/models`);
      expect(res.status).toBe(200);
    });
    it('Health endpoints work without auth', async () => {
      const res = await fetch(`${bridgeBaseUrl}/health`);
      expect(res.status).toBe(200);
    });
  });
  // ── Security tests ────────────────────────────────────────────────
  describe('Security', () => {
    it('/debug/config does NOT expose DEEPSEEK_API_KEY', async () => {
      const res = await bridgeFetch('/debug/config');
      const body = await res.json();
      expect(body.deepseekApiKey).not.toBe('sk-mock-deepseek-key');
      expect(body.deepseekApiKey).toBe('[REDACTED]');
    });
    it('Error responses do NOT contain API keys', async () => {
      const res = await bridgeFetch('/v1beta/models/gemini-ultra:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        }),
      });
      const body = await res.json();
      const errorStr = JSON.stringify(body.error);
      expect(errorStr).not.toContain('sk-mock-deepseek-key');
      expect(errorStr).not.toContain(bridgeAuthKey);
    });
  });
});

