// ── Jamini model catalog ──────────────────────────────────────────────

export interface ModelEntry {
  /** User-facing short name e.g. v4-flash, v4-flash-thinking */
  id: string;
  /** Actual DeepSeek model to call */
  providerModel: 'deepseek-v4-flash' | 'deepseek-v4-pro';
  /** Whether thinking is on by default for this entry */
  thinking: boolean;
  displayName: string;
  description: string;
  group: 'non-thinking' | 'thinking';
}

export const MODEL_CATALOG: ModelEntry[] = [
  {
    id: 'v4-flash',
    providerModel: 'deepseek-v4-flash',
    thinking: false,
    displayName: 'DeepSeek V4 Flash',
    description: 'Fast daily coding & inspection (non-thinking).',
    group: 'non-thinking',
  },
  {
    id: 'v4-flash-thinking',
    providerModel: 'deepseek-v4-flash',
    thinking: true,
    displayName: 'DeepSeek V4 Flash Thinking',
    description: 'Fast reasoning, debugging, planning (thinking).',
    group: 'thinking',
  },
  {
    id: 'v4-pro',
    providerModel: 'deepseek-v4-pro',
    thinking: false,
    displayName: 'DeepSeek V4 Pro',
    description: 'Heavy coding, reviews, refactors (non-thinking).',
    group: 'non-thinking',
  },
  {
    id: 'v4-pro-thinking',
    providerModel: 'deepseek-v4-pro',
    thinking: true,
    displayName: 'DeepSeek V4 Pro Thinking',
    description: 'Hard debugging, architecture, deep review (thinking).',
    group: 'thinking',
  },
];

export const MODEL_BY_ID = new Map<string, ModelEntry>(
  MODEL_CATALOG.map((m) => [m.id, m]),
);

// Also map provider-model-only lookups for legacy support
const MODEL_BY_PROVIDER = new Map<string, ModelEntry>();
for (const m of MODEL_CATALOG) {
  if (!MODEL_BY_PROVIDER.has(m.providerModel)) {
    MODEL_BY_PROVIDER.set(m.providerModel, m);
  }
}
export { MODEL_BY_PROVIDER };

// ── Gemini API types (inbound) ────────────────────────────────────────

export interface GeminiPart {
  /**
   * If true, this part contains internal model reasoning/thought content.
   * The upstream Gemini CLI renders these as special thought blocks (not raw text).
   */
  thought?: boolean;
  /** Optional Gemini-style thought signature for attribution. */
  thoughtSignature?: string;
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  functionCall?: {
    /** Gemini optionally includes an id; preserve it if present. */
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    /** Should match the functionCall.id or functionCall.name used earlier. */
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiSystemInstruction {
  role?: string;
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: Record<string, unknown>;
  googleSearchRetrieval?: Record<string, unknown>;
  codeExecution?: Record<string, unknown>;
}

export interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
}

export interface GeminiGenerationConfig {
  candidateCount?: number;
  stopSequences?: string[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
  cachedContent?: string;
}

export interface GeminiGenerateContentResponse {
  candidates: Array<{
    content: {
      role: 'model';
      parts: GeminiPart[];
    };
    finishReason?: string;
    index: number;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

export interface GeminiCountTokensRequest {
  contents?: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiTool[];
  generationConfig?: GeminiGenerationConfig;
}

export interface GeminiCountTokensResponse {
  totalTokens: number;
  promptTokens?: number;
  candidatesTokens?: number;
}

// ── DeepSeek / OpenAI Chat Completions types (outbound) ───────────────

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface DeepSeekRequest {
  model: string;
  messages: DeepSeekMessage[];
  tools?: DeepSeekTool[];
  tool_choice?: 'auto' | 'none' | 'required';
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high';
  thinking?: { type: 'enabled' | 'disabled' };
  response_format?: { type: 'json_object' | 'text' };
}

export interface DeepSeekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: DeepSeekToolCall[];
      reasoning_content?: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

export interface DeepSeekStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

