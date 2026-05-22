# Tools

Jamini routes all Gemini CLI tool calls through the local bridge to DeepSeek. The bridge translates between Gemini `functionDeclarations` / `functionCall` / `functionResponse` format and DeepSeek OpenAI-compatible `tools` / `tool_calls` / `tool` role messages.

## Supported Tools

### File System
The Gemini CLI's builtin filesystem tools (read, write, edit, search, list directory) work transparently through the bridge. The Gemini CLI applies its own sandboxing policy based on the workspace directory.

### Web Search
When `BRAVE_API_KEY` is set, the bridge advertises a web search tool to Gemini CLI via function declarations. The bridge translates search requests to the Brave Search API and returns results in Gemini-compatible format.

### YOLO / Dangerous Mode
Gemini CLI's `--yolo` / `--approval-mode=yolo` flag is passed through unchanged. When enabled, all tool actions are auto-approved without user confirmation.

**⚠️ Only use YOLO in disposable VMs, containers, or trusted workspaces.**

## Tool Call Round-Trip

The bridge preserves tool call IDs end-to-end:

1. **Declare tools**: Bridge translates Gemini `functionDeclarations` to DeepSeek `tools`
2. **DeepSeek responds**: Bridge translates DeepSeek `tool_calls` back to Gemini `functionCall` parts (with original ID preserved)
3. **Gemini CLI executes**: Gemini CLI runs the tool with the arguments DeepSeek provided
4. **Gemini CLI sends result**: Bridge translates the `functionResponse` back to a DeepSeek `tool` role message (with matching `tool_call_id`)
5. **DeepSeek continues**: The tool result is fed back into the conversation

See [`docs/api-translation.md`](./api-translation.md) for detailed field-level mapping.

## MCP Servers

Gemini CLI can be configured with MCP (Model Context Protocol) servers. If you add MCP servers:

- Keep secrets (API keys, tokens) out of generated config files whenever possible
- Settings are stored in `~/.jamini/gemini-cli-home/settings.json`
- The Gemini CLI state directory is isolated — it never touches your host `~/.gemini`

## Unsupported Tools

| Feature | Status |
|---------|--------|
| `inlineData` (images, audio) | Returns Gemini-compatible 400 error |
| `fileData` (Google Cloud files) | Returns 400 error |
| `codeExecution` | Not advertised — not supported |
| Google Search grounding | Not available (uses Brave Search instead when configured) |
