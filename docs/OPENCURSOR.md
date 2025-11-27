# OpenCursor Architecture Documentation

OpenCursor is a lightweight proxy server that converts Cursor AI Editor API calls into OpenAI-compatible format, enabling any OpenAI SDK client to use Cursor's AI backend.

> **Purpose**: Research and learning only. Not for commercial use.

## Project Overview

**Repository**: [GitHub](https://github.com/yokingma/OpenCursor) | [腾讯CNB](https://cnb.cool/aigc/OpenCursor)

**Technology Stack**:
- **Runtime**: Node.js 20+
- **Framework**: Koa.js with Router
- **Serialization**: Protocol Buffers (protobufjs)
- **Validation**: Joi
- **Logging**: Winston

---

## Project Structure

```
OpenCursor/
├── .devops/
│   └── Dockerfile              # Docker deployment configuration
├── src/
│   ├── provider/
│   │   ├── cursor.ts          # Core Cursor API integration (main logic)
│   │   └── message.proto      # Protobuf schema for Cursor API
│   ├── app.ts                 # Main Koa server entry point
│   ├── config.ts              # Environment configuration
│   ├── interface.ts           # TypeScript interfaces (OpenAI format)
│   ├── logger.ts              # Winston logging setup
│   ├── middleware.ts          # Token extraction middleware
│   ├── utils.ts               # Utility functions (hash, UUID)
│   └── validator.ts           # Joi request validation
├── .env                       # Environment variables
├── package.json               # Dependencies and scripts
└── README.md                  # Documentation (Chinese)
```

---

## Architecture Overview

### Request Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  OpenAI Client  │────▶│   OpenCursor    │────▶│  Cursor API     │
│  (Any SDK)      │     │   (Koa Server)  │     │  api2.cursor.sh │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                       │
         │              ┌───────┼───────┐               │
         ▼              ▼       ▼       ▼               ▼
   OpenAI Format   Validator  Convert  Decode    Protobuf Binary
   JSON Request     (Joi)    (Proto)  (Proto)    Stream Response
```

### Data Transformation Pipeline

```
1. OpenAI Request (JSON)
   ↓
2. Joi Validation (src/validator.ts)
   ↓
3. Convert to Protobuf (src/provider/cursor.ts:121-172)
   ↓
4. Cursor API Call (Connect-RPC protocol)
   ↓
5. Binary Stream Response
   ↓
6. Decode Protobuf Chunks (src/provider/cursor.ts:227-260)
   ↓
7. OpenAI Response (JSON or SSE)
```

---

## Core Components

### 1. API Endpoint (`src/app.ts`)

Single endpoint implementation:

```typescript
// POST /v1/chat/completions
router.post('/chat/completions', async (ctx) => {
  const data = validateRequest(ctx);
  const { model, messages, system, stream = false } = data;
  const token = ctx.state.token as string;

  if (!stream) {
    // Non-streaming: return complete JSON response
    const response = await fetchCursor(token, { model, messages, system });
    ctx.body = response;
    return;
  }

  // Streaming: SSE response
  ctx.res.setHeader('Content-Type', 'text/event-stream');
  ctx.res.setHeader('Cache-Control', 'no-cache');
  ctx.res.setHeader('Connection', 'keep-alive');

  await fetchCursor(token, { model, messages, system }, (msg) => {
    ctx.res.write(`data: ${JSON.stringify(msg)}\n\n`);
  });
  ctx.res.write('data: [DONE]\n\n');
  ctx.res.end();
});
```

### 2. Request Transformation (`src/provider/cursor.ts:121-172`)

Converts OpenAI format to Cursor's internal format:

```typescript
async function convertRequest(request: OpenAIRequest) {
  const { messages, model, system } = request;
  
  // Role mapping: user → 1, assistant → 2
  const formattedMessages = messages.map((message) => {
    let content = '';
    if (Array.isArray(message.content)) {
      // Handle multimodal content (text + images)
      content = message.content.map((item) => {
        if (item.text) return item.text;
        if (item.image_url?.url) return `![image](${item.image_url.url})`;
        return '';
      }).join('');
    } else {
      content = message.content;
    }
    return {
      messageId: genUUID(),
      role: message.role === 'user' ? 1 : 2,
      content,
    };
  });

  const cursorMessages = {
    messages: formattedMessages,
    instructions: { instruction: system ?? '' },
    projectPath: '/path/to/project',
    model: { name: model, empty: '' },
    requestId: genUUID(),
    summary: '',
    conversationId: genUUID(),
  };

  // Encode to protobuf
  const ChatMessage = root.lookupType('cursor.ChatMessage');
  const message = ChatMessage.create(cursorMessages);
  const protoBytes = ChatMessage.encode(message).finish();
  
  // Add header (1 byte magic + 4 bytes length)
  const header = int32ToBytes(0, protoBytes.byteLength);
  return Buffer.concat([header, protoBytes]);
}
```

### 3. Protobuf Schema (`src/provider/message.proto`)

Defines the message structure for Cursor API:

```protobuf
syntax = "proto3";
package cursor;

message ChatMessage {
  message UserMessage {
    string content = 1;
    int32 role = 2;           // 1 = user, 2 = assistant
    string message_id = 13;
  }

  message Instructions {
    string instruction = 1;   // System prompt
  }

  message Model {
    string name = 1;          // e.g., "gpt-4o"
    string empty = 4;
  }

  repeated UserMessage messages = 2;
  Instructions instructions = 4;
  string projectPath = 5;
  Model model = 7;
  string requestId = 9;
  string summary = 11;
  string conversationId = 15;
}

message ResMessage {
  string msg = 1;             // Response text chunk
}
```

### 4. Response Decoding (`src/provider/cursor.ts:227-260`)

Decodes binary stream from Cursor API:

```typescript
export function bytesToString(buffer: ArrayBufferLike) {
  const ErrorStartHex = '02000001';
  const hex = Buffer.from(buffer).toString('hex');

  // Check for error response
  if (hex.startsWith(ErrorStartHex)) {
    const error = decodeErrorBytes(buffer);
    throw new Error(error);
  }

  // Parse message chunks
  let offset = 0;
  const results: string[] = [];

  while (offset < hex.length) {
    // Read 5-byte header (length)
    const dataLength = parseInt(hex.slice(offset, offset + 10), 16);
    offset += 10;

    // Read message body
    const messageHex = hex.slice(offset, offset + dataLength * 2);
    offset += dataLength * 2;

    // Decode protobuf message
    const messageBuffer = Buffer.from(messageHex, 'hex');
    const message = root.lookupType('cursor.ResMessage')
      .decode(messageBuffer) as { msg: string };
    if (message.msg) results.push(message.msg);
  }

  return results.join('');
}
```

---

## Authentication Mechanism

### Token Source

Users provide the `WorkosCursorSessionToken` cookie from Cursor's web interface:

1. Open Cursor web editor and log in
2. Open Developer Tools → Application → Cookies
3. Copy `WorkosCursorSessionToken` value
4. Use as `API_KEY` in requests

### Token Processing (`src/provider/cursor.ts:34-41`)

```typescript
let token = cookie;

// Token format: "prefix::jwt_token" (URL-encoded or plain)
if (cookie.includes('%3A%3A')) {
  token = cookie.split('%3A%3A')[1];  // URL-encoded ::
} else if (cookie.includes('::')) {
  token = cookie.split('::')[1];
}
```

### Checksum Generation (`src/provider/cursor.ts:179-215`)

Generates a device fingerprint for Cursor API:

```typescript
export function genChecksum(token: string): string {
  // Use configured checksum or generate dynamically
  if (defaultChecksum) return defaultChecksum;

  const salt = token.split('.');
  
  // XOR-based obfuscation
  const calc = (data: Buffer) => {
    let t = 165;
    for (let i = 0; i < data.length; i++) {
      data[i] = (data[i] ^ t) + i;
      t = data[i];
    }
  };

  // Timestamp rounded to 30-minute intervals
  const now = new Date();
  now.setMinutes(30 * Math.floor(now.getMinutes() / 30), 0, 0);
  const timestamp = Math.floor(now.getTime() / 1e6);

  // Create checksum buffer
  const timestampBuffer = Buffer.alloc(6);
  // ... encode timestamp bytes

  calc(timestampBuffer);

  const hex1 = calcHex(salt[1]);      // SHA-256 of token part
  const hex2 = calcHex(token);         // SHA-256 of full token

  return `${Buffer.from(timestampBuffer).toString('base64url')}${hex1}/${hex2}`;
}
```

### Request Headers (`src/provider/cursor.ts:48-59`)

```typescript
const options: RequestInit = {
  method: 'POST',
  headers: {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    'connect-accept-encoding': 'gzip,br',
    'connect-protocol-version': '1',
    'user-agent': 'connect-es/1.4.0',
    'x-cursor-checksum': checksum,         // Device fingerprint
    'x-cursor-client-version': '0.42.3',   // Spoofed version
    'x-cursor-timezone': 'Asia/Shanghai',
    'host': 'api2.cursor.sh'
  },
  body: protoBytes,
};
```

---

## Request/Response Formats

### OpenAI-Compatible Request

```typescript
interface OpenAIRequest {
  model: string;                    // e.g., "gpt-4o"
  messages: OpenAIChatMessage[];
  system?: string;                  // Optional system prompt
  stream?: boolean;                 // Streaming mode
  temperature?: number;
  response_format?: {
    type: 'json_object' | 'json_schema' | 'text';
    schema?: object;
  };
}

interface OpenAIChatMessage {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  content: string | OpenAIImageMessageContent[];
}
```

### Non-Streaming Response

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [{
    "index": 0,
    "message": { "content": "..." }
  }]
}
```

### Streaming Response (SSE)

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":" world"}}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## Validation Schema (`src/validator.ts`)

```typescript
const schema = Joi.object<OpenAIRequest>({
  stream: Joi.boolean().default(false).optional(),
  model: Joi.string().required(),
  system: Joi.string().optional(),
  temperature: Joi.number().optional(),
  messages: Joi.array().items(
    Joi.object({
      role: Joi.string().equal('user', 'assistant', 'system', 'developer', 'tool'),
      content: Joi.alternatives().try(
        Joi.string().allow(''),
        Joi.array().items(/* image content schema */)
      ),
    })
  ).required(),
  response_format: Joi.object({
    type: Joi.string().equal('json_object', 'json_schema', 'text'),
    schema: Joi.object().optional(),
  }).optional(),
}).unknown(true);
```

---

## Error Handling

### Error Detection (`src/provider/cursor.ts:231-234`)

```typescript
const ErrorStartHex = '02000001';
const hex = Buffer.from(buffer).toString('hex');

if (hex.startsWith(ErrorStartHex)) {
  const error = decodeErrorBytes(buffer);
  throw new Error(error);
}
```

### Error Decoding (`src/provider/cursor.ts:265-268`)

```typescript
export function decodeErrorBytes(buffer: ArrayBufferLike) {
  const buf = Buffer.from(buffer.slice(5));  // Skip 5-byte header
  return buf.toString('utf-8');
}
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `CURSOR_URL` | Cursor API endpoint | (configured) |
| `CURSOR_CHECKSUM` | Pre-configured device checksum | (auto-generated) |

### Docker Deployment

```dockerfile
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/.env ./
RUN npm install --production
EXPOSE 3000
CMD ["npm", "run", "start"]
```

---

## Usage Example

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'WorkosCursorSessionToken_value_here',
  baseURL: 'http://127.0.0.1:3000/v1',
});

// Non-streaming
const completion = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Say hello' }],
});

// Streaming
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Say hello' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## Key Implementation Details

1. **Connect-RPC Protocol**: Uses Cursor's internal Connect-RPC with protobuf encoding

2. **Binary Stream Parsing**: Response bytes follow format:
   - First 5 bytes: header (1 byte flags + 4 bytes length)
   - Remaining: protobuf-encoded message chunks

3. **Role Mapping**:
   - `user` → `1`
   - `assistant` → `2`

4. **Image Handling**: Converted to Markdown format `![image](url)`

5. **Session Token**: Obtained from browser cookie `WorkosCursorSessionToken`

6. **Rate Limiting**: Relies on Cursor's built-in limits (no additional throttling)

---

## Security Considerations

1. **Token Security**: Never expose `WorkosCursorSessionToken` publicly
2. **Local Use Only**: Designed for personal development, not production
3. **No Token Storage**: Tokens are passed per-request, not stored
4. **CORS Enabled**: Accepts requests from any origin (development mode)

---

## Limitations

1. **Image Input**: Images are converted to Markdown, actual vision not supported
2. **Single Endpoint**: Only `/v1/chat/completions` implemented
3. **No Authentication Caching**: Token validated on every request
4. **Research Only**: Not intended for commercial use
