# Cursor API → OpenAI Compatibility Notes

This document provides a technical overview of how standard AI client requests (e.g., OpenAI format) are mapped to the Cursor API for interoperability.

## Protocol Mapping Overview

The compatibility layer translates standard JSON-based requests into the backend's preferred protocol format.

### Request Transformation

*   **Endpoint Mapping**: Standard `/v1/chat/completions` requests are routed to the corresponding backend RPCs.
*   **Header Injection**: Observed requirements for headers like `authorization`, `x-request-id`, and client identifiers are handled automatically by the shim.
*   **Body Conversion**: OpenAI-style message arrays are converted to the backend's internal representation, including role mapping (e.g., `user` → `1`, `assistant` → `2`).

### Response Normalization

*   **Streaming (SSE)**: Backend binary stream chunks are decoded and re-encoded as OpenAI-compatible Server-Sent Events (SSE).
*   **Non-streaming**: Aggregates all incoming message deltas into a single JSON response object.
*   **Finish Reasons**: Maps internal turn-end signals to standard OpenAI `finish_reason` values (e.g., `stop`, `tool_calls`).

## Tool Calling Architecture

The compatibility layer supports full tool calling by bridging the difference between the backend's persistent stream model and the client's request/response model.

### Mapping Strategy

1.  **Client Request**: The client provides a list of tools (e.g., `bash`, `read`).
2.  **Tool Request Interception**: When the backend requests tool execution, the shim translates this into an OpenAI `tool_calls` response and terminates the current HTTP stream.
3.  **Local Execution**: The client (e.g., OpenCode) executes the tool locally.
4.  **Result Integration**: The client sends a new request with the tool result. The shim integrates this result into the conversation history and continues the interaction.

### Observed Tool Mappings

| Backend Tool Type | Client Tool Name | Arguments |
|-------------------|------------------|-----------|
| `shell` | `bash` | `{ command, cwd? }` |
| `read` | `read` | `{ filePath }` |
| `ls` | `list` | `{ path }` |
| `grep` / `glob` | `grep` / `glob` | `{ pattern, path }` |
| `mcp` | Original tool name | Original arguments |

## Session Management and Performance

### Session Persistence

To reduce the overhead of repeatedly initializing new sessions, the compatibility layer can optionally maintain a persistent connection to the backend. This allows for lower latency during multi-turn interactions and complex tool-calling sequences.

### Fallback Mechanisms

*   **Session Recovery**: If a persistent session is lost or expires, the shim gracefully falls back to a fresh session, ensuring continuity for the user.
*   **Error Normalization**: Protocol-specific errors are caught and transformed into standard OpenAI error responses (JSON) to ensure compatibility with all SDKs.

## Current Limitations

*   **Usage Reporting**: Token usage is currently estimated based on common tokenization patterns.
*   **Advanced Features**: Certain backend-specific features that do not have direct equivalents in the OpenAI spec are currently omitted or handled via best-effort mapping.
