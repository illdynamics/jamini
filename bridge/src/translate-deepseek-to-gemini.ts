import type {
  DeepSeekResponse,
  DeepSeekStreamChunk,
  GeminiGenerateContentResponse,
  GeminiPart,
} from './types.js';

/**
 * Map DeepSeek finish_reason to Gemini finishReason.
 */
export function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'STOP';
    case 'length':
      return 'MAX_TOKENS';
    case 'tool_calls':
      return 'STOP';
    case 'content_filter':
      return 'SAFETY';
    case 'insufficient_system_resource':
      return 'OTHER';
    default:
      return 'OTHER';
  }
}

/**
 * Translate a non-streaming DeepSeek response to Gemini GenerateContent response.
 */
export function translateDeepSeekToGemini(
  dsRes: DeepSeekResponse,
): GeminiGenerateContentResponse {
  return {
    candidates: dsRes.choices.map((choice) => {
      const parts: GeminiPart[] = [];

      // Reasoning content (thinking traces) — emit as a thought part
      // The upstream Gemini CLI renders thought parts in a special style
      if (choice.message.reasoning_content) {
        parts.push({
          text: choice.message.reasoning_content,
          thought: true,
        });
      }

      // Regular text content
      if (choice.message.content) {
        parts.push({ text: choice.message.content });
      }

      // Tool calls → functionCall parts
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = { _raw: tc.function.arguments };
          }
          parts.push({
            functionCall: {
              id: tc.id,
              name: tc.function.name,
              args,
            },
          });
        }
      }

      return {
        content: {
          role: 'model',
          parts,
        },
        finishReason: mapFinishReason(choice.finish_reason),
        index: choice.index,
      };
    }),
    usageMetadata: dsRes.usage
      ? {
          promptTokenCount: dsRes.usage.prompt_tokens,
          candidatesTokenCount: dsRes.usage.completion_tokens,
          totalTokenCount: dsRes.usage.total_tokens,
          thoughtsTokenCount:
            dsRes.usage.completion_tokens_details?.reasoning_tokens,
        }
      : undefined,
    modelVersion: dsRes.model,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ToolCallStreamAccumulator — production-grade streaming tool-call buffer
// ═══════════════════════════════════════════════════════════════════════

export class ToolCallStreamAccumulator {
  private calls = new Map<
    number,
    {
      id?: string;
      name?: string;
      argsFragments: string[];
    }
  >();

  /**
   * Ingest deltas from a DeepSeek streaming chunk.
   * Accumulates by tool-call index across multiple chunks.
   */
  ingest(delta: DeepSeekStreamChunk['choices'][0]['delta']): void {
    if (!delta.tool_calls) return;
    for (const tc of delta.tool_calls) {
      const entry = this.calls.get(tc.index) || { argsFragments: [] };
      this.calls.set(tc.index, entry);
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments)
        entry.argsFragments.push(tc.function.arguments);
    }
  }

  /**
   * Return fully-completed tool-call parts (name present + parseable JSON args).
   * Incomplete tool calls are left in the accumulator for future chunks.
   */
  getCompletedToolCallParts(): GeminiPart[] {
    const parts: GeminiPart[] = [];
    for (const [index, entry] of this.calls) {
      if (!entry.name) continue;
      const fullArgs = entry.argsFragments.join('');
      try {
        const parsed = JSON.parse(fullArgs);
        parts.push({
          functionCall: {
            id: entry.id || `call_stream_${index}`,
            name: entry.name,
            args: parsed,
          },
        });
      } catch {
        // Not complete yet — wait for more fragments
      }
    }
    return parts;
  }

  /**
   * On stream end, emit all accumulated tool calls.
   * Even malformed JSON args get a best-effort _raw / _error output.
   */
  finalizeAll(): GeminiPart[] {
    const parts: GeminiPart[] = [];
    for (const [index, entry] of this.calls) {
      if (!entry.name) continue;
      const fullArgs = entry.argsFragments.join('');
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(fullArgs);
      } catch {
        args = {
          _raw: fullArgs,
          _error: 'Failed to parse tool call arguments as JSON',
        };
      }
      parts.push({
        functionCall: {
          id: entry.id || `call_stream_${index}`,
          name: entry.name,
          args,
        },
      });
    }
    return parts;
  }

  /** Whether any tool-call data has been accumulated at all. */
  hasAny(): boolean {
    return this.calls.size > 0;
  }
}

/**
 * Translate a single DeepSeek streaming chunk into a Gemini-compatible streaming chunk.
 *
 * Returns text + reasoning parts immediately. Tool-call parts should be handled
 * by the caller using ToolCallStreamAccumulator — this function will NOT attempt
 * to parse partial tool-call JSON inline.
 *
 * Returns null if the chunk contains no meaningful text/reasoning content.
 */
export function translateDeepSeekStreamToGemini(
  dsChunk: DeepSeekStreamChunk,
): GeminiGenerateContentResponse | null {
  if (!dsChunk.choices || dsChunk.choices.length === 0) return null;

  const choice = dsChunk.choices[0];
  const delta = choice.delta;

  // Handle finish-only chunks (no delta content at all)
  if (!delta.content && !delta.tool_calls && !delta.reasoning_content) {
    if (choice.finish_reason) {
      return {
        candidates: [
          {
            content: { role: 'model', parts: [] },
            finishReason: mapFinishReason(choice.finish_reason),
            index: choice.index,
          },
        ],
      };
    }
    return null;
  }

  const parts: GeminiPart[] = [];

  // Thinking / reasoning content — emit as a thought part
  if (delta.reasoning_content) {
    parts.push({ text: delta.reasoning_content, thought: true });
  }

  // Regular text delta — emit immediately
  if (delta.content) {
    parts.push({ text: delta.content });
  }

  // NOTE: tool_calls deltas are NOT processed here.
  // The caller must use ToolCallStreamAccumulator to buffer tool-call
  // fragments across chunks and emit completed functionCall parts.

  if (parts.length === 0) return null;

  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts,
        },
        index: choice.index,
        finishReason: choice.finish_reason
          ? mapFinishReason(choice.finish_reason)
          : undefined,
      },
    ],
    usageMetadata: dsChunk.usage
      ? {
          promptTokenCount: dsChunk.usage.prompt_tokens,
          candidatesTokenCount: dsChunk.usage.completion_tokens,
          totalTokenCount: dsChunk.usage.total_tokens,
        }
      : undefined,
  };
}
