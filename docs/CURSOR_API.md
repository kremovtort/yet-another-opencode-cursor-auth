# Cursor API Communication Reference

This document provides a technical reference for communicating with Cursor's API, detailing the observed protocol behavior and requirements for interoperability.

## Overview

The Cursor API utilizes **Connect-RPC** (a modern gRPC-compatible protocol) with Protocol Buffers for communication. The system supports both HTTP/2 (native bidirectional streaming) and HTTP/1.1 (typically with SSE fallback).

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `https://api2.cursor.sh` | Default API endpoint |
| `https://agent.api5.cursor.sh` | Specialized agent backend (privacy-enabled) |
| `https://agentn.api5.cursor.sh` | Specialized agent backend (standard) |

## Transport Layer

### Connect-RPC Protocol

The API follows the Connect protocol (https://connectrpc.com/), which is a gRPC-compatible protocol designed to work over standard HTTP/1.1 and HTTP/2.

**Key characteristics:**
- Content-Type: `application/connect+json` (JSON mode) or `application/connect+proto` (binary)
- Protocol version header: `connect-protocol-version: 1`
- Supports unary, server streaming, and bidirectional streaming RPCs.

### Message Framing (Connect Streaming Format)

Messages in a Connect stream are enveloped with a 5-byte header:

```
[flags: 1 byte][length: 4 bytes big-endian][payload: N bytes]
```

**Flags byte:**
- `0x00` - Normal message
- `0x02` - End of stream / trailers (contains error metadata in JSON if an error occurred)

## Authentication

### Request Headers

Authenticated requests require several specific headers for identification and authorization:

| Header | Value | Description |
|--------|-------|-------------|
| `authorization` | `Bearer <jwt_token>` | JWT access token |
| `x-ghost-mode` | `"true"` or `"false"` | Privacy mode flag |
| `x-cursor-client-version` | `cli-<version>` | Client version identifier |
| `x-cursor-client-type` | `cli` | Client type identifier |
| `x-request-id` | UUID | Unique request identifier |
| `x-cursor-streaming` | `true` | Signals SSE support for streaming fallbacks |

### Token Lifecycle

Tokens are validated based on their JWT payload. It is standard practice to refresh tokens when they are within a short window (e.g., 5 minutes) of their `exp` (expiration) timestamp.

## Protocol Buffers and Services

The API exposes several services via gRPC/Connect:

### Agent Service (`agent.v1.AgentService`)
Handles long-running agent interactions and complex chat tasks, typically using bidirectional streaming.

### AI Server Service (`aiserver.v1.AiService`)
A comprehensive service for various AI operations, including chat completions, code analysis, and privacy settings management.

## Implementation Patterns

### Bidirectional Streaming

For tools supporting bidirectional streaming (like HTTP/2), the client and server exchange a continuous stream of messages. The client sends a request (e.g., `AgentRunRequest`) and the server responds with updates (e.g., `TextDelta` or `ToolCall`).

### SSE Fallback (HTTP/1.1)

In environments where HTTP/2 is unavailable, the protocol can fall back to Server-Sent Events (SSE). In this mode:
1. The client sends a POST request with the framed message.
2. The server responds with a `text/event-stream` where each `data:` chunk contains a base64-encoded framed message.

## Error Handling

Errors in the Connect protocol are communicated either via standard HTTP status codes (for unary calls) or via the end-of-stream envelope (flags `0x02`) in streaming calls. The error metadata is typically a JSON object containing a `connect-error-code` and `connect-error-message`.

## Privacy and Data Handling

The API respects privacy settings through a "Ghost Mode" toggle. This mode determines whether the request is processed with conversation storage and training enabled or disabled. This choice often dictates which backend endpoint (`agent.api5` vs `agentn.api5`) is utilized.
