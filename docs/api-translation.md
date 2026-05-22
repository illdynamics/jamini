# API Translation

The Jamini bridge accepts **Gemini GenerateContent**-compatible requests on the inbound side and translates them to **DeepSeek OpenAI-compatible Chat Completions** on the outbound side. Responses are translated back to Gemini format.

## Endpoint Mapping

| Gemini Inbound | DeepSeek Outbound |
|---|---|
| `POST /v1beta/models/:model:generateContent` | `POST /chat/completions` |
| `POST /v1/models/:model:generateContent` | `POST /chat/completions` |
| `POST /v1beta/models/:model:streamGenerateContent` | `POST /chat/completions` (`stream: true`) |
| `POST /v1/models/:model:streamGenerateContent` | `POST /chat/completions` (`stream: true`) |
| `POST /v1beta/models/:model:countTokens` | Local token estimator |
| `POST /v1/models/:model:countTokens` | Local token estimator |

## Model Resolution

User-facing model IDs are translated to DeepSeek provider models:

| User-Facing Model | DeepSeek Provider Model | Thinking |
|---|---|---|
| `v4-flash` | `deepseek-v4-flash` | disabled (`thinking: { type: "disabled" }`) |
| `v4-flash-thinking` | `deepseek-v4-flash` | enabled (`thinking: { type: "enabled" }`, `reasoning_effort: high`) |
| `v4-pro` | `deepseek-v4-pro` | disabled (`thinking: { type: "disabled" }`) |
| `v4-pro-thinking` | `deepseek-v4-pro` | enabled (`thinking: { type: "enabled" }`, `reasoning_effort: high`) |

Unsupported models (including Google/Gemini models) receive a 400 error: *"This is Jamini. Only DeepSeek models are available."*

## Gemini → DeepSeek Field Mapping

### Role Mapping

| Gemini `role` | OpenAI/DeepSeek `role` |
|---|---|
| `user` | `user` |
| `model` | `assistant` |
| (systemInstruction) | `system` (or `developer`) |
| (functionResponse) | `tool` |

### Parts Mapping

| Gemini Part | DeepSeek Message Field |
|---|---|
| `{ text: "..." }` | `content: "..."` |
| `{ functionCall: { id, name, args } }` | `tool_calls: [{ id, type: "function", function: { name, arguments } }]` |
| `{ functionResponse: { id, name, response } }` | `role: "tool"`, `tool_call_id: id`, `content: JSON.stringify(response)` |
| `{ inlineData: {...} }` | Not supported → returns Gemini-compatible error |
| `{ fileData: {...} }` | Not supported → returns Gemini-compatible error |

### System Instruction

Gemini `systemInstruction` (with `parts[].text`) is mapped to a `system` (or `developer`) role message, prepended before conversation messages.

### Function Declaration Mapping

| Gemini | DeepSeek |
|---|---|
| `tools[].functionDeclarations[].name` | `tools[].function.name` |
| `tools[].functionDeclarations[].description` | `tools[].function.description` |
| `tools[].functionDeclarations[].parameters` | `tools[].function.parameters` |

Each Gemini `functionDeclaration` becomes a DeepSeek tool with `type: "function"`.

### Tool Config Mapping

| Gemini `toolConfig.functionCallingConfig.mode` | DeepSeek `tool_choice` |
|---|---|
| `AUTO` | `"auto"` |
| `ANY` | `"required"` |
| `NONE` | `"none"` |

### Generation Config Mapping

| Gemini `generationConfig` | DeepSeek |
|---|---|
| `temperature` | `temperature` |
| `topP` | `top_p` |
| `maxOutputTokens` | `max_tokens` |
| `stopSequences` | `stop` (as array) |
| `responseMimeType: "application/json"` | `response_format: { type: "json_object" }` |

## DeepSeek → Gemini Response Mapping

### Non-Streaming Response

| DeepSeek Field | Gemini Response Field |
|---|---|
| `choices[0].message.content` | `candidates[0].content.parts[0].text` |
| `choices[0].message.tool_calls[]` | `candidates[0].content.parts[]` with `functionCall: { id, name, args }` |
| `choices[0].finish_reason` | `candidates[0].finishReason` (mapped, see below) |
| `usage.prompt_tokens` | `usageMetadata.promptTokenCount` |
| `usage.completion_tokens` | `usageMetadata.candidatesTokenCount` |
| `usage.total_tokens` | `usageMetadata.totalTokenCount` |
| `usage.completion_tokens_details.reasoning_tokens` | `usageMetadata.thoughtsTokenCount` |

### Finish Reason Mapping

| DeepSeek `finish_reason` | Gemini `finishReason` |
|---|---|
| `stop` | `STOP` |
| `length` | `MAX_TOKENS` |
| `tool_calls` | `STOP` |
| `content_filter` | `SAFETY` |
| (error) | `OTHER` |

## Tool Call ID Preservation

Tool call IDs are critical for round-trip correctness. The bridge follows these rules:

1. **Preserve existing IDs**: If Gemini provides a `functionCall.id`, it is used as the DeepSeek `tool_call.id`.
2. **Generate unique IDs**: If no ID is present, a UUID-based ID (`call_<uuid>`) is generated.
3. **Match on response**: When Gemini CLI sends back a `functionResponse`, its `id` is matched to the original `tool_call.id`.
4. **Never use function name as ID**: The function name is never used as the tool call ID — this would break repeated calls to the same function.
5. **Support parallel calls**: Multiple tool calls in one response are supported, each with unique IDs.
6. **Support repeated function names**: Calling the same function twice with different arguments generates different IDs for each call.

### Example Round Trip

```
1. Gemini CLI → Bridge: generateContent with tools[].functionDeclarations[{ name: "read_file" }]

2. Bridge → DeepSeek: chat/completions with tools[{ function: { name: "read_file" } }]

3. DeepSeek → Bridge: assistant with tool_calls[{ id: "call_abc123", function: { name: "read_file", arguments: '{"path":"/tmp/x"}' } }]

4. Bridge → Gemini CLI: candidate with parts[{ functionCall: { id: "call_abc123", name: "read_file", args: { path: "/tmp/x" } } }]

5. Gemini CLI executes tool, sends back:
   Gemini CLI → Bridge: contents[{ role: "model", parts: [{ functionCall: {...} }] }, { role: "user", parts: [{ functionResponse: { id: "call_abc123", name: "read_file", response: {...} } }] }]

6. Bridge → DeepSeek: messages[..., { role: "assistant", tool_calls: [{ id: "call_abc123", ... }] }, { role: "tool", tool_call_id: "call_abc123", content: "..." }]
```

## Streaming Translation

### Non-Tool-Call Streaming

DeepSeek SSE chunks with `delta.content` are translated to Gemini SSE frames with `candidates[0].content.parts[0].text`.

SSE headers:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Each frame: `data: <JSON>\n\n`

### Tool Call Streaming

DeepSeek sends tool call fragments across multiple SSE chunks (`delta.tool_calls[]` with `index`, `id`, `function.name`, `function.arguments`). The bridge:

1. Accumulates fragments per tool call index
2. Assembles complete `function.arguments` JSON
3. Emits a complete Gemini `functionCall` part once the tool call is fully received
4. Supports parallel tool calls (multiple indices in one response)
5. Preserves tool call IDs from DeepSeek

### Client Disconnect

When the Gemini CLI client disconnects (or SIGINT/SIGTERM), the bridge aborts the upstream DeepSeek request to avoid orphaned connections.

## countTokens

The bridge implements a local token estimator for `countTokens` endpoints. It returns:

```json
{
  "totalTokens": <estimate>,
  "promptTokens": <estimate>,
  "candidatesTokens": 0
}
```

The estimate is based on character-count heuristics and is documented as approximate. Gemini CLI uses this for context window management — the bridge ensures it never crashes due to missing countTokens support.

## Auth Mapping

| Connection | Auth Mechanism |
|---|---|
| Gemini CLI → Bridge | `Authorization: Bearer {JAMINI_BRIDGE_LOCAL_API_KEY}` (local proxy key) |
| Bridge → DeepSeek | `Authorization: Bearer {DEEPSEEK_API_KEY}` |

The local proxy key is a random UUID generated once per `~/.jamini` home and stored in `~/.jamini/run/.local-proxy-key`.

## Unsupported Features

Features that Gemini CLI may request but the bridge cannot translate:

| Feature | Behavior |
|---|---|
| `inlineData` (images, audio) | Returns Gemini-compatible 400 error: media not supported |
| `fileData` (Google Cloud files) | Returns Gemini-compatible 400 error |
| `safetySettings` | Accepted but ignored (logged) |
| `cachedContent` | Returns clear error if used |
| `googleSearch` tool | Stub registered if BRAVE_API_KEY present; otherwise not advertised |
| `codeExecution` tool | Not supported — not advertised |

