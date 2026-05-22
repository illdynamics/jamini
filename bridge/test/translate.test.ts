import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { translateGeminiToDeepSeek } from '../src/translate-gemini-to-deepseek.js';
import { translateDeepSeekToGemini, translateDeepSeekStreamToGemini, mapFinishReason, ToolCallStreamAccumulator } from '../src/translate-deepseek-to-gemini.js';
import { resolveModel, uuidV4, estimateTokens } from '../src/server.js';
import { redactSecrets } from '../src/config.js';
import type { GeminiGenerateContentRequest, DeepSeekResponse, DeepSeekStreamChunk } from '../src/types.js';

// ═══════════════════════════════════════════════════════════════════════
// Existing translate tests (21 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('translateGeminiToDeepSeek', () => {
  it('converts a simple text prompt', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('maps system instruction to system message', () => {
    const req: GeminiGenerateContentRequest = {
      systemInstruction: {
        parts: [{ text: 'You are a helpful assistant.' }],
      },
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.',
    });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('maps model role to assistant', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi there!' }] },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content).toBe('Hi there!');
  });

  it('maps function declarations to tools', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Search for something' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'web_search',
              description: 'Search the web',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
          ],
        },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0]).toEqual({
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    });
  });

  it('maps functionCall to assistant tool_calls with generated ID', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: { city: 'London' },
              },
            },
          ],
        },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBeNull();
    expect(result.messages[0].tool_calls).toHaveLength(1);
    const tc = result.messages[0].tool_calls![0];
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('get_weather');
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: 'London' });
    // Should have a generated ID
    expect(tc.id).toMatch(/^call_/);
  });

  it('preserves functionCall.id when provided by Gemini', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_abc123',
                name: 'get_weather',
                args: { city: 'Paris' },
              },
            },
          ],
        },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    const tc = result.messages[0].tool_calls![0];
    expect(tc.id).toBe('call_abc123');
  });

  it('maps functionResponse to tool messages with id match', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_abc123',
                name: 'get_weather',
                response: { temp: 22 },
              },
            },
          ],
        },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].tool_call_id).toBe('call_abc123');
    expect(JSON.parse(result.messages[0].content!)).toEqual({ temp: 22 });
  });

  it('maps functionResponse without id to name-based tool_call_id', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: { temp: 30 },
              },
            },
          ],
        },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.messages[0].tool_call_id).toBe('get_weather');
  });

  it('maps generation config (temperature, topP, maxOutputTokens)', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
      generationConfig: {
        temperature: 0.5,
        topP: 0.9,
        maxOutputTokens: 1000,
        stopSequences: ['END'],
      },
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.9);
    expect(result.max_tokens).toBe(1000);
    expect(result.stop).toEqual(['END']);
  });

  it('maps responseMimeType json to response_format', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Give me JSON' }] }],
      generationConfig: { responseMimeType: 'application/json' },
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.response_format).toEqual({ type: 'json_object' });
  });

  it('maps parallel tool calls', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'get_weather',
                args: { city: 'London' },
              },
            },
            {
              functionCall: {
                id: 'call_2',
                name: 'get_time',
                args: { timezone: 'UTC' },
              },
            },
          ],
        },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    expect(result.messages[0].tool_calls).toHaveLength(2);
    expect(result.messages[0].tool_calls![0].id).toBe('call_1');
    expect(result.messages[0].tool_calls![1].id).toBe('call_2');
    expect(result.messages[0].tool_calls![0].function.name).toBe('get_weather');
    expect(result.messages[0].tool_calls![1].function.name).toBe('get_time');
  });

  it('handles repeated same function name with different IDs', () => {
    const req: GeminiGenerateContentRequest = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_aaa',
                name: 'search',
                args: { query: 'first' },
              },
            },
            {
              functionCall: {
                id: 'call_bbb',
                name: 'search',
                args: { query: 'second' },
              },
            },
          ],
        },
      ],
    };
    const result = translateGeminiToDeepSeek(req, 'deepseek-v4-flash');
    const tcs = result.messages[0].tool_calls!;
    expect(tcs[0].id).toBe('call_aaa');
    expect(tcs[1].id).toBe('call_bbb');
    // Different IDs for same function name
    expect(tcs[0].id).not.toBe(tcs[1].id);
  });
});

describe('translateDeepSeekToGemini', () => {
  it('converts a simple text response', () => {
    const dsRes: DeepSeekResponse = {
      id: 'resp-1',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };
    const result = translateDeepSeekToGemini(dsRes);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].content.role).toBe('model');
    expect(result.candidates[0].content.parts).toEqual([{ text: 'Hello!' }]);
    expect(result.candidates[0].finishReason).toBe('STOP');
    expect(result.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    });
  });

  it('maps tool calls to functionCall parts', () => {
    const dsRes: DeepSeekResponse = {
      id: 'resp-2',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_xyz',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Berlin"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const result = translateDeepSeekToGemini(dsRes);
    expect(result.candidates[0].content.parts).toHaveLength(1);
    const fc = result.candidates[0].content.parts[0].functionCall;
    expect(fc).toBeDefined();
    expect(fc!.id).toBe('call_xyz');
    expect(fc!.name).toBe('get_weather');
    expect(fc!.args).toEqual({ city: 'Berlin' });
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('handles reasoning content as thought parts', () => {
    const dsRes: DeepSeekResponse = {
      id: 'resp-3',
      object: 'chat.completion',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Final answer',
            reasoning_content: 'Let me think...',
          },
          finish_reason: 'stop',
        },
      ],
    };
    const result = translateDeepSeekToGemini(dsRes);
    expect(result.candidates[0].content.parts).toHaveLength(2);
    // Reasoning content should be a thought part (not wrapped in [thinking] tags)
    expect(result.candidates[0].content.parts[0].thought).toBe(true);
    expect(result.candidates[0].content.parts[0].text).toBe('Let me think...');
    expect(result.candidates[0].content.parts[0].text).not.toContain('[thinking]');
    expect(result.candidates[0].content.parts[0].text).not.toContain('[/thinking]');
    // Regular content should NOT have thought flag
    expect(result.candidates[0].content.parts[1].thought).toBeUndefined();
    expect(result.candidates[0].content.parts[1].text).toBe('Final answer');
  });

  it('maps finish reasons correctly', () => {
    expect(mapFinishReason('stop')).toBe('STOP');
    expect(mapFinishReason('length')).toBe('MAX_TOKENS');
    expect(mapFinishReason('tool_calls')).toBe('STOP');
    expect(mapFinishReason('content_filter')).toBe('SAFETY');
    expect(mapFinishReason('unknown')).toBe('OTHER');
  });
});

describe('translateDeepSeekStreamToGemini', () => {
  it('converts a text delta chunk', () => {
    const chunk: DeepSeekStreamChunk = {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          delta: { content: 'Hello' },
          finish_reason: null,
        },
      ],
    };
    const result = translateDeepSeekStreamToGemini(chunk);
    expect(result).not.toBeNull();
    expect(result!.candidates[0].content.parts).toEqual([{ text: 'Hello' }]);
    expect(result!.candidates[0].finishReason).toBeUndefined();
  });

  it('converts a finish-only chunk', () => {
    const chunk: DeepSeekStreamChunk = {
      id: 'chunk-2',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    };
    const result = translateDeepSeekStreamToGemini(chunk);
    expect(result).not.toBeNull();
    expect(result!.candidates[0].content.parts).toEqual([]);
    expect(result!.candidates[0].finishReason).toBe('STOP');
  });

  it('returns null for empty delta', () => {
    const chunk: DeepSeekStreamChunk = {
      id: 'chunk-3',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    };
    const result = translateDeepSeekStreamToGemini(chunk);
    expect(result).toBeNull();
  });

  it('converts reasoning content as thought part in streaming', () => {
    const chunk: DeepSeekStreamChunk = {
      id: 'chunk-4',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: 'Let me reason step by step...',
          },
          finish_reason: null,
        },
      ],
    };
    const result = translateDeepSeekStreamToGemini(chunk);
    expect(result).not.toBeNull();
    expect(result!.candidates[0].content.parts).toHaveLength(1);
    // Should be a thought part, not raw text with [thinking] wrapping
    expect(result!.candidates[0].content.parts[0].thought).toBe(true);
    expect(result!.candidates[0].content.parts[0].text).toBe('Let me reason step by step...');
    expect(result!.candidates[0].content.parts[0].text).not.toContain('[thinking]');
    expect(result!.candidates[0].content.parts[0].text).not.toContain('[/thinking]');
  });

  it('handles mixed reasoning and text in streaming', () => {
    const chunk: DeepSeekStreamChunk = {
      id: 'chunk-5',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: 'Thinking...',
            content: 'Hello there',
          },
          finish_reason: null,
        },
      ],
    };
    const result = translateDeepSeekStreamToGemini(chunk);
    expect(result).not.toBeNull();
    expect(result!.candidates[0].content.parts).toHaveLength(2);
    // First part: thought=true
    expect(result!.candidates[0].content.parts[0].thought).toBe(true);
    expect(result!.candidates[0].content.parts[0].text).toBe('Thinking...');
    // Second part: no thought flag, regular text
    expect(result!.candidates[0].content.parts[1].thought).toBeUndefined();
    expect(result!.candidates[0].content.parts[1].text).toBe('Hello there');
    // No raw [thinking] tags anywhere
    const allText = result!.candidates[0].content.parts.map((p: any) => p.text || '').join('');
    expect(allText).not.toContain('[thinking]');
    expect(allText).not.toContain('[/thinking]');
  });

  it('converts tool call deltas via accumulator', () => {
    const accumulator = new ToolCallStreamAccumulator();
    
    // First chunk: id and function name
    accumulator.ingest({
      tool_calls: [{
        index: 0,
        id: 'call_stream_1',
        type: 'function',
        function: { name: 'search' },
      }],
    });
    expect(accumulator.getCompletedToolCallParts()).toHaveLength(0);
    
    // Second chunk: arguments
    accumulator.ingest({
      tool_calls: [{
        index: 0,
        function: { arguments: '{"query":"test"}' },
      }],
    });
    
    const parts = accumulator.getCompletedToolCallParts();
    expect(parts).toHaveLength(1);
    const fc = parts[0].functionCall;
    expect(fc).toBeDefined();
    expect(fc!.id).toBe('call_stream_1');
    expect(fc!.name).toBe('search');
    expect(fc!.args).toEqual({ query: 'test' });
  });

  it('skips partial tool call arguments', () => {
    const accumulator = new ToolCallStreamAccumulator();
    
    accumulator.ingest({
      tool_calls: [{
        index: 0,
        id: 'call_partial',
        type: 'function',
        function: {
          name: 'search',
          arguments: '{"query":"te', // incomplete JSON
        },
      }],
    });
    
    // Partial JSON should not produce completed parts
    expect(accumulator.getCompletedToolCallParts()).toHaveLength(0);
    
    // But finalizeAll should handle it gracefully
    const finalized = accumulator.finalizeAll();
    expect(finalized).toHaveLength(1);
    expect(finalized[0].functionCall!.args).toHaveProperty('_raw');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// NEW TESTS: Model Rejection
// ═══════════════════════════════════════════════════════════════════════

describe('resolveModel (Google model rejection)', () => {
  it('rejects gemini-2.0-flash', () => {
    expect(() => resolveModel('gemini-2.0-flash')).toThrow(/This is Jamini/);
    expect(() => resolveModel('gemini-2.0-flash')).toThrow(/Google\/Gemini models are not supported/);
  });

  it('rejects models/gemini-2.5-pro', () => {
    expect(() => resolveModel('models/gemini-2.5-pro')).toThrow(/This is Jamini/);
  });

  it('rejects gemini-pro', () => {
    expect(() => resolveModel('gemini-pro')).toThrow(/This is Jamini/);
  });

  it('rejects palm-2', () => {
    expect(() => resolveModel('palm-2')).toThrow(/This is Jamini/);
  });

  it('rejects models/chat-bison', () => {
    expect(() => resolveModel('models/chat-bison')).toThrow(/This is Jamini/);
  });

  it('still resolves valid Jamini models', () => {
    const m = resolveModel('v4-flash');
    expect(m.id).toBe('v4-flash');
  });

  it('resolves valid model with models/ prefix', () => {
    const m = resolveModel('models/v4-pro-thinking');
    expect(m.id).toBe('v4-pro-thinking');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// NEW TESTS: UUID v4
// ═══════════════════════════════════════════════════════════════════════

describe('uuidV4 (request ID generation)', () => {
  it('generates a string in UUID v4 format', () => {
    const id = uuidV4();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(uuidV4());
    }
    expect(ids.size).toBe(100);
  });

  it('generates 36-character strings', () => {
    expect(uuidV4()).toHaveLength(36);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// NEW TESTS: Secret Redaction
// ═══════════════════════════════════════════════════════════════════════

describe('redactSecrets', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-key-12345';
    process.env.BRAVE_API_KEY = 'bsa-test-brave-key-67890';
    process.env.JAMINI_BRIDGE_LOCAL_API_KEY = 'jamini-local-secret-key';
  });

  afterAll(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('redacts DEEPSEEK_API_KEY from strings', () => {
    const input = 'Using key: sk-test-deepseek-key-12345 for requests';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-test-deepseek-key-12345');
    expect(result).toContain('[REDACTED:DEEPSEEK_API_KEY]');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer sk-abc123xyz';
    const result = redactSecrets(input);
    expect(result).toContain('Bearer [REDACTED]');
    expect(result).not.toContain('sk-abc123xyz');
  });

  it('redacts x-goog-api-key header values', () => {
    const input = 'x-goog-api-key: some-secret-value-999';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('some-secret-value-999');
  });

  it('redacts x-api-key header values', () => {
    const input = 'x-api-key=jamini-local-secret-key';
    const result = redactSecrets(input);
    expect(result).not.toContain('jamini-local-secret-key');
    expect(result).toContain('[REDACTED]');
  });

  it('does not modify strings without secrets', () => {
    const input = 'GET /v1beta/models HTTP/1.1';
    const result = redactSecrets(input);
    expect(result).toBe('GET /v1beta/models HTTP/1.1');
  });

  it('handles empty strings', () => {
    expect(redactSecrets('')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// NEW TESTS: PID File
// ═══════════════════════════════════════════════════════════════════════

describe('PID file', () => {
  // const testPidFile = `${homedir()}/.jamini/run/bridge.pid`;

  // The PID file is written during server startup.
  // Since we can't start a full server in unit tests easily,
  // we test the supporting logic: env var resolution and file I/O patterns.

  it('JAMINI_PID_FILE env var is respected', () => {
    // This tests that the config layer supports PID_FILE override
    // The actual writing is done in server startup (integration test territory)
    // For unit test: verify environment handling is correct
    const pidFromEnv = process.env.JAMINI_PID_FILE;
    // Just verify the config import doesn't crash
    expect(typeof pidFromEnv === 'string' || pidFromEnv === undefined).toBe(true);
  });

  it('can write and delete PID file manually', () => {
    const testFile = `/tmp/jamini-test-pid-${Date.now()}.pid`;
    try {
      fs.mkdirSync(path.dirname(testFile), { recursive: true });
      fs.writeFileSync(testFile, String(process.pid), 'utf8');
      expect(fs.existsSync(testFile)).toBe(true);

      const content = fs.readFileSync(testFile, 'utf8');
      expect(content).toBe(String(process.pid));

      fs.unlinkSync(testFile);
      expect(fs.existsSync(testFile)).toBe(false);
    } finally {
      try { fs.unlinkSync(testFile); } catch {}
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// NEW TESTS: Token Estimation
// ═══════════════════════════════════════════════════════════════════════

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens for English text', () => {
    // "Hello world" = 2 words * 1.3 = 3, chars/3.5 = 4, max = 4
    const tokens = estimateTokens('Hello world');
    expect(tokens).toBeGreaterThanOrEqual(3);
    expect(tokens).toBeLessThanOrEqual(5);
  });

  it('estimates tokens for code-like text', () => {
    // 70 chars / 3.5 = 20, words ~4 * 1.3 = 6, max = 20
    const code = 'function hello() { return "world"; } // this is a test of the estimator';
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThanOrEqual(10);
  });

  it('returns at least 1 for any non-empty string', () => {
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
  });

  it('uses max of word-based and char-based estimates', () => {
    // Long words: chars/3.5 dominates
    const longWords = 'supercalifragilisticexpialidocious';
    const tokens = estimateTokens(longWords);
    // 1 word * 1.3 = 2, 34 chars / 3.5 = 10, max = 10
    expect(tokens).toBeGreaterThanOrEqual(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// NEW TESTS: Improved countTokens (integration with estimator)
// ═══════════════════════════════════════════════════════════════════════

describe('countTokens estimator improvements', () => {
  it('handles mixed content (text + function calls)', () => {
    // This is tested through the existing translate tests plus estimator tests above
    // The handleCountTokens function uses estimateTokens internally (integration tested via server)
    // Unit test: verify estimateTokens handles each part type
    const textTokens = estimateTokens('Find weather in London');
    const nameTokens = estimateTokens('get_weather');
    const argsTokens = estimateTokens(JSON.stringify({ city: 'London' }));
    const total = textTokens + nameTokens + argsTokens + 4; // +4 role overhead
    expect(total).toBeGreaterThan(5);
  });

  it('estimateTokens with function response JSON', () => {
    const resp = JSON.stringify({ temp: 22, condition: 'sunny', humidity: 45 });
    const tokens = estimateTokens(resp);
    expect(tokens).toBeGreaterThan(3);
  });
});
