# Cursor API → OpenAI Compatibility Notes

Summary of how to call the Cursor API and present it as an OpenAI‐style `/v1/chat/completions` endpoint, based on the in‑repo Cursor client (`src/lib/api/cursor-client.ts`) and the restored Cursor CLI sources (`cursor-agent-restored-source-code`).

## What the Cursor API expects
- Endpoint: `POST https://api2.cursor.sh/aiserver.v1.AiService/StreamChat` with `content-type: application/connect+proto` and `connect-protocol-version: 1`.
- Required headers: `authorization: Bearer <access>`, `x-cursor-checksum` (see `generateChecksum`), `x-cursor-client-version`, `x-cursor-client-type`, `x-ghost-mode`, `x-request-id`, `x-cursor-timezone`, `connect-accept-encoding`, `user-agent` (e.g., `connect-es/1.4.0`), `host`. Cursor CLI also sends `x-cursor-streaming: true` for SSE/http1.1 fallback; keep it for safety.
- Body format: Connect envelope `[flags:1][len:4 big-endian][proto payload]`. The payload is a protobuf `ChatMessage`:
  - `messages` (field 2, repeated): user/assistant entries (`role` map: user=1, assistant=2, system=3) with `content` and a `messageId` (field 13).
  - `instructions` (field 4): system prompt string.
  - `projectPath` (field 5): CLI uses `/project`.
  - `model` (field 7): model name.
  - `requestId` (field 9) and `conversationId` (field 15): UUIDs.
- Checksum: `x-cursor-checksum` is derived from the bearer token and a 30‑minute bucketed timestamp (see `generateChecksum`).

## What Cursor responses look like
- Streaming: Connect frames (`[flags][len][payload]`). Error frames have `flags=0x02`; normal frames contain `StreamChatResponse` with `msg` (field 1). `parseStreamChunks` already extracts `delta`, `done`, or `error` and concatenates `msg` strings.
- Non‑streaming: same frames returned in one buffer; concatenate `delta` chunks for the final text.

## Mapping OpenAI → Cursor
- Detect OpenAI chat completions (e.g., `/v1/chat/completions`).
- Convert the OpenAI `messages` array:
  - First system message → `instructions` (field 4).
  - Remaining messages → repeated `messages` (field 2) with role mapping and fresh `messageId`s.
  - Ignore OpenAI tool/function call fields for now; Cursor’s schema in this client is plain text.
- Model: map OpenAI `model` to a Cursor model string (pass through for now).
- Build `ChatRequest` and encode with `encodeChatRequest` → `addConnectEnvelope`.
- Send with Cursor headers (including checksum) via `CursorClient.chat` or `chatStream`.

## Mapping Cursor → OpenAI responses
- Streaming: wrap each `delta` chunk as an SSE `data:` line shaped like:
  - `{"id":"cursor-<uuid>","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."}}]}`
  - Emit a final done event and map `error` chunks to `400/500` with an OpenAI‑style error body.
- Non‑streaming: concatenate all `delta` content into a single `choices[0].message.content`.
- Usage fields: not available from this client path; return empty/zeroed usage to keep compatibility.

## Auth and refresh
- Reuse the OpenCode plugin flow in `src/plugin/plugin.ts`:
  - Loader should refresh when `accessTokenExpired` using `refreshCursorAccessToken`.
  - Inject Cursor headers before fetch; keep `x-cursor-client-version` and `x-cursor-client-type` stable.
  - Store refresh token plus optional API key as `refresh|apiKey` (see `formatRefreshParts`).

## Practical steps to finish the OpenAI wrapper
1) Add an OpenAI request shim (done in `src/lib/api/openai-compat.ts`) that detects `/v1/chat/completions`, maps messages/model to `ChatRequest`, and chooses streaming vs non‑streaming paths. Unsupported `tool_calls/function_call` are rejected with a clear 400 for now. Common model aliases (e.g., `gpt-4`, `gpt-3.5-turbo`) are mapped to Cursor equivalents.
2) Route to `CursorClient.chat`/`chatStream` instead of hitting OpenAI URLs; attach checksum + Cursor headers (done via `CursorClient`).
3) Add a response normalizer that emits OpenAI JSON/SSE shapes from `StreamChunk` output, including proper `id/object/created/model` fields and a final `finish_reason` (done).
4) Wire the loader’s `fetch` override to use the shim when the target URL is OpenAI‑style; otherwise fall back to the original fetch (done in `src/plugin/plugin.ts`).
5) Keep auth refresh logic intact so tokens remain valid mid‑stream; surface errors in OpenAI error format (done via existing refresh path).
6) Next work items: consider tool/function-call translation if needed, and propagate any usage tokens if Cursor starts returning them. Model aliasing is currently static; the Cursor CLI can also fetch model lists via `AiService.GetUsableModels`—we can mirror that later for dynamic population.

## Current status and gaps
- **Models:** We now call `AiService.GetUsableModels` over Connect+JSON to populate `provider.models` with modelId/displayModelId/aliases. Verified live; 17 models returned (composer, auto, sonnet/opus 4.5, gpt-5 variants, etc.).
- **Chat:** All known chat RPCs tested (`StreamChat`, `StreamChatWeb`, `StreamChatContext`, `StreamChatDeepContext`, `TaskStreamChatContext`) return `ERROR_DEPRECATED` (“Request type deprecated. Please upgrade to the latest version of Cursor.”) or similar when called with our hand-rolled payload. Adjusting headers/client-version did not fix this. The backend contract has changed.
- **Protos:** The Cursor agent bundle already includes generated Buf JS protos in `cursor-agent-restored-source-code/proto/dist/generated/aiserver/v1/*` (for example `aiserver_pb.js`, `chat_pb.js`, `aiserver_connect.js`). These exports cover the newer chat shapes (such as `StreamUnifiedChatRequestWithTools`, `StreamUnifiedChatResponse*`) and are imported directly by `cursor-agent-source/index.js`, so the bundle can build the expected payloads without shipping the raw `.proto` files.
- **OpenAI shim impact:** The OpenAI-compatible fetch path is implemented, but our shim still hand-rolls the deprecated `StreamChat` payload. We need to swap it to the generated `StreamUnifiedChat*` requests from the bundled protos for live calls to succeed. Model listing and auth refresh do work.
- **Unified protos reality:** The restored bundle does not actually expose `aiserver_pb` or `StreamUnifiedChat*` types as loadable modules—the webpack module table only includes `chat_pb`, `utils_pb`, and a handful of other services (analytics, background_composer, etc.). The standalone `chat_pb.js` file mutates globals and exports nothing, and the unified classes are absent. Without the real unified proto definitions (or a bundle that contains them), we cannot build the new chat payloads; attempts to load them via shims fall back to legacy `StreamChat`.

## Tool Calling Architecture (Working!)

### Overview

The OpenAI-compatible server now supports **full tool calling** with OpenCode and other OpenAI-compatible clients. This required understanding how Cursor's Agent API handles tool execution differently from OpenAI's API.

### Key Differences: Cursor vs OpenAI

| Aspect | Cursor Agent API | OpenAI API |
|--------|------------------|------------|
| Stream lifecycle | Single persistent stream for entire conversation | New request for each turn |
| Tool execution | Server requests client to execute, waits on same stream | Client receives tool_calls, executes, sends new request with results |
| Built-in tools | `shell`, `read`, `ls`, `grep`, etc. executed via `exec_request` | N/A - all tools are custom |
| Custom tools (MCP) | Sent as `exec_request` with `type: 'mcp'` | Sent as `tool_calls` in response |

### Implementation Strategy

When the client provides `tools` in the request, ALL `exec_request` messages from Cursor are converted to OpenAI `tool_calls` format:

1. **Client sends request** with `tools` array (e.g., `bash`, `read`, `glob`, etc.)
2. **Cursor model calls a tool** → Server receives `exec_request` (could be `type: 'shell'`, `type: 'read'`, `type: 'mcp'`, etc.)
3. **Server emits `tool_calls`** chunk to client with the tool name and arguments
4. **Server emits `finish_reason: "tool_calls"`** and closes the SSE stream
5. **Client executes tool** locally (OpenCode handles this)
6. **Client sends new request** with tool result as a message (`role: "tool"`)
7. **Server formats conversation** with tool results and sends to Cursor
8. **Model continues** generating response

### Tool Name Mapping

Cursor's built-in exec types are mapped to OpenAI tool names:

| Cursor exec_request type | OpenAI tool name | Arguments |
|--------------------------|------------------|-----------|
| `shell` | `bash` | `{ command, cwd? }` |
| `read` | `read` | `{ filePath }` |
| `ls` | `list` | `{ path }` |
| `grep` (with pattern) | `grep` | `{ pattern, path }` |
| `grep` (with glob) | `glob` | `{ pattern, path }` |
| `mcp` | Original tool name | Original args |

### Message History Handling

When the client sends a follow-up request with tool results, `messagesToPrompt()` formats the full conversation:

```
System: <system message>

User: <original query>

Assistant: [Called tool: read({"filePath":"/tmp/x"})]

[Tool result for call_abc123]: <file contents>

Assistant: <continuation after tool>
```

## Session Reuse Strategy (planned)

**Cursor flow vs OpenAI flow (why change is needed):**
- **Cursor native:** One long-lived, bidirectional stream per conversation. Tool calls are `exec_request`s on that same stream; Cursor pauses and waits for tool results via `bidiAppend`, then continues without re-bootstrap. Multiple tools → one stream, one bootstrap.
- **OpenAI pattern:** Each turn is a new HTTP request. Tool calls are emitted, the stream ends, the client executes tools locally, then sends a *new* request with `role:"tool"` messages. The server is expected to continue from that context.
- **Current gap:** Our proxy creates a fresh Cursor stream for every OpenAI turn. That means paying Cursor’s bootstrap (~6s) repeatedly, losing the persistent-stream benefit that Cursor’s design provides. Multi-tool flows become multiples of the bootstrap cost.

**Problem:** Cursor’s Agent API keeps a single persistent stream per conversation. Our OpenAI translation currently starts a *new* Cursor session for every turn, paying ~6s bootstrap each time and losing the benefit of Cursor’s stream reuse.

**Goal:** Reuse the same Cursor session across turns (and across tool calls) while still presenting the OpenAI multi-turn pattern. Support multiple parallel OpenCode windows by isolating sessions.

### Lifecycle (intended)
1) **First OpenAI request** (user → tools allowed)
   - Create `sessionId` (per OpenCode window/conversation).
   - Start Cursor `chatStream`; store `{ client, requestId, iterator, appendSeqno, model, lastActivity }` in a session map keyed by `sessionId`.
   - When Cursor emits `exec_request`, emit OpenAI `tool_calls` with `tool_call_id` = `sess_<sessionId>__call_<cursorCallId>`; **do not close** the Cursor stream—park it.
   - Close the OpenAI SSE to let the client execute the tool.

2) **Follow-up OpenAI request** (client sends `role:"tool"` result)
   - Parse `tool_call_id`, recover `sessionId`; look up session.
   - Send tool result back to Cursor via the stored `client`/`appendSeqno` (`bidiAppend`).
   - Resume reading the parked Cursor iterator; stream the assistant continuation to the OpenAI client.

3) **Repeat** for additional tool calls within the same session (no new bootstrap).

4) **Completion / teardown**
   - On model finish or idle timeout, close Cursor stream and delete the session entry.
   - If a `tool_call_id` is unknown or the session expired, start a fresh session (graceful fallback).

### Data shapes / keys
- **sessionId**: short token (e.g., 12 chars) generated on first turn.
- **tool_call_id**: `sess_<sessionId>__call_<cursorCallId>` so we can recover the session from the tool result message.
- **Session store entry**: `{ client, requestId, iterator, appendSeqno, model, createdAt, lastActivity, pendingExecs? }`.

### Multi-window safety
- Each OpenCode window gets its own `sessionId` embedded in its `tool_call_id`s, so sessions don’t collide. Parallel windows → parallel Cursor streams.

### Edge cases & fallbacks
- Missing/unknown `sessionId`: start a new session and continue (bootstrap cost is paid once).
- Session expired: same as above; fail-soft to a fresh session.
- Model errors: surface to the client, then tear down the session.
- Idle timeout: default 15m planned; configurable.

### Testing ideas (automatic harness)
- Simulate multi-turn with a fake client: first request emits tool_call, second sends tool result, ensure the same session is used (no new bootstrap) and continuation arrives.
- Parallel sessions: two distinct `sessionId`s, interleave tool results, ensure no cross-talk.
- Expired session fallback: delete session mid-test, verify fresh session is created and request still succeeds (with an extra bootstrap).

### Implementation checklist (first pass)
- Add a session store (module-level Map) keyed by `sessionId`; entries keep `client`, `iterator`, `appendSeqno`, `model`, `createdAt`, `lastActivity`, `pendingExecs` (per-call metadata for tool_call_id synthesis).
- First request path: generate `sessionId`, start `chatStream`, stream chunks until an `exec_request` arrives, then emit OpenAI `tool_calls` + `finish_reason: "tool_calls"`, park the iterator (store async iterator + client + append seqno), and return.
- Follow-up path: parse `tool_call_id` to recover `sessionId`; look up session entry; if found, send `bidiAppend` with tool result, resume the parked iterator, and stream until next exec_request or natural finish. If not found, start a fresh session as fallback.
- Idle/expiration: sweep the session map periodically (or check per request) and close streams older than timeout; ensure append attempts on expired sessions return a clear error to the OpenAI client.
- Logging/metrics: record session create/close, resume count, append failures, and fallback occurrences to confirm reuse savings.

### Minimal state machine (server-side)
- `running`: actively streaming assistant tokens; may transition to `waiting_tool` on `exec_request`.
- `waiting_tool`: OpenAI SSE closed with `finish_reason: "tool_calls"`; Cursor stream parked. Transitions to `running` when tool result arrives via `bidiAppend`.
- `closed`: terminal state when Cursor finishes, errors, or idle timeout hits. Unknown/expired `sessionId` should start a new `running` session instead of reviving `closed`.

### Request handling details
- **OpenAI chunking:** While running, wrap Cursor `delta` as normal OpenAI chunks. On `exec_request`, flush any buffered partials, emit `tool_calls`, then send the `[DONE]` SSE and close the HTTP response while keeping the Cursor stream alive.
- **Tool result ingestion:** Accept `role:"tool"` messages with `tool_call_id`, map back to Cursor call id, serialize as `bidiAppend`, and resume iteration. Preserve Cursor’s `appendSeqno` ordering.
- **Graceful fallbacks:** If `tool_call_id` is malformed or session missing, start a new Cursor stream (pay bootstrap) and continue so clients never stall.

### Cleanup and timeouts
- Default idle timeout: 15m since last activity; configurable via env/flag. On timeout, close Cursor client/iterator and delete session entry.
- Force-close on repeated append failures or Cursor error frames; surface error to OpenAI client with an OpenAI-shaped error body.
- Keep session map bounded (LRU or max count) to avoid leaking streams when many windows churn.
