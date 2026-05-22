import type {
  GeminiGenerateContentRequest,
  DeepSeekRequest,
  DeepSeekMessage,
  DeepSeekTool,
  DeepSeekToolCall,
} from './types.js';

/**
 * Generate a stable unique ID for a tool call when Gemini doesn't provide one.
 * Keep a per-request registry to ensure the response can map back.
 */
let callCounter = 0;

function freshCallId(): string {
  callCounter += 1;
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `call_${ts}_${rnd}_${callCounter}`;
}

/**
 * Maps Gemini generation config to DeepSeek parameters.
 */
function mapGenerationConfig(
  gc: GeminiGenerateContentRequest['generationConfig'],
): Partial<DeepSeekRequest> {
  if (!gc) return {};
  const out: Partial<DeepSeekRequest> = {};
  if (gc.temperature !== undefined) out.temperature = gc.temperature;
  if (gc.topP !== undefined) out.top_p = gc.topP;
  if (gc.maxOutputTokens !== undefined) out.max_tokens = gc.maxOutputTokens;
  if (gc.stopSequences) out.stop = gc.stopSequences;
  if (gc.responseMimeType === 'application/json') {
    out.response_format = { type: 'json_object' };
  }
  return out;
}

/**
 * Maps Gemini tool config to DeepSeek tool_choice.
 */
function mapToolConfig(
  tc: GeminiGenerateContentRequest['toolConfig'],
): DeepSeekRequest['tool_choice'] {
  if (!tc?.functionCallingConfig) return undefined;
  const mode = tc.functionCallingConfig.mode;
  if (mode === 'ANY') return 'required';
  if (mode === 'NONE') return 'none';
  return 'auto';
}

/**
 * Translates Gemini GenerateContent request to DeepSeek Chat Completions request.
 *
 * Tool call ID handling:
 * - If Gemini functionCall has an `id`, preserve it as the DeepSeek tool_call id.
 * - Otherwise generate a unique `call_<uuid>`.
 * - When a functionResponse arrives later, it references the same id via
 *   functionResponse.id or falls back to functionResponse.name (legacy match).
 *
 * Unsupported media:
 * - inlineData / fileData / cachedContent throw clear errors.
 * - safetySettings are silently accepted (logged at the server level).
 */
export function translateGeminiToDeepSeek(
  geminiReq: GeminiGenerateContentRequest,
  model: string,
  systemPrompt?: string,
): DeepSeekRequest {
  // ── Guard: unsupported media ──────────────────────────────────────
  if (geminiReq.cachedContent) {
    throw new Error('cachedContent is not supported by Jamini bridge');
  }

  for (const content of geminiReq.contents) {
    for (const part of content.parts) {
      if (part.inlineData) {
        throw new Error('inlineData is not supported by Jamini bridge');
      }
      if (part.fileData) {
        throw new Error('fileData is not supported by Jamini bridge');
      }
    }
  }

  const messages: DeepSeekMessage[] = [];

  // 1. System instruction → first system message
  // Jamini system prompt takes priority, then Gemini system instruction
  let systemParts: string[] = [];
  if (systemPrompt) {
    systemParts.push(systemPrompt);
  }
  if (geminiReq.systemInstruction) {
    const geminiSystemText = geminiReq.systemInstruction.parts
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n');
    if (geminiSystemText) {
      systemParts.push(geminiSystemText);
    }
  }
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  // 2. Contents → messages
  for (const content of geminiReq.contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';

    // ── functionResponse parts → tool messages ──
    const toolResponses = content.parts.filter((p) => p.functionResponse);
    if (toolResponses.length > 0) {
      for (const part of toolResponses) {
        const fr = part.functionResponse!;
        // Use the id from the response if present, otherwise fall back to name
        const toolCallId = fr.id || fr.name;
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify(fr.response),
        });
      }
      continue;
    }

    // ── functionCall parts → assistant message with tool_calls ──
    const toolCalls = content.parts.filter((p) => p.functionCall);
    if (toolCalls.length > 0) {
      const dToolCalls: DeepSeekToolCall[] = toolCalls.map((p) => {
        const fc = p.functionCall!;
        return {
          id: fc.id || freshCallId(),
          type: 'function' as const,
          function: {
            name: fc.name,
            arguments: JSON.stringify(fc.args),
          },
        };
      });
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: dToolCalls,
      });
      continue;
    }

    // ── Regular text content ──
    const text = content.parts
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n');
    if (text) {
      messages.push({ role, content: text });
    }
  }

  // 3. Tools → DeepSeek tools
  const tools: DeepSeekTool[] = [];
  if (geminiReq.tools) {
    for (const tool of geminiReq.tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          tools.push({
            type: 'function',
            function: {
              name: fd.name,
              description: fd.description,
              parameters: fd.parameters,
            },
          });
        }
      }
    }
  }

  // 4. Build request
  const genConfig = mapGenerationConfig(geminiReq.generationConfig);
  const toolChoice = mapToolConfig(geminiReq.toolConfig);

  const dsReq: DeepSeekRequest = {
    model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
    ...genConfig,
  };

  return dsReq;
}

