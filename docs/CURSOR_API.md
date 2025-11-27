# Cursor API Communication Reference

This document provides a comprehensive reference for communicating with Cursor's API, based on reverse-engineering the official Cursor CLI source code.

## Overview

Cursor uses **Connect-RPC** (a modern gRPC-compatible protocol) with Protocol Buffers for its API communication. The system supports both HTTP/2 (native bidirectional streaming) and HTTP/1.1 (with SSE fallback).

---

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `https://api2.cursor.sh` | Default API endpoint |
| `https://agent.api5.cursor.sh` | Agent backend (privacy mode) |
| `https://agentn.api5.cursor.sh` | Agent backend (non-privacy mode) |

### Endpoint Selection Logic

```typescript
function getAgentBackendUrl(backendUrl: string, isPrivacyMode: boolean, useNlbForNal: boolean): string {
  // Localhost/staging: use provided URL directly
  if (backendUrl.includes("localhost") || backendUrl.includes("staging.cursor.sh")) {
    return backendUrl;
  }
  
  // Production with NLB flag
  if (!useNlbForNal) return backendUrl;
  
  return isPrivacyMode 
    ? "https://agent.api5.cursor.sh" 
    : "https://agentn.api5.cursor.sh";
}
```

---

## Transport Layer

### Connect-RPC Protocol

Cursor uses the Connect protocol from Buf (https://connectrpc.com/), which is a simpler alternative to gRPC that works over HTTP/1.1 and HTTP/2.

**Key characteristics:**
- Content-Type: `application/connect+json` (JSON mode) or `application/connect+proto` (binary)
- Protocol version header: `connect-protocol-version: 1`
- Supports unary, server streaming, and bidirectional streaming

### HTTP/2 Transport (Primary)

Used when native HTTP/2 is available:

```typescript
import { createConnectTransport } from "@connectrpc/connect-node";

const transport = createConnectTransport({
  baseUrl: "https://api2.cursor.sh",
  httpVersion: "2",
  interceptors: [authInterceptor],
});
```

### HTTP/1.1 with SSE Fallback

For environments without HTTP/2 support, Cursor implements a custom `BidiSseTransport`:

```typescript
// Custom transport that uses Server-Sent Events for streaming
class BidiSseTransport {
  constructor(options: {
    baseUrl: string;
    interceptors: Interceptor[];
    useBinaryFormat: boolean;
    jsonOptions: JsonReadOptions & JsonWriteOptions;
    nodeOptions: NodeHttp1TransportOptions;
  });
}
```

### Message Framing (Connect Streaming Format)

Each message in a Connect stream is framed as:

```
[flags: 1 byte][length: 4 bytes big-endian][payload: N bytes]
```

**Flags byte:**
- `0x00` - Normal message
- `0x02` - End of stream / trailers

**Implementation:**

```typescript
function encodeEnvelope(flags: number, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(5 + data.length);
  result[0] = flags;
  // Big-endian 32-bit length
  result[1] = (data.length >> 24) & 0xff;
  result[2] = (data.length >> 16) & 0xff;
  result[3] = (data.length >> 8) & 0xff;
  result[4] = data.length & 0xff;
  result.set(data, 5);
  return result;
}

function decodeEnvelope(buffer: Uint8Array): { flags: number; data: Uint8Array } {
  const flags = buffer[0];
  const length = (buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
  const data = buffer.slice(5, 5 + length);
  return { flags, data };
}
```

---

## Authentication

### Request Headers

All authenticated requests must include:

| Header | Value | Description |
|--------|-------|-------------|
| `authorization` | `Bearer <jwt_token>` | JWT access token |
| `x-ghost-mode` | `"true"` or `"false"` | Privacy mode flag |
| `x-cursor-client-version` | `cli-2025.11.25-d5b3271` | Client version string |
| `x-cursor-client-type` | `cli` | Client type identifier |
| `x-request-id` | UUID | Unique request identifier |
| `x-cursor-streaming` | `true` | Signals SSE support (for Zscaler compatibility) |

### Auth Interceptor Pattern

```typescript
function createAuthInterceptor(
  credentialManager: CredentialManager,
  options: { baseUrl: string; configProvider: ConfigProvider }
): Interceptor {
  return (next) => async (req) => {
    // Get valid token (refresh if expiring soon)
    const token = await getValidAccessToken(credentialManager, options.baseUrl);
    
    if (token) {
      req.header.set("authorization", `Bearer ${token}`);
    }
    
    // Set ghost mode based on privacy settings
    const isGhostMode = await getGhostMode(options.configProvider);
    req.header.set("x-ghost-mode", String(isGhostMode));
    
    // Set client identifiers
    req.header.set("x-cursor-client-version", `cli-${VERSION}`);
    req.header.set("x-cursor-client-type", "cli");
    
    // Ensure request ID exists
    if (!req.header.has("x-request-id")) {
      req.header.set("x-request-id", crypto.randomUUID());
    }
    
    return next(req);
  };
}
```

### Token Expiration Check

Tokens are refreshed when they expire within 5 minutes:

```typescript
function isTokenExpiringSoon(token: string): boolean {
  // Decode JWT payload (no signature verification)
  const base64Payload = token.split(".")[1];
  const payload = JSON.parse(Buffer.from(base64Payload, "base64").toString());
  
  const currentTime = Math.floor(Date.now() / 1000);
  const expirationTime = payload.exp;
  
  // Refresh if less than 5 minutes remaining
  return expirationTime - currentTime < 300;
}

async function getValidAccessToken(
  credentialManager: CredentialManager,
  endpoint: string
): Promise<string | null> {
  const currentToken = await credentialManager.getAccessToken();
  if (!currentToken) return null;
  
  if (!isTokenExpiringSoon(currentToken)) {
    return currentToken;
  }
  
  // Attempt refresh
  const apiKey = await credentialManager.getApiKey();
  if (apiKey) {
    return await refreshTokenWithApiKey(credentialManager, endpoint);
  }
  
  return currentToken;
}
```

---

## Protobuf Services

### Agent Service (`agent.v1.AgentService`)

The primary service for agent/chat interactions with bidirectional streaming.

**Service Definition:**

```protobuf
service AgentService {
  // Bidirectional streaming RPC for agent execution
  rpc Run(stream AgentClientMessage) returns (stream AgentServerMessage);
}
```

**Key Message Types:**

```protobuf
message AgentClientMessage {
  oneof message {
    AgentRunRequest run_request = 1;
    InteractionRequest interaction_request = 2;
    // ... other message types
  }
}

message AgentServerMessage {
  oneof message {
    InteractionUpdate interaction_update = 1;
    AgentFinalResponse final_response = 2;
    // ... other message types
  }
}

message AgentRunRequest {
  string conversation_id = 1;
  repeated ConversationMessage messages = 2;
  ModelConfig model_config = 3;
  string project_path = 4;
  // ... additional fields
}

message InteractionUpdate {
  oneof update {
    TextDelta text_delta = 1;
    ToolCall tool_call = 2;
    ToolResult tool_result = 3;
    // ... other update types
  }
}
```

### AI Server Service (`aiserver.v1.AiService`)

Comprehensive service with 100+ RPC methods for various AI operations.

**Selected Methods:**

```protobuf
service AiService {
  // Chat completions
  rpc StreamingChatComposer(ChatRequest) returns (stream StreamingChatResponse);
  rpc Chat(ChatRequest) returns (ChatResponse);
  
  // Code operations
  rpc GetCodeLens(CodeLensRequest) returns (CodeLensResponse);
  rpc GetCodeActions(CodeActionsRequest) returns (CodeActionsResponse);
  
  // Privacy
  rpc GetPrivacyMode(GetPrivacyModeRequest) returns (GetPrivacyModeResponse);
  
  // ... many more methods
}
```

---

## Client Creation

### Agent Client

```typescript
import { createPromiseClient } from "@connectrpc/connect";
import { AgentService } from "./proto/agent/v1/agent_connect";

function createAgentClient(
  credentialManager: CredentialManager,
  options: {
    backendUrl: string;
    configProvider: ConfigProvider;
    insecure?: boolean;
    useNlbForNal?: boolean;
  }
) {
  const isPrivacyMode = options.configProvider.get()?.privacyCache?.isGhostMode ?? true;
  const agentUrl = getAgentBackendUrl(options.backendUrl, isPrivacyMode, options.useNlbForNal);
  
  const transport = createConnectTransport({
    baseUrl: agentUrl,
    httpVersion: "2",
    interceptors: [
      createAuthInterceptor(credentialManager, options),
    ],
  });
  
  return createPromiseClient(AgentService, transport);
}
```

### AI Server Client

```typescript
import { AiService } from "./proto/aiserver/v1/aiserver_connect";

function createAiServerClient(
  credentialManager: CredentialManager,
  options: { backendUrl: string; configProvider: ConfigProvider }
) {
  const transport = createConnectTransport({
    baseUrl: options.backendUrl,
    httpVersion: "1.1", // Uses HTTP/1.1 for compatibility
    interceptors: [
      createAuthInterceptor(credentialManager, options),
    ],
  });
  
  return createPromiseClient(AiService, transport);
}
```

---

## Bidirectional Streaming Pattern

### Using HTTP/2

```typescript
async function runAgent(client: AgentClient, request: AgentRunRequest) {
  // Create async iterable for client messages
  async function* clientMessages() {
    yield { runRequest: request };
    
    // Yield additional messages as needed (e.g., tool results)
    // ...
  }
  
  // Call the streaming RPC
  const serverStream = client.run(clientMessages());
  
  // Process server responses
  for await (const message of serverStream) {
    if (message.interactionUpdate) {
      const update = message.interactionUpdate;
      
      if (update.textDelta) {
        process.stdout.write(update.textDelta.text);
      } else if (update.toolCall) {
        console.log("Tool call:", update.toolCall);
      }
    } else if (message.finalResponse) {
      console.log("Agent completed");
      break;
    }
  }
}
```

### Using HTTP/1.1 + SSE

When HTTP/2 is not available, the `BidiSseTransport` simulates bidirectional streaming:

1. **Client → Server**: Regular HTTP POST with JSON/protobuf body
2. **Server → Client**: Server-Sent Events stream

```typescript
// SSE response format
// Content-Type: text/event-stream

// Each event contains a Connect-framed message
data: <base64-encoded envelope>

data: <base64-encoded envelope>

// End of stream
event: end
data:
```

---

## Error Handling

### Connect Error Format

```typescript
interface ConnectError {
  code: ConnectCode;
  message: string;
  details?: Any[];
}

// Common error codes
enum ConnectCode {
  Canceled = 1,
  Unknown = 2,
  InvalidArgument = 3,
  DeadlineExceeded = 4,
  NotFound = 5,
  AlreadyExists = 6,
  PermissionDenied = 7,
  ResourceExhausted = 8,
  FailedPrecondition = 9,
  Aborted = 10,
  OutOfRange = 11,
  Unimplemented = 12,
  Internal = 13,
  Unavailable = 14,
  DataLoss = 15,
  Unauthenticated = 16,
}
```

### Binary Error Detection

Errors in binary streams start with a specific header:

```typescript
function isErrorResponse(buffer: Uint8Array): boolean {
  // Error responses start with flags=0x02 (end-stream with trailers)
  return buffer[0] === 0x02;
}

function parseErrorTrailers(buffer: Uint8Array): ConnectError {
  // Skip 5-byte envelope header
  const trailersJson = new TextDecoder().decode(buffer.slice(5));
  const trailers = JSON.parse(trailersJson);
  
  return {
    code: trailers["connect-error-code"],
    message: trailers["connect-error-message"],
  };
}
```

---

## Privacy Mode

Privacy mode affects which backend endpoint is used and what data is stored.

### Privacy Modes

| Value | Mode | Ghost Mode | Description |
|-------|------|------------|-------------|
| 0 | UNSPECIFIED | true | Default, assume private |
| 1 | NO_STORAGE | true | No conversation storage |
| 2 | NO_TRAINING | true | No model training |
| 3+ | Other | false | Standard mode |

### Fetching Privacy Mode

```typescript
async function fetchPrivacyMode(client: AiServiceClient): Promise<number> {
  const response = await client.getPrivacyMode({});
  return response.privacyMode;
}

function isGhostMode(privacyMode: number): boolean {
  return privacyMode <= 2; // UNSPECIFIED, NO_STORAGE, or NO_TRAINING
}
```

---

## Complete Example

```typescript
import { createConnectTransport } from "@connectrpc/connect-node";
import { createPromiseClient } from "@connectrpc/connect";
import { AgentService } from "./proto/agent/v1/agent_connect";

async function main() {
  // Configuration
  const API_ENDPOINT = "https://api2.cursor.sh";
  const ACCESS_TOKEN = "your_jwt_token_here";
  
  // Create transport with auth
  const transport = createConnectTransport({
    baseUrl: API_ENDPOINT,
    httpVersion: "2",
    interceptors: [
      (next) => async (req) => {
        req.header.set("authorization", `Bearer ${ACCESS_TOKEN}`);
        req.header.set("x-ghost-mode", "true");
        req.header.set("x-cursor-client-version", "cli-2025.01.01");
        req.header.set("x-cursor-client-type", "cli");
        req.header.set("x-request-id", crypto.randomUUID());
        return next(req);
      },
    ],
  });
  
  // Create client
  const client = createPromiseClient(AgentService, transport);
  
  // Prepare request
  const request = {
    conversationId: crypto.randomUUID(),
    messages: [
      {
        role: "user",
        content: "Hello, how are you?",
      },
    ],
    modelConfig: {
      modelName: "claude-3.5-sonnet",
    },
    projectPath: "/path/to/project",
  };
  
  // Stream the response
  async function* clientStream() {
    yield { runRequest: request };
  }
  
  try {
    for await (const message of client.run(clientStream())) {
      if (message.interactionUpdate?.textDelta) {
        process.stdout.write(message.interactionUpdate.textDelta.text);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
```

---

## Dependencies

To implement Cursor API communication, you'll need:

```json
{
  "dependencies": {
    "@connectrpc/connect": "^1.4.0",
    "@connectrpc/connect-node": "^1.4.0",
    "@bufbuild/protobuf": "^1.10.0"
  }
}
```

Generate TypeScript types from `.proto` files using:

```bash
npx buf generate
```

---

## References

- [Connect-RPC Documentation](https://connectrpc.com/docs/introduction)
- [Protocol Buffers](https://protobuf.dev/)
- [Buf Build](https://buf.build/)
- Source files analyzed:
  - `cursor-agent-restored-source-code/src/client.ts`
  - `cursor-agent-restored-source-code/src/fetch-transport.ts`
  - `cursor-agent-restored-source-code/proto/dist/generated/agent/v1/`
  - `cursor-agent-restored-source-code/bidi-connect/dist/index.js`
