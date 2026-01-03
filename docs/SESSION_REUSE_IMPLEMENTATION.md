# Session Reuse Implementation Guide

**Date**: January 2, 2026  
**Status**: ⚠️ Limited - True session reuse not possible due to API mismatch

## Executive Summary

**True session reuse across OpenAI API requests is not possible** due to a fundamental architectural mismatch between OpenAI's request/response model and Cursor's bidirectional streaming protocol.

### The Core Problem

| Aspect | OpenAI API | Cursor Bidirectional |
|--------|------------|---------------------|
| Model | Request → Response (HTTP) | Continuous stream |
| Tool calls | Response ends, new request with results | Stream stays open, results sent inline |
| Context | Full history in each request | Server maintains context |

When Cursor's model requests a tool call, the OpenAI API **must close the HTTP response** to return `tool_calls` to the client. The client then sends a **new HTTP request** with tool results. This breaks the continuous streaming context that Cursor's `bidiAppend` relies on.

### What Works

Tool call continuation works via a **workaround**: when tool results arrive, we close any existing session and start a completely fresh request with the full conversation history (including prior tool calls and results) formatted via `messagesToPrompt()`.

### What Doesn't Work

- **True session reuse**: Keeping a single bidirectional stream open across multiple OpenAI API requests
- **BidiAppend tool results**: Server acknowledges receipt but doesn't continue generating

## Current Implementation

### Behavior (Default: `CURSOR_SESSION_REUSE=1`)

1. **First request**: Creates new Cursor session, streams response
2. **Tool call emitted**: Session saved with `pendingExecs`, HTTP response closes with `tool_calls`
3. **Follow-up request with tool results**: 
   - Detects tool messages in request
   - **Closes old session** (not reused)
   - Creates **fresh session** with full history via `messagesToPrompt()`
   - Server processes as new conversation with context

### Why This Works

The `messagesToPrompt()` function in `src/lib/openai-compat/utils.ts` formats the full conversation including:
- System messages
- User messages  
- Assistant messages (including `tool_calls`)
- Tool result messages

The Cursor server receives this as a complete conversation context and continues appropriately.

### Disabling Session Reuse

```bash
CURSOR_SESSION_REUSE=0 bun run src/server.ts
```

When disabled, the simpler non-session-reuse code path is used (no `sessionMap`, no session tracking).

## Investigation History

### What We Tried

1. **BidiAppend with tool results**: Sent tool results via `bidiAppend` to existing stream
   - Server acknowledged with `tool_call_completed`
   - Server sent only heartbeats afterward, no text continuation

2. **ResumeAction after tool results**: Sent `ConversationAction.resumeAction` per Cursor CLI pattern
   - No effect on server behavior

3. **Various header combinations**: Tried different `x-cursor-*` headers
   - No change in behavior

### Why True Session Reuse Fails

The Cursor CLI maintains a **continuous bidirectional stream**:
```
[CLI] → bidiStart → [Server]
[CLI] ← streaming response ← [Server]
[CLI] → tool result via bidiAppend → [Server]
[CLI] ← continued streaming ← [Server]  ← This happens because stream never closed
```

Our OpenAI-compat layer must:
```
[Client] → POST /chat/completions → [Proxy]
[Proxy] → bidiStart → [Server]
[Proxy] ← streaming → [Server]
[Proxy] → SSE with tool_calls → [Client]
[Client] → NEW POST with results → [Proxy]  ← New HTTP request!
[Proxy] → bidiAppend to old stream → [Server]
[Server] → heartbeat only, no text ← [Server]  ← Stream context lost
```

The fundamental issue: **closing the HTTP response to return tool_calls breaks the streaming context**.

## Code Structure

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/session-reuse.ts` | Session utilities, type definitions, architectural docs |
| `src/lib/openai-compat/handler.ts` | Main request handler with session logic |
| `src/lib/openai-compat/utils.ts` | `messagesToPrompt()` for history formatting |
| `src/lib/api/agent-service.ts` | Cursor API client with `bidiAppend`, `sendToolResult`, etc. |

### Session Flow (Simplified)

```typescript
// handler.ts - streamChatCompletionWithSessionReuse()

// 1. Check for existing session
const existingSessionId = findSessionIdInMessages(messages);
const toolMessages = collectToolMessages(messages);

// 2. If tool results present AND session exists → close old, start fresh
if (toolMessages.length > 0 && session) {
  await session.iterator.return?.();
  sessionMap.delete(sessionId);
  session = undefined;
  sessionId = createSessionId();
}

// 3. Create new session with full history
if (!session) {
  const iterator = client.chatStream({ 
    message: prompt,  // Full history via messagesToPrompt()
    model, 
    tools 
  });
  session = { id: sessionId, iterator, ... };
}
```

## Retained Infrastructure

The following are retained but not actively used for cross-request session reuse:

| Component | Why Retained |
|-----------|--------------|
| `sessionMap` | Internal read handling during edit flows |
| `pendingExecs` | Potential future improvements |
| `makeToolCallId()` | Tool call ID generation with session encoding |
| `sendToolResultsToCursor()` | Reference implementation, tested |

## Performance Implications

### Current (Fresh Request) Approach
- **Latency**: ~3-6s bootstrap per request (SSE connection setup)
- **Tokens**: Full history sent each request (higher token usage)
- **Reliability**: High - each request is independent

### Theoretical True Session Reuse (Not Achievable)
- **Latency**: ~100-500ms for continuation (bidiAppend only)
- **Tokens**: Incremental (lower token usage)
- **Reliability**: Would require maintaining long-lived streams

## Testing

```bash
# Run all tests
bun test

# Run session-reuse specific tests
bun test tests/unit/session-reuse.test.ts

# Test harness for tool call flows
bun run scripts/session-reuse-harness.ts
```

## Future Possibilities

True session reuse might become possible if:

1. **Cursor changes their API** to support stateless tool result injection
2. **We discover missing protocol elements** that enable continuation
3. **Alternative transport** (WebSocket with custom framing) is implemented

For now, the fresh-request-with-history approach is reliable and functional.

## References

- Cursor CLI source: `cursor-agent-restored-source-code/`
- Session utilities: `src/lib/session-reuse.ts` (includes detailed architectural comment)
- Test harness: `scripts/session-reuse-harness.ts`
