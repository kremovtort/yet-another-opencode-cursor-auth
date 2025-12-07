/**
 * OpenAI-Compatible API Server
 * 
 * Routes OpenAI API requests through Cursor's Agent API backend.
 * Supports:
 * - POST /v1/chat/completions (streaming and non-streaming)
 * - GET /v1/models
 * 
 * Usage:
 *   CURSOR_ACCESS_TOKEN=<token> bun run src/server.ts
 *   
 * Or with auto-loaded credentials:
 *   bun run src/server.ts
 */

import { createAgentServiceClient, AgentMode } from "./lib/api/agent-service";
import { FileCredentialManager } from "./lib/storage";

// --- Types ---

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
}

interface OpenAIChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: "stop" | "length" | "content_filter" | null;
}

interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
  };
  finish_reason: "stop" | "length" | "content_filter" | null;
}

interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
}

interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

// --- Model Mapping ---

// Map OpenAI model names to Cursor model names
const MODEL_MAP: Record<string, string> = {
  // GPT models
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4-turbo": "gpt-4-turbo",
  "gpt-4": "gpt-4",
  "gpt-3.5-turbo": "gpt-3.5-turbo",
  
  // Claude models
  "claude-3-5-sonnet": "claude-3.5-sonnet",
  "claude-3-5-sonnet-20241022": "claude-3.5-sonnet",
  "claude-3-opus": "claude-3-opus",
  "claude-3-sonnet": "claude-3-sonnet",
  "claude-3-haiku": "claude-3-haiku",
  "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  
  // Cursor models
  "cursor-small": "cursor-small",
};

// Available models to advertise
const AVAILABLE_MODELS: OpenAIModel[] = [
  { id: "gpt-4o", object: "model", created: 1699500000, owned_by: "openai" },
  { id: "gpt-4o-mini", object: "model", created: 1699500000, owned_by: "openai" },
  { id: "gpt-4-turbo", object: "model", created: 1699500000, owned_by: "openai" },
  { id: "gpt-4", object: "model", created: 1699500000, owned_by: "openai" },
  { id: "gpt-3.5-turbo", object: "model", created: 1699500000, owned_by: "openai" },
  { id: "claude-3-5-sonnet", object: "model", created: 1699500000, owned_by: "anthropic" },
  { id: "claude-3-opus", object: "model", created: 1699500000, owned_by: "anthropic" },
  { id: "claude-3-sonnet", object: "model", created: 1699500000, owned_by: "anthropic" },
  { id: "claude-3-haiku", object: "model", created: 1699500000, owned_by: "anthropic" },
  { id: "cursor-small", object: "model", created: 1699500000, owned_by: "cursor" },
];

// --- Helpers ---

function generateId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function mapModel(requestedModel: string): string {
  return MODEL_MAP[requestedModel] ?? requestedModel;
}

function messagesToPrompt(messages: OpenAIMessage[]): string {
  // For simple cases, just use the last user message
  // For more complex cases, we could format the conversation
  const userMessages = messages.filter(m => m.role === "user");
  const systemMessages = messages.filter(m => m.role === "system");
  
  let prompt = "";
  
  // Prepend system message if present
  if (systemMessages.length > 0) {
    prompt += systemMessages.map(m => m.content).join("\n") + "\n\n";
  }
  
  // Add the user message(s)
  if (userMessages.length > 0) {
    prompt += userMessages[userMessages.length - 1]?.content ?? "";
  }
  
  return prompt;
}

function createErrorResponse(message: string, type: string = "invalid_request_error", status: number = 400): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// --- SSE Streaming ---

function createSSEChunk(chunk: OpenAIStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createSSEDone(): string {
  return "data: [DONE]\n\n";
}

// --- Server ---

async function getAccessToken(): Promise<string> {
  // First check environment variable
  const envToken = process.env.CURSOR_ACCESS_TOKEN;
  if (envToken) {
    return envToken;
  }
  
  // Fall back to credential manager
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) {
    throw new Error("No access token found. Set CURSOR_ACCESS_TOKEN or authenticate first.");
  }
  return token;
}

async function handleChatCompletions(req: Request, accessToken: string): Promise<Response> {
  let body: OpenAIChatRequest;
  
  try {
    body = await req.json();
  } catch {
    return createErrorResponse("Invalid JSON body");
  }
  
  // Validate required fields
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return createErrorResponse("messages is required and must be a non-empty array");
  }
  
  const model = mapModel(body.model ?? "gpt-4o");
  const prompt = messagesToPrompt(body.messages);
  const stream = body.stream ?? false;
  
  const client = createAgentServiceClient(accessToken);
  const completionId = generateId();
  const created = Math.floor(Date.now() / 1000);
  
  if (stream) {
    // Streaming response
    const encoder = new TextEncoder();
    
    const readable = new ReadableStream({
      async start(controller) {
        try {
          // Send initial chunk with role
          const initialChunk: OpenAIStreamChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: body.model ?? "gpt-4o",
            choices: [{
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            }],
          };
          controller.enqueue(encoder.encode(createSSEChunk(initialChunk)));
          
          // Stream content
          for await (const chunk of client.chatStream({ message: prompt, model, mode: AgentMode.AGENT })) {
            if (chunk.type === "text" || chunk.type === "token") {
              if (chunk.content) {
                const streamChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: { content: chunk.content },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(streamChunk)));
              }
            } else if (chunk.type === "error") {
              // Send error in stream format
              const errorChunk = {
                error: {
                  message: chunk.error ?? "Unknown error",
                  type: "server_error",
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
              break;
            }
          }
          
          // Send final chunk with finish_reason
          const finalChunk: OpenAIStreamChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: body.model ?? "gpt-4o",
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
            }],
          };
          controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));
          
          // Send done signal
          controller.enqueue(encoder.encode(createSSEDone()));
          controller.close();
        } catch (err: any) {
          console.error("Stream error:", err);
          controller.error(err);
        }
      },
    });
    
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } else {
    // Non-streaming response
    try {
      const content = await client.chat({ message: prompt, model, mode: AgentMode.AGENT });
      
      const response: OpenAIChatResponse = {
        id: completionId,
        object: "chat.completion",
        created,
        model: body.model ?? "gpt-4o",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(content.length / 4),
          total_tokens: Math.ceil((prompt.length + content.length) / 4),
        },
      };
      
      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err: any) {
      return createErrorResponse(err.message ?? "Unknown error", "server_error", 500);
    }
  }
}

function handleModels(): Response {
  const response: OpenAIModelsResponse = {
    object: "list",
    data: AVAILABLE_MODELS,
  };
  
  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// --- Main ---

const PORT = parseInt(process.env.PORT ?? "3000", 10);

console.log("Starting OpenAI-compatible API server...");

let accessToken: string;
try {
  accessToken = await getAccessToken();
  console.log("Access token loaded successfully");
} catch (err: any) {
  console.error("Failed to get access token:", err.message);
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    
    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleCORS();
    }
    
    // Route requests
    if (url.pathname === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, accessToken);
    }
    
    if (url.pathname === "/v1/models" && method === "GET") {
      return handleModels();
    }
    
    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", version: "1.0.0" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    
    // 404 for unknown routes
    return createErrorResponse(`Unknown endpoint: ${method} ${url.pathname}`, "not_found", 404);
  },
});

console.log(`
╔════════════════════════════════════════════════════════════╗
║  OpenAI-Compatible API Server                              ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT.toString().padEnd(24)}║
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/chat/completions  - Chat completions           ║
║    GET  /v1/models            - List available models      ║
║    GET  /health               - Health check               ║
║                                                            ║
║  Usage with curl:                                          ║
║    curl http://localhost:${PORT}/v1/chat/completions \\${" ".repeat(Math.max(0, 6 - PORT.toString().length))}║
║      -H "Content-Type: application/json" \\                 ║
║      -d '{"model":"gpt-4o","messages":[...]}'              ║
║                                                            ║
║  Usage with OpenAI SDK:                                    ║
║    const openai = new OpenAI({                             ║
║      baseURL: "http://localhost:${PORT}/v1",${" ".repeat(Math.max(0, 20 - PORT.toString().length))}║
║      apiKey: "not-needed"                                  ║
║    });                                                     ║
╚════════════════════════════════════════════════════════════╝
`);
