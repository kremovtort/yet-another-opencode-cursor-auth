# Tool Calling Implementation Overview

This document outlines how tool calling is implemented and optimized for interoperability between standard AI clients and the Cursor API.

## Core Strategy: Request-Based Context

The compatibility layer translates tool-calling interactions by utilizing a per-request session model. This ensures reliable streaming and consistent behavior across all client types.

### Interaction Flow

1.  **Initial Request**: The client sends a chat request along with a list of available tools (e.g., `bash`, `read`, `write`).
2.  **Tool Call Detection**: When the backend identifies that a tool needs to be executed, it sends a specific interaction request.
3.  **Client-Side Execution**: The compatibility layer translates this into a standard `tool_calls` response for the client (e.g., OpenCode). The client then executes the tool locally.
4.  **Context Resubmission**: After the tool is executed, the client sends a new request containing the updated conversation history, including the tool result.
5.  **Continuation**: The backend receives the full context and continues generating the assistant's response.

## Tool Mapping

Observed backend action types are mapped to standard client-side tool names:

| Backend Action Type | Client Tool Name | Description |
|---------------------|------------------|-------------|
| `shell` | `bash` | Execute shell commands |
| `read` | `read` | Read file contents |
| `write` | `write` | Write or update files |
| `ls` | `list` | List directory contents |
| `grep` / `glob` | `grep` / `glob` | Search or pattern matching |
| `mcp` | Original Name | Passthrough for MCP tools |

## Technical Implementation Details

### Session Management

While the backend protocol supports long-lived bidirectional streams, the compatibility layer primarily uses a fresh session for each interaction turn. This approach has been found to be the most reliable for several reasons:

*   **Reliable Streaming**: Fresh sessions consistently trigger immediate response streaming from the backend.
*   **Context Ownership**: Standard clients typically manage conversation state, and resubmitting this state ensures the model always has the complete, up-to-date context.
*   **Turn Boundaries**: This model provides clear boundaries for when a turn starts and ends, simplifying error handling and response normalization.

### Performance Optimization

To minimize the impact of session initialization:
*   **Model Reuse**: The system tracks and reuses model configurations across sessions where possible.
*   **Parallel Execution**: The plugin architecture is designed to handle multiple concurrent requests efficiently.

## Multi-Step Tool Flows

The system is designed to handle complex, multi-step tasks (e.g., "Read this file, then update that one"). The model is provided with the tool list in every request, allowing it to decide whether to call additional tools or finalize its response with text based on the tool results provided in the conversation history.

## Error Handling and Fallbacks

In cases where a tool execution fails or the backend returns an error during a tool-calling sequence, the compatibility layer normalizes these into standard error responses. This ensures that the client's execution flow remains robust even when encountering unexpected protocol states.
