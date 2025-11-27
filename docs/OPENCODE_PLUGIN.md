# OpenCode Plugin Architecture Documentation

This document describes the OpenCode plugin system based on analysis of the `opencode-openai-codex-auth` project, which implements OAuth authentication for OpenAI Codex CLI.

> **Reference**: [opencode-openai-codex-auth](https://github.com/example/opencode-openai-codex-auth)

## Overview

OpenCode plugins extend the CLI's capabilities by providing:
- Custom authentication flows (OAuth, API keys, tokens)
- Request/response transformation
- Model mapping and normalization
- Custom prompts and system instructions

---

## Plugin Interface

### Core Types

```typescript
// From @opencode-ai/plugin
export interface Plugin {
  name: string;
  auth: Auth;
  transformRequest?: (request: Request) => Promise<Request>;
  transformResponse?: (response: Response) => Promise<Response>;
}

export interface PluginInput {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  // Additional configuration options
}

export interface Auth {
  type: 'oauth' | 'api-key' | 'token';
  getCredentials: () => Promise<Credentials>;
  refreshCredentials?: () => Promise<Credentials>;
  clearCredentials?: () => Promise<void>;
}

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}
```

### Plugin Entry Point

```typescript
// index.ts - Plugin factory function
import { Plugin, PluginInput, Auth } from "@opencode-ai/plugin";
import { createAuth } from "./lib/auth";
import { transformRequest, transformResponse } from "./lib/request";

export default function createPlugin(input: PluginInput): Plugin {
  return {
    name: "openai-codex",
    auth: createAuth(input),
    transformRequest: (req) => transformRequest(req, input),
    transformResponse: (res) => transformResponse(res, input),
  };
}
```

---

## Authentication System

### OAuth PKCE Flow

The plugin implements OAuth 2.0 with PKCE (Proof Key for Code Exchange) for secure authentication.

#### Flow Diagram

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   CLI       │     │  Browser    │     │  Auth Server│
│  (Plugin)   │     │             │     │  (OpenAI)   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │  1. Generate PKCE │                   │
       │  code_verifier    │                   │
       │  code_challenge   │                   │
       │                   │                   │
       │  2. Open auth URL─┼──────────────────▶│
       │                   │  3. User login    │
       │                   │◀─────────────────▶│
       │                   │                   │
       │  4. Callback with │                   │
       │◀──auth_code───────┼───────────────────│
       │                   │                   │
       │  5. Exchange code─┼──────────────────▶│
       │  + code_verifier  │                   │
       │                   │                   │
       │  6. Access token ◀┼───────────────────│
       │  + Refresh token  │                   │
       ▼                   ▼                   ▼
```

#### Implementation

```typescript
// lib/auth/oauth.ts
import crypto from "crypto";
import open from "open";
import http from "http";

const AUTH_ENDPOINT = "https://auth.openai.com/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "codex-cli";
const REDIRECT_PORT = 8484;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

function generatePKCE(): PKCEPair {
  // Generate 32-byte random verifier
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  
  // SHA-256 hash of verifier, base64url encoded
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  
  return { codeVerifier, codeChallenge };
}

async function startOAuthFlow(): Promise<Credentials> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");
  
  // Build authorization URL
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  
  // Start local server to receive callback
  const authCode = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        
        if (returnedState !== state) {
          reject(new Error("State mismatch"));
          return;
        }
        
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authentication successful! You can close this window.</h1>");
        server.close();
        resolve(code!);
      }
    });
    
    server.listen(REDIRECT_PORT);
    open(authUrl.toString());
  });
  
  // Exchange code for tokens
  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: authCode,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  
  const tokens = await tokenResponse.json();
  
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}
```

### Token Storage

```typescript
// lib/auth/storage.ts
import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";

const CONFIG_DIR = join(homedir(), ".opencode");
const TOKEN_FILE = join(CONFIG_DIR, "codex-auth.json");

interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(credentials, null, 2), "utf-8");
}

async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const data = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function clearCredentials(): Promise<void> {
  try {
    await unlink(TOKEN_FILE);
  } catch {
    // Ignore if file doesn't exist
  }
}
```

### Token Refresh

```typescript
// lib/auth/refresh.ts
async function refreshAccessToken(refreshToken: string): Promise<Credentials> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  
  if (!response.ok) {
    throw new Error("Token refresh failed");
  }
  
  const tokens = await response.json();
  
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

function isTokenExpiringSoon(expiresAt: number): boolean {
  // Refresh if expires in less than 5 minutes
  const BUFFER_MS = 5 * 60 * 1000;
  return Date.now() + BUFFER_MS >= expiresAt;
}
```

### Auth Factory

```typescript
// lib/auth/index.ts
import { Auth, PluginInput, Credentials } from "@opencode-ai/plugin";
import { startOAuthFlow } from "./oauth";
import { loadCredentials, saveCredentials, clearCredentials } from "./storage";
import { refreshAccessToken, isTokenExpiringSoon } from "./refresh";

export function createAuth(input: PluginInput): Auth {
  let cachedCredentials: Credentials | null = null;
  
  return {
    type: "oauth",
    
    async getCredentials(): Promise<Credentials> {
      // Check cache first
      if (cachedCredentials && !isTokenExpiringSoon(cachedCredentials.expiresAt!)) {
        return cachedCredentials;
      }
      
      // Try to load from storage
      let stored = await loadCredentials();
      
      if (stored) {
        // Refresh if expiring soon
        if (stored.expiresAt && isTokenExpiringSoon(stored.expiresAt)) {
          if (stored.refreshToken) {
            stored = await refreshAccessToken(stored.refreshToken);
            await saveCredentials(stored);
          } else {
            // No refresh token, need to re-authenticate
            stored = null;
          }
        }
      }
      
      // If no valid credentials, start OAuth flow
      if (!stored) {
        stored = await startOAuthFlow();
        await saveCredentials(stored);
      }
      
      cachedCredentials = stored;
      return stored;
    },
    
    async refreshCredentials(): Promise<Credentials> {
      const stored = await loadCredentials();
      if (!stored?.refreshToken) {
        throw new Error("No refresh token available");
      }
      
      const refreshed = await refreshAccessToken(stored.refreshToken);
      await saveCredentials(refreshed);
      cachedCredentials = refreshed;
      return refreshed;
    },
    
    async clearCredentials(): Promise<void> {
      cachedCredentials = null;
      await clearCredentials();
    },
  };
}
```

---

## Request Transformation

### Model Mapping

```typescript
// lib/request/models.ts
const MODEL_MAP: Record<string, string> = {
  // Normalize common aliases
  "gpt-4": "gpt-4-turbo",
  "gpt-4o": "gpt-4o-2024-08-06",
  "gpt-4-turbo": "gpt-4-turbo-2024-04-09",
  "gpt-3.5-turbo": "gpt-3.5-turbo-0125",
  "claude-3-opus": "claude-3-opus-20240229",
  "claude-3-sonnet": "claude-3-5-sonnet-20241022",
  
  // Codex-specific models
  "codex": "codex-davinci-002",
  "code-davinci": "code-davinci-002",
};

export function normalizeModel(model: string): string {
  return MODEL_MAP[model] || model;
}
```

### ID Stripping

```typescript
// lib/request/strip-ids.ts
interface Message {
  role: string;
  content: string;
  id?: string;
  // Other fields that might have IDs
}

export function stripMessageIds(messages: Message[]): Message[] {
  return messages.map(({ id, ...rest }) => rest);
}
```

### Request Transformer

```typescript
// lib/request/index.ts
import { PluginInput } from "@opencode-ai/plugin";
import { normalizeModel } from "./models";
import { stripMessageIds } from "./strip-ids";
import { injectBridgePrompts } from "./prompts";

export async function transformRequest(
  request: Request,
  input: PluginInput
): Promise<Request> {
  const body = await request.json();
  
  // 1. Normalize model name
  if (body.model) {
    body.model = normalizeModel(body.model);
  }
  
  // 2. Strip unnecessary IDs from messages
  if (body.messages) {
    body.messages = stripMessageIds(body.messages);
  }
  
  // 3. Inject bridge prompts for Codex compatibility
  if (body.messages && input.model?.includes("codex")) {
    body.messages = injectBridgePrompts(body.messages);
  }
  
  // 4. Set default parameters
  body.temperature = body.temperature ?? 0.7;
  body.max_tokens = body.max_tokens ?? 4096;
  
  // Create new request with transformed body
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
}

export async function transformResponse(
  response: Response,
  input: PluginInput
): Promise<Response> {
  // Pass through for now; extend as needed
  return response;
}
```

---

## Bridge Prompts

Bridge prompts help translate between OpenCode's expected format and Codex's behavior.

```typescript
// lib/prompts/bridge.ts
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const CODEX_SYSTEM_PROMPT = `You are an expert coding assistant integrated with OpenCode CLI.

Guidelines:
- Provide clear, concise code solutions
- Use markdown code blocks with language identifiers
- Explain your reasoning briefly
- Follow best practices for the language/framework
- If asked to modify code, show the complete updated version
`;

const OPENCODE_CONTEXT_PROMPT = `
Context: You are running inside OpenCode CLI, a terminal-based AI coding assistant.
The user may provide file contents, terminal output, or code snippets.
Respond with actionable code and commands when appropriate.
`;

export function injectBridgePrompts(messages: Message[]): Message[] {
  const result: Message[] = [];
  
  // Check if system prompt already exists
  const hasSystemPrompt = messages.some((m) => m.role === "system");
  
  if (!hasSystemPrompt) {
    result.push({
      role: "system",
      content: CODEX_SYSTEM_PROMPT + OPENCODE_CONTEXT_PROMPT,
    });
  }
  
  // Add all original messages
  result.push(...messages);
  
  return result;
}
```

### Prompt Templates

```typescript
// lib/prompts/templates.ts
export const TEMPLATES = {
  codeReview: `Review the following code for:
- Bugs and potential issues
- Performance improvements
- Best practices
- Security concerns

Code:
\`\`\`{{language}}
{{code}}
\`\`\``,

  explain: `Explain the following code in detail:

\`\`\`{{language}}
{{code}}
\`\`\`

Focus on:
- What the code does
- How it works
- Any notable patterns or techniques`,

  refactor: `Refactor the following code to improve:
- Readability
- Maintainability
- Performance (if applicable)

Original code:
\`\`\`{{language}}
{{code}}
\`\`\`

Provide the refactored version with explanations.`,
};

export function applyTemplate(
  template: keyof typeof TEMPLATES,
  variables: Record<string, string>
): string {
  let result = TEMPLATES[template];
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
  }
  return result;
}
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | Direct API key (bypasses OAuth) | - |
| `OPENCODE_CODEX_ENDPOINT` | Custom API endpoint | `https://api.openai.com/v1` |
| `OPENCODE_CODEX_MODEL` | Default model | `gpt-4o` |
| `OPENCODE_CODEX_CALLBACK_PORT` | OAuth callback port | `8484` |
| `OPENCODE_AUTH_TIMEOUT` | OAuth flow timeout (ms) | `120000` |

### Plugin Configuration File

```json
// ~/.opencode/plugins/codex.json
{
  "name": "openai-codex",
  "enabled": true,
  "config": {
    "endpoint": "https://api.openai.com/v1",
    "model": "gpt-4o",
    "maxTokens": 4096,
    "temperature": 0.7
  }
}
```

---

## Error Handling

```typescript
// lib/errors.ts
export class PluginError extends Error {
  constructor(
    message: string,
    public code: string,
    public recoverable: boolean = false
  ) {
    super(message);
    this.name = "PluginError";
  }
}

export class AuthenticationError extends PluginError {
  constructor(message: string) {
    super(message, "AUTH_ERROR", true);
    this.name = "AuthenticationError";
  }
}

export class TokenExpiredError extends PluginError {
  constructor() {
    super("Access token has expired", "TOKEN_EXPIRED", true);
    this.name = "TokenExpiredError";
  }
}

export class RateLimitError extends PluginError {
  constructor(public retryAfter: number) {
    super(`Rate limited. Retry after ${retryAfter}s`, "RATE_LIMIT", true);
    this.name = "RateLimitError";
  }
}
```

---

## Complete Plugin Example

```typescript
// Full plugin implementation
import { Plugin, PluginInput, Auth, Credentials } from "@opencode-ai/plugin";

export default function createCodexPlugin(input: PluginInput): Plugin {
  const endpoint = input.endpoint || "https://api.openai.com/v1";
  const defaultModel = input.model || "gpt-4o";
  
  const auth = createAuth(input);
  
  return {
    name: "openai-codex",
    auth,
    
    async transformRequest(request: Request): Promise<Request> {
      const credentials = await auth.getCredentials();
      const body = await request.json();
      
      // Normalize and enhance request
      body.model = normalizeModel(body.model || defaultModel);
      body.messages = stripMessageIds(body.messages || []);
      
      // Create authenticated request
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${credentials.accessToken}`);
      headers.set("Content-Type", "application/json");
      
      return new Request(`${endpoint}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    },
    
    async transformResponse(response: Response): Promise<Response> {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        
        if (response.status === 401) {
          // Try to refresh token
          try {
            await auth.refreshCredentials?.();
            throw new AuthenticationError("Token refreshed, please retry");
          } catch {
            throw new AuthenticationError("Authentication failed");
          }
        }
        
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get("Retry-After") || "60");
          throw new RateLimitError(retryAfter);
        }
        
        throw new PluginError(
          error.message || "Request failed",
          "API_ERROR",
          false
        );
      }
      
      return response;
    },
  };
}
```

---

## Usage with OpenCode

```bash
# Install the plugin
opencode plugin install openai-codex

# Configure (first time - triggers OAuth)
opencode config set plugin.openai-codex.model gpt-4o

# Use the plugin
opencode chat --plugin openai-codex "Explain this code"

# Or set as default
opencode config set default-plugin openai-codex
```

---

## Key Implementation Patterns

### 1. Lazy Authentication
Credentials are only fetched when needed, not on plugin initialization.

### 2. Token Caching
In-memory caching reduces file I/O and improves performance.

### 3. Automatic Refresh
Tokens are refreshed transparently before they expire.

### 4. Request Interception
All requests pass through the transformer, allowing consistent modifications.

### 5. Model Normalization
Aliases are resolved to canonical model names for compatibility.

### 6. Bridge Prompts
System prompts are injected to improve model behavior within OpenCode context.

---

## Security Considerations

1. **PKCE Flow**: Prevents authorization code interception attacks
2. **Local Callback Server**: Runs only during OAuth flow, closes immediately after
3. **Token Storage**: Stored in user's config directory with appropriate permissions
4. **No Hardcoded Secrets**: Uses public client (no client_secret required for PKCE)
5. **State Parameter**: Prevents CSRF attacks during OAuth flow

---

## Comparison with Other Auth Methods

| Method | Use Case | Security | User Experience |
|--------|----------|----------|-----------------|
| OAuth PKCE | Interactive CLI | High | One-time browser login |
| API Key | CI/CD, Automation | Medium | Manual key management |
| Direct Token | Development/Debug | Low | Manual token handling |

---

## Future Enhancements

1. **Keychain Integration**: Store tokens in OS keychain (like Cursor CLI)
2. **Multi-Provider Support**: Single plugin supporting multiple AI providers
3. **Token Encryption**: Encrypt stored tokens at rest
4. **Session Management**: Support for multiple concurrent sessions
5. **Offline Mode**: Cached responses for common queries
