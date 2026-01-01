/**
 * Cursor Agent Service Client
 *
 * Implements the AgentService API for chat functionality.
 * Uses the BidiSse pattern:
 * - RunSSE (server-streaming) to receive responses
 * - BidiAppend (unary) to send client messages
 *
 * Proto structure:
 * AgentClientMessage:
 *   field 1: run_request (AgentRunRequest)
 *   field 2: exec_client_message (ExecClientMessage)
 *   field 3: kv_client_message (KvClientMessage)
 *   field 4: conversation_action (ConversationAction)
 *   field 5: exec_client_control_message
 *   field 6: interaction_response
 *
 * AgentServerMessage:
 *   field 1: interaction_update (InteractionUpdate)
 *   field 2: exec_server_message (ExecServerMessage)
 *   field 3: conversation_checkpoint_update (completion signal)
 *   field 4: kv_server_message (KvServerMessage)
 *   field 5: exec_server_control_message
 *   field 7: interaction_query
 *
 * InteractionUpdate.message:
 *   field 1: text_delta
 *   field 4: thinking_delta
 *   field 8: token_delta
 *   field 13: heartbeat
 *   field 14: turn_ended
 */

import { randomUUID } from "node:crypto";
import { generateChecksum, addConnectEnvelope } from "./cursor-client";
import {
  encodeVarint,
  encodeStringField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeMessageField,
  encodeBoolField,
  encodeDoubleField,
  concatBytes,
  encodeProtobufValue,
  parseProtoFields,
  parseExecServerMessage,
  buildExecClientMessageWithMcpResult,
  buildExecClientMessageWithShellResult,
  buildExecClientMessageWithLsResult,
  buildExecClientMessageWithRequestContextResult,
  buildExecClientMessageWithReadResult,
  buildExecClientMessageWithGrepResult,
  buildExecClientMessageWithWriteResult,
  buildAgentClientMessageWithExec,
  buildExecClientControlMessage,
  buildAgentClientMessageWithExecControl,
  parseToolCall,
  parseToolCallStartedUpdate,
  parsePartialToolCallUpdate,
  parseKvServerMessage,
  buildKvClientMessage,
  buildAgentClientMessageWithKv,
  AgentMode,
} from "./proto";
import type {
  OpenAIToolDefinition,
  McpExecRequest,
  ShellExecRequest,
  LsExecRequest,
  ReadExecRequest,
  GrepExecRequest,
  WriteExecRequest,
  ExecRequest,
  KvServerMessage,
  ChatTimingMetrics,
  AgentServiceOptions,
  AgentChatRequest,
  McpResult,
  WriteResult,
  ParsedToolCall,
  ToolCallInfo,
  AgentStreamChunk as AgentStreamChunkType,
} from "./proto/types";

// Re-export types that external code may need
export { AgentMode };
export type AgentStreamChunk = AgentStreamChunkType;
export type { ExecRequest, McpExecRequest, ToolCallInfo, OpenAIToolDefinition };

// Debug logging - set to true to enable verbose logging
const DEBUG = process.env.CURSOR_DEBUG === "1";
const debugLog = DEBUG ? console.log.bind(console) : () => {};

// Performance timing - set CURSOR_TIMING=1 to enable timing logs (or CURSOR_DEBUG=1)
const TIMING_ENABLED = process.env.CURSOR_TIMING === "1" || DEBUG;
const timingLog = TIMING_ENABLED ? console.log.bind(console) : () => {};


function createTimingMetrics(): ChatTimingMetrics {
  return {
    requestStart: Date.now(),
    chunkCount: 0,
    textChunks: 0,
    toolCalls: 0,
    execRequests: 0,
    kvMessages: 0,
    heartbeats: 0,
  };
}

function logTimingMetrics(metrics: ChatTimingMetrics): void {
  const total = Date.now() - metrics.requestStart;
  metrics.totalMs = total;
  
  timingLog("[TIMING] ═══════════════════════════════════════════════════════");
  timingLog("[TIMING] Request Performance Summary");
  timingLog("[TIMING] ───────────────────────────────────────────────────────");
  timingLog(`[TIMING]   Message build:     ${metrics.messageBuildMs ?? "-"}ms`);
  timingLog(`[TIMING]   SSE connection:    ${metrics.sseConnectionMs ?? "-"}ms`);
  timingLog(`[TIMING]   First BidiAppend:  ${metrics.firstBidiAppendMs ?? "-"}ms`);
  timingLog(`[TIMING]   First chunk:       ${metrics.firstChunkMs ?? "-"}ms`);
  timingLog(`[TIMING]   First text:        ${metrics.firstTextMs ?? "-"}ms`);
  timingLog(`[TIMING]   First tool call:   ${metrics.firstToolCallMs ?? "-"}ms`);
  timingLog(`[TIMING]   Turn ended:        ${metrics.turnEndedMs ?? "-"}ms`);
  timingLog(`[TIMING]   Total:             ${total}ms`);
  timingLog("[TIMING] ───────────────────────────────────────────────────────");
  timingLog(`[TIMING]   Chunks: ${metrics.chunkCount} (text: ${metrics.textChunks}, tools: ${metrics.toolCalls})`);
  timingLog(`[TIMING]   Exec requests: ${metrics.execRequests}, KV messages: ${metrics.kvMessages}`);
  timingLog(`[TIMING]   Heartbeats: ${metrics.heartbeats}`);
  timingLog("[TIMING] ═══════════════════════════════════════════════════════");
}

// Cursor API URL (main API)
export const CURSOR_API_URL = "https://api2.cursor.sh";

// Agent backends
export const AGENT_PRIVACY_URL = "https://agent.api5.cursor.sh";
export const AGENT_NON_PRIVACY_URL = "https://agentn.api5.cursor.sh";

// --- MCP Tool Definition Encoding ---

/**
 * Encode McpToolDefinition message
 *
 * McpToolDefinition:
 *   field 1: name (string) - unique identifier for the tool
 *   field 2: description (string)
 *   field 3: input_schema (google.protobuf.Value)
 *   field 4: provider_identifier (string)
 *   field 5: tool_name (string)
 */
function encodeMcpToolDefinition(tool: OpenAIToolDefinition, providerIdentifier = "cursor-tools"): Uint8Array {
  const toolName = tool.function.name;
  // The name field should be the combined identifier (provider-toolname) with hyphen
  // This matches how Cursor's McpManager creates tool names: `${tool.clientName}-${tool.name}`
  // Using "cursor-tools" as provider to look like a built-in provider
  const combinedName = `${providerIdentifier}-${toolName}`;
  const description = tool.function.description ?? "";
  const inputSchema = tool.function.parameters ?? { type: "object", properties: {} };

  // Removed verbose tool encoding log - was spamming 40+ logs per request

  const parts: Uint8Array[] = [
    encodeStringField(1, combinedName),
    encodeStringField(2, description),
  ];

  // Encode input_schema as google.protobuf.Value
  if (inputSchema) {
    const schemaValue = encodeProtobufValue(inputSchema);
    parts.push(encodeMessageField(3, schemaValue));
  }

  parts.push(encodeStringField(4, providerIdentifier));
  parts.push(encodeStringField(5, toolName));

  return concatBytes(...parts);
}

// --- Proto Message Builders ---

/**
 * Encode BidiRequestId
 * - request_id: field 1 (string)
 */
function encodeBidiRequestId(requestId: string): Uint8Array {
  return encodeStringField(1, requestId);
}

/**
 * Encode BidiAppendRequest
 * - data: field 1 (string, hex-encoded)
 * - request_id: field 2 (BidiRequestId message)
 * - append_seqno: field 3 (int64)
 */
function encodeBidiAppendRequest(data: string, requestId: string, appendSeqno: bigint): Uint8Array {
  const requestIdMsg = encodeBidiRequestId(requestId);
  return concatBytes(
    encodeStringField(1, data),
    encodeMessageField(2, requestIdMsg),
    encodeInt64Field(3, appendSeqno)
  );
}

/**
 * Build RequestContextEnv
 * field 1: os_version (string)
 * field 2: workspace_paths (repeated string)
 * field 3: shell (string)
 * field 10: time_zone (string)
 * field 11: project_folder (string)
 */
function buildRequestContextEnv(workspacePath: string = process.cwd()): Uint8Array {
  return concatBytes(
    encodeStringField(1, "darwin 24.0.0"),
    encodeStringField(2, workspacePath),
    encodeStringField(3, '/bin/zsh'),
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),
    encodeStringField(11, workspacePath),
  );
}

/**
 * Encode McpInstructions message
 * McpInstructions:
 *   field 1: server_name (string)
 *   field 2: instructions (string)
 */
function encodeMcpInstructions(serverName: string, instructions: string): Uint8Array {
  return concatBytes(
    encodeStringField(1, serverName),
    encodeStringField(2, instructions)
  );
}

/**
 * Build RequestContext
 * field 2: rules (repeated CursorRule) - optional
 * field 4: env (RequestContextEnv)
 * field 7: tools (repeated McpToolDefinition) - IMPORTANT for tool calling
 * field 11: git_repos (repeated GitRepoInfo) - optional
 * field 14: mcp_instructions (repeated McpInstructions) - instructions for MCP tools
 */
function buildRequestContext(workspacePath?: string, tools?: OpenAIToolDefinition[]): Uint8Array {
  const parts: Uint8Array[] = [];

  // field 4: env
  const env = buildRequestContextEnv(workspacePath);
  parts.push(encodeMessageField(4, env));

  // field 7: tools (repeated McpToolDefinition)
  // Enable tools in RequestContext - this is where Cursor expects MCP tool definitions
  // Use "cursor-tools" as provider identifier to look like a built-in tool provider
  const MCP_PROVIDER = "cursor-tools";
  if (tools && tools.length > 0) {
    debugLog(`[DEBUG] Adding ${tools.length} tools to RequestContext.tools (field 7)`);
    for (const tool of tools) {
      const mcpTool = encodeMcpToolDefinition(tool, MCP_PROVIDER);
      parts.push(encodeMessageField(7, mcpTool));
    }

    // field 14: mcp_instructions - provide instructions for the MCP tools
    // Build instruction text describing all tools
    const toolDescriptions = tools.map(t =>
      `- ${t.function.name}: ${t.function.description || 'No description'}`
    ).join('\n');
    const instructions = `You have access to the following tools:\n${toolDescriptions}\n\nUse these tools when appropriate to help the user.`;

    const mcpInstr = encodeMcpInstructions(MCP_PROVIDER, instructions);
    parts.push(encodeMessageField(14, mcpInstr));
    debugLog(`[DEBUG] Added MCP instructions for ${MCP_PROVIDER} server`);
  }

  return concatBytes(...parts);
}

/**
 * Encode UserMessage
 * - text: field 1 (string)
 * - message_id: field 2 (string)
 * - mode: field 4 (enum/int32)
 */
function encodeUserMessage(text: string, messageId: string, mode: AgentMode = AgentMode.ASK): Uint8Array {
  debugLog(`[DEBUG] encodeUserMessage: mode=${mode} (${AgentMode[mode]}), messageId=${messageId}`);
  return concatBytes(
    encodeStringField(1, text),
    encodeStringField(2, messageId),
    encodeInt32Field(4, mode)
  );
}

/**
 * Encode UserMessageAction
 * - user_message: field 1 (UserMessage)
 * - request_context: field 2 (RequestContext) - REQUIRED for agent to work
 */
function encodeUserMessageAction(userMessage: Uint8Array, requestContext: Uint8Array): Uint8Array {
  return concatBytes(
    encodeMessageField(1, userMessage),
    encodeMessageField(2, requestContext)
  );
}

/**
 * Encode ConversationAction
 * - user_message_action: field 1 (UserMessageAction)
 */
function encodeConversationAction(userMessageAction: Uint8Array): Uint8Array {
  return encodeMessageField(1, userMessageAction);
}

/**
 * Encode ModelDetails
 * - model_id: field 1 (string)
 */
function encodeModelDetails(modelId: string): Uint8Array {
  return encodeStringField(1, modelId);
}

/**
 * Encode ConversationStateStructure (empty for new conversation)
 * This is required even for new conversations
 */
function encodeEmptyConversationState(): Uint8Array {
  return new Uint8Array(0);
}

/**
 * Encode McpTools wrapper message
 * McpTools:
 *   field 1: mcp_tools (repeated McpToolDefinition)
 *
 * This is a wrapper message that contains repeated tool definitions
 */
function encodeMcpTools(tools: OpenAIToolDefinition[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const MCP_PROVIDER = "cursor-tools";
  for (const tool of tools) {
    const mcpTool = encodeMcpToolDefinition(tool, MCP_PROVIDER);
    // field 1 in McpTools = repeated McpToolDefinition
    parts.push(encodeMessageField(1, mcpTool));
  }
  return concatBytes(...parts);
}

/**
 * Encode McpDescriptor message
 * McpDescriptor:
 *   field 1: server_name (string) - Display name of the MCP server
 *   field 2: server_identifier (string) - Unique identifier
 *   field 3: folder_path (string, optional)
 *   field 4: server_use_instructions (string, optional)
 */
function encodeMcpDescriptor(
  serverName: string,
  serverIdentifier: string,
  folderPath?: string,
  serverUseInstructions?: string
): Uint8Array {
  const parts: Uint8Array[] = [
    encodeStringField(1, serverName),
    encodeStringField(2, serverIdentifier),
  ];

  if (folderPath) {
    parts.push(encodeStringField(3, folderPath));
  }

  if (serverUseInstructions) {
    parts.push(encodeStringField(4, serverUseInstructions));
  }

  return concatBytes(...parts);
}

/**
 * Encode McpFileSystemOptions message
 * McpFileSystemOptions:
 *   field 1: enabled (bool)
 *   field 2: workspace_project_dir (string)
 *   field 3: mcp_descriptors (repeated McpDescriptor)
 */
function encodeMcpFileSystemOptions(
  enabled: boolean,
  workspaceProjectDir: string,
  mcpDescriptors: Array<{ serverName: string; serverIdentifier: string; folderPath?: string; serverUseInstructions?: string }>
): Uint8Array {
  const parts: Uint8Array[] = [];

  // field 1: enabled
  if (enabled) {
    parts.push(encodeBoolField(1, true));
  }

  // field 2: workspace_project_dir
  if (workspaceProjectDir) {
    parts.push(encodeStringField(2, workspaceProjectDir));
  }

  // field 3: mcp_descriptors (repeated)
  for (const descriptor of mcpDescriptors) {
    const encodedDescriptor = encodeMcpDescriptor(
      descriptor.serverName,
      descriptor.serverIdentifier,
      descriptor.folderPath,
      descriptor.serverUseInstructions
    );
    parts.push(encodeMessageField(3, encodedDescriptor));
  }

  return concatBytes(...parts);
}

/**
 * Debug helper: dump protobuf as hex string
 */
function hexDump(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

/**
 * Encode AgentRunRequest
 * - conversation_state: field 1 (ConversationStateStructure) - required, empty for new conversation
 * - action: field 2 (ConversationAction)
 * - model_details: field 3 (ModelDetails)
 * - mcp_tools: field 4 (McpTools) - tool definitions
 * - conversation_id: field 5 (string, optional)
 * - mcp_file_system_options: field 6 (McpFileSystemOptions, optional) - enables MCP tool execution
 */
function encodeAgentRunRequest(
  action: Uint8Array,
  modelDetails: Uint8Array,
  conversationId?: string,
  tools?: OpenAIToolDefinition[],
  workspacePath?: string
): Uint8Array {
  const conversationState = encodeEmptyConversationState();

  const parts: Uint8Array[] = [
    encodeMessageField(1, conversationState),
    encodeMessageField(2, action),
    encodeMessageField(3, modelDetails),
  ];

  // field 4: mcp_tools (McpTools wrapper)
  // This mirrors how Cursor builds AgentRunRequest - tools go in BOTH:
  // 1. RequestContext.tools (field 7) - already added in buildRequestContext
  // 2. AgentRunRequest.mcp_tools (field 4) - added here
  if (tools && tools.length > 0) {
    const mcpToolsWrapper = encodeMcpTools(tools);
    parts.push(encodeMessageField(4, mcpToolsWrapper));
    debugLog(`[DEBUG] Added mcp_tools (field 4) to AgentRunRequest with ${tools.length} tools`);
  }

  // Add conversation_id if provided (field 5)
  if (conversationId) {
    parts.push(encodeStringField(5, conversationId));
  }

  // field 6: mcp_file_system_options
  // This enables MCP tool execution - provides workspace context and descriptor info
  if (tools && tools.length > 0 && workspacePath) {
    const MCP_PROVIDER = "cursor-tools";
    const mcpDescriptors = [{
      serverName: "Cursor Tools",
      serverIdentifier: MCP_PROVIDER,
      folderPath: workspacePath,
      serverUseInstructions: "Use these tools to assist the user with their coding tasks."
    }];
    const mcpFsOptions = encodeMcpFileSystemOptions(true, workspacePath, mcpDescriptors);
    parts.push(encodeMessageField(6, mcpFsOptions));
    debugLog(`[DEBUG] Added mcp_file_system_options (field 6) with workspace: ${workspacePath}`);
  }

  return concatBytes(...parts);
}

/**
 * Encode AgentClientMessage with run_request
 * - run_request: field 1 (AgentRunRequest)
 */
function encodeAgentClientMessage(runRequest: Uint8Array): Uint8Array {
  return encodeMessageField(1, runRequest);
}

// --- Types are now imported from ./proto ---
// ExecRequest types, ToolCallInfo, AgentStreamChunk, AgentServiceOptions, AgentChatRequest
// are all imported from ./proto/types via the barrel export

// Local aliases for the buildExecClientMessageWithMcpResult function which needs a slightly different signature
function buildExecClientMessage(
  id: number,
  execId: string | undefined,
  result: { success?: { content: string; isError?: boolean }; error?: string }
): Uint8Array {
  return buildExecClientMessageWithMcpResult(id, execId, result);
}

export class AgentServiceClient {
  private baseUrl: string;
  private accessToken: string;
  private workspacePath: string;
  private blobStore: Map<string, Uint8Array>;

  // For tool result submission during streaming
  private currentRequestId: string | null = null;
  private currentAppendSeqno = 0n;
  
  // For session reuse - track assistant responses stored in KV blobs
  // When Cursor stores model responses in blobs instead of streaming, we need to extract them
  private pendingAssistantBlobs: Array<{ blobId: string; content: string }> = [];

  constructor(accessToken: string, options: AgentServiceOptions = {}) {
    this.accessToken = accessToken;
    // Use main API endpoint (api2.cursor.sh) - agent.api5.cursor.sh requires feature flag
    this.baseUrl = options.baseUrl ?? CURSOR_API_URL;
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.blobStore = new Map();
    debugLog(`[DEBUG] AgentServiceClient using baseUrl: ${this.baseUrl}`);
  }

  private getHeaders(requestId?: string): Record<string, string> {
    const checksum = generateChecksum(this.accessToken);

    const headers: Record<string, string> = {
      "authorization": `Bearer ${this.accessToken}`,
      "content-type": "application/grpc-web+proto",
      "user-agent": "connect-es/1.4.0",
      "x-cursor-checksum": checksum,
      "x-cursor-client-version": "cli-2025.11.25-d5b3271",
      "x-cursor-client-type": "cli",
      "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      "x-ghost-mode": "false",
      // Signal to backend that we can receive SSE text/event-stream responses
      // Without this, server may store responses in KV blobs instead of streaming
      "x-cursor-streaming": "true",
    };

    if (requestId) {
      headers["x-request-id"] = requestId;
    }

    return headers;
  }

  private blobIdToKey(blobId: Uint8Array): string {
    return Buffer.from(blobId).toString('hex');
  }

  /**
   * Build the AgentClientMessage for a chat request
   */
  private buildChatMessage(request: AgentChatRequest): Uint8Array {
    const messageId = randomUUID();
    const conversationId = request.conversationId ?? randomUUID();
    const model = request.model ?? "gpt-4o";
    const mode = request.mode ?? AgentMode.AGENT;

    // Build RequestContext (REQUIRED for agent to work)
    // Include tools in RequestContext.tools (field 7) - CRITICAL for tool calling!
    const requestContext = buildRequestContext(this.workspacePath, request.tools);

    // Build the message hierarchy
    const userMessage = encodeUserMessage(request.message, messageId, mode);
    const userMessageAction = encodeUserMessageAction(userMessage, requestContext);
    const conversationAction = encodeConversationAction(userMessageAction);
    const modelDetails = encodeModelDetails(model);
    // Pass tools to AgentRunRequest (field 4: mcp_tools) and workspace path (for field 6: mcp_file_system_options)
    const agentRunRequest = encodeAgentRunRequest(conversationAction, modelDetails, conversationId, request.tools, this.workspacePath);
    const agentClientMessage = encodeAgentClientMessage(agentRunRequest);

    return agentClientMessage;
  }

  /**
   * Call BidiAppend to send a client message
   */
  private async bidiAppend(requestId: string, appendSeqno: bigint, data: Uint8Array): Promise<void> {
    const startTime = Date.now();
    const hexData = Buffer.from(data).toString("hex");
    const appendRequest = encodeBidiAppendRequest(hexData, requestId, appendSeqno);
    const envelope = addConnectEnvelope(appendRequest);

    debugLog(`[TIMING] bidiAppend: data=${data.length}bytes, hex=${hexData.length}chars, envelope=${envelope.length}bytes, encode=${Date.now() - startTime}ms`);

    const url = `${this.baseUrl}/aiserver.v1.BidiService/BidiAppend`;

    const fetchStart = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(requestId),
      body: Buffer.from(envelope),
    });
    debugLog(`[TIMING] bidiAppend fetch took ${Date.now() - fetchStart}ms, status=${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
    }

    // Read the response body to see if there's any useful information
    const responseBody = await response.arrayBuffer();
    if (responseBody.byteLength > 0) {
      debugLog(`[DEBUG] BidiAppend response: ${responseBody.byteLength} bytes`);
      const bytes = new Uint8Array(responseBody);
      // Parse as gRPC-Web envelope
      if (bytes.length >= 5) {
        const flags = bytes[0] ?? 0;
        const b1 = bytes[1] ?? 0;
        const b2 = bytes[2] ?? 0;
        const b3 = bytes[3] ?? 0;
        const b4 = bytes[4] ?? 0;
        const length = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
        debugLog(`[DEBUG] BidiAppend response: flags=${flags}, length=${length}, totalBytes=${bytes.length}`);
        if (length > 0 && bytes.length >= 5 + length) {
          const payload = bytes.slice(5, 5 + length);
          debugLog(`[DEBUG] BidiAppend payload hex: ${Buffer.from(payload).toString('hex')}`);
        }
      }
    }
  }

  /**
   * Analyze blob data to determine its type and extract content
   */
  private analyzeBlobData(data: Uint8Array): {
    type: 'json' | 'text' | 'protobuf' | 'binary';
    json?: Record<string, unknown>;
    text?: string;
    protoFields?: Array<{ num: number; wire: number; size: number; text?: string }>;
  } {
    // Try UTF-8 text first
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      
      // Try JSON
      try {
        const json = JSON.parse(text);
        return { type: 'json', json, text };
      } catch {
        // Not JSON, return as text
        return { type: 'text', text };
      }
    } catch {
      // Not valid UTF-8
    }

    // Try protobuf parsing
    try {
      const fields = parseProtoFields(data);
      if (fields.length > 0 && fields.length < 100) { // Reasonable field count
        const protoFields: Array<{ num: number; wire: number; size: number; text?: string }> = [];
        for (const f of fields) {
          const entry: { num: number; wire: number; size: number; text?: string } = {
            num: f.fieldNumber,
            wire: f.wireType,
            size: f.value instanceof Uint8Array ? f.value.length : 0,
          };
          // Try to decode field value as text
          if (f.wireType === 2 && f.value instanceof Uint8Array) {
            try {
              entry.text = new TextDecoder('utf-8', { fatal: true }).decode(f.value);
            } catch {
              // Binary field
            }
          }
          protoFields.push(entry);
        }
        return { type: 'protobuf', protoFields };
      }
    } catch {
      // Not valid protobuf
    }

    return { type: 'binary' };
  }

  /**
   * Handle KV server message and send response
   * Also tracks assistant response blobs for session reuse
   */
  private async handleKvMessage(
    kvMsg: KvServerMessage,
    requestId: string,
    appendSeqno: bigint
  ): Promise<bigint> {
    if (kvMsg.messageType === 'get_blob_args' && kvMsg.blobId) {
      const key = this.blobIdToKey(kvMsg.blobId);
      const data = this.blobStore.get(key);

      // GetBlobResult: field 1 = blob_data (bytes, optional)
      const result = data ? encodeMessageField(1, data) : new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'get_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);

      await this.bidiAppend(requestId, appendSeqno, responseMsg);
      return appendSeqno + 1n;
    }

    if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
      const key = this.blobIdToKey(kvMsg.blobId);
      this.blobStore.set(key, kvMsg.blobData);

      // Enhanced debug: analyze blob data thoroughly to find assistant responses
      // Cursor may store responses in various formats (JSON, protobuf, text)
      const blobAnalysis = this.analyzeBlobData(kvMsg.blobData);
      debugLog(`[KV-BLOB] SET id=${kvMsg.id}, key=${key.slice(0, 16)}..., size=${kvMsg.blobData.length}b, type=${blobAnalysis.type}`);
      
      if (blobAnalysis.type === 'json') {
        debugLog(`[KV-BLOB]   JSON keys: ${Object.keys(blobAnalysis.json || {}).join(', ')}`);
        // Log the role field if present
        if (blobAnalysis.json?.role) {
          debugLog(`[KV-BLOB]   role="${blobAnalysis.json.role}"`);
        }
        // Check for assistant response patterns
        if (blobAnalysis.json?.role === "assistant") {
          const content = blobAnalysis.json.content;
          debugLog(`[KV-BLOB]   content type: ${typeof content}, value: ${JSON.stringify(content)?.slice(0, 200)}`);
          if (typeof content === "string" && content.length > 0) {
            debugLog(`[KV-BLOB]   ✓ Assistant response found! (${content.length} chars)`);
            debugLog(`[KV-BLOB]   Preview: ${content.slice(0, 150)}...`);
            this.pendingAssistantBlobs.push({ blobId: key, content });
          } else if (Array.isArray(content)) {
            // Content might be an array of content parts (like in OpenAI's format)
            debugLog(`[KV-BLOB]   ✓ Assistant content is array with ${content.length} parts`);
            for (const part of content) {
              if (typeof part === 'string') {
                this.pendingAssistantBlobs.push({ blobId: key, content: part });
              } else if (part?.type === 'text' && typeof part?.text === 'string') {
                debugLog(`[KV-BLOB]   ✓ Text part: ${part.text.slice(0, 100)}...`);
                this.pendingAssistantBlobs.push({ blobId: key, content: part.text });
              }
            }
          } else if (content === null || content === undefined) {
            // Content might be null for tool-calling responses
            debugLog("[KV-BLOB]   Assistant content is null/undefined (likely tool-calling response)");
          }
        }
        // Check for tool_calls in assistant messages
        if (blobAnalysis.json?.role === "assistant" && Array.isArray(blobAnalysis.json.tool_calls)) {
          debugLog(`[KV-BLOB]   Assistant has tool_calls: ${blobAnalysis.json.tool_calls.length}`);
        }
        // Check for "user" role with tool result
        if (blobAnalysis.json?.role === "user" && blobAnalysis.json?.content) {
          debugLog(`[KV-BLOB]   User message content (${String(blobAnalysis.json.content).length} chars): ${String(blobAnalysis.json.content).slice(0, 100)}...`);
        }
        // Check for "tool" role
        if (blobAnalysis.json?.role === "tool") {
          debugLog(`[KV-BLOB]   Tool result for: ${blobAnalysis.json.tool_call_id}`);
        }
        // Also check for messages array pattern
        if (Array.isArray(blobAnalysis.json?.messages)) {
          for (const msg of blobAnalysis.json.messages) {
            if (msg?.role === "assistant" && typeof msg?.content === "string") {
              debugLog(`[KV-BLOB]   ✓ Assistant in messages array! (${msg.content.length} chars)`);
              debugLog(`[KV-BLOB]   Preview: ${msg.content.slice(0, 150)}...`);
              this.pendingAssistantBlobs.push({ blobId: key, content: msg.content });
            }
          }
        }
        // Check for content field directly (some formats)
        if (typeof blobAnalysis.json?.content === "string" && !blobAnalysis.json?.role) {
          debugLog(`[KV-BLOB]   Content field found (${blobAnalysis.json.content.length} chars)`);
          debugLog(`[KV-BLOB]   Preview: ${blobAnalysis.json.content.slice(0, 150)}...`);
        }
      } else if (blobAnalysis.type === 'text') {
        debugLog(`[KV-BLOB]   Text preview: ${blobAnalysis.text?.slice(0, 200)}...`);
        // Check if text looks like a model response (starts with text, not JSON/protobuf markers)
        if (blobAnalysis.text && !blobAnalysis.text.startsWith('{') && !blobAnalysis.text.startsWith('[') && blobAnalysis.text.length > 50) {
          debugLog("[KV-BLOB]   Possible plain text response - check manually");
        }
      } else if (blobAnalysis.type === 'protobuf') {
        debugLog(`[KV-BLOB]   Protobuf fields: ${blobAnalysis.protoFields?.map(f => `f${f.num}:w${f.wire}(${f.size}b)`).join(', ')}`);
        // Try to find text content within protobuf fields
        for (const field of blobAnalysis.protoFields || []) {
          if (field.text && field.text.length > 50) {
            debugLog(`[KV-BLOB]   field${field.num} text: ${field.text.slice(0, 100)}...`);
            // Check if this might be assistant content
            if (!field.text.startsWith('{') && !field.text.startsWith('[')) {
              debugLog(`[KV-BLOB]   ✓ Possible assistant text in protobuf field ${field.num}`);
              // Store it for potential use
              this.pendingAssistantBlobs.push({ blobId: `${key}:f${field.num}`, content: field.text });
            }
          }
        }
      } else {
        debugLog(`[KV-BLOB]   Binary data (hex start): ${Buffer.from(kvMsg.blobData.slice(0, 32)).toString('hex')}`);
      }

      // SetBlobResult: empty = no error
      const result = new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'set_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);

      await this.bidiAppend(requestId, appendSeqno, responseMsg);
      return appendSeqno + 1n;
    }
    return appendSeqno;
  }

  /**
   * Send a tool result back to the server (for MCP tools only)
   * This must be called during an active chat stream when an exec_request chunk is received
   */
  async sendToolResult(
    execRequest: McpExecRequest & { type: 'mcp' },
    result: { success?: { content: string; isError?: boolean }; error?: string }
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send tool result");
    }

    debugLog("[DEBUG] Sending tool result for exec id:", execRequest.id, "result:", result.success ? "success" : "error");

    // Build ExecClientMessage with mcp_result
    const execClientMsg = buildExecClientMessage(
      execRequest.id,
      execRequest.execId,
      result
    );
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    // Send the result
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Tool result sent, new seqno:", this.currentAppendSeqno);

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(execRequest.id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Stream close sent for exec id:", execRequest.id);
  }

  /**
   * Send a shell execution result back to the server
   */
  async sendShellResult(
    id: number,
    execId: string | undefined,
    command: string,
    cwd: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    executionTimeMs?: number
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send shell result");
    }

    debugLog("[DEBUG] Sending shell result for id:", id, "exitCode:", exitCode);

    const execClientMsg = buildExecClientMessageWithShellResult(id, execId, command, cwd, stdout, stderr, exitCode, executionTimeMs);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send an LS result back to the server
   */
  async sendLsResult(id: number, execId: string | undefined, filesString: string): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send ls result");
    }

    debugLog("[DEBUG] Sending ls result for id:", id);

    const execClientMsg = buildExecClientMessageWithLsResult(id, execId, filesString);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a request context result back to the server
   */
  async sendRequestContextResult(id: number, execId: string | undefined): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send request context result");
    }

    debugLog("[DEBUG] Sending request context result for id:", id);

    const execClientMsg = buildExecClientMessageWithRequestContextResult(id, execId);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a file read result back to the server
   */
  async sendReadResult(
    id: number,
    execId: string | undefined,
    content: string,
    path: string,
    totalLines?: number,
    fileSize?: bigint,
    truncated?: boolean
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send read result");
    }

    debugLog("[DEBUG] Sending read result for id:", id, "path:", path, "contentLength:", content.length);

    const execClientMsg = buildExecClientMessageWithReadResult(id, execId, content, path, totalLines, fileSize, truncated);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a grep/glob result back to the server
   */
  async sendGrepResult(
    id: number,
    execId: string | undefined,
    pattern: string,
    path: string,
    files: string[]
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send grep result");
    }

    debugLog("[DEBUG] Sending grep result for id:", id, "pattern:", pattern, "files:", files.length);

    const execClientMsg = buildExecClientMessageWithGrepResult(id, execId, pattern, path, files);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Send a file write result back to the server
   */
  async sendWriteResult(
    id: number,
    execId: string | undefined,
    result: { 
      success?: { path: string; linesCreated: number; fileSize: number; fileContentAfterWrite?: string }; 
      error?: { path: string; error: string };
    }
  ): Promise<void> {
    if (!this.currentRequestId) {
      throw new Error("No active chat stream - cannot send write result");
    }

    debugLog("[DEBUG] Sending write result for id:", id, "result:", result.success ? "success" : "error");

    const execClientMsg = buildExecClientMessageWithWriteResult(id, execId, result);
    const responseMsg = buildAgentClientMessageWithExec(execClientMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno++;

    // Send stream close control message
    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);

    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno++;

    debugLog("[DEBUG] Stream close sent for exec id:", id);
  }

  /**
   * Result of parsing an InteractionUpdate message
   */
  private parseInteractionUpdate(data: Uint8Array): {
    text: string | null;
    isComplete: boolean;
    isHeartbeat: boolean;
    toolCallStarted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null;
    toolCallCompleted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null;
    partialToolCall: { callId: string; argsTextDelta: string } | null;
  } {
    const fields = parseProtoFields(data);
    // Log all fields in InteractionUpdate for debugging
    debugLog("[DEBUG] InteractionUpdate fields:", fields.map(f => `field${f.fieldNumber}`).join(", "));

    let text: string | null = null;
    let isComplete = false;
    let isHeartbeat = false;
    let toolCallStarted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null = null;
    let toolCallCompleted: { callId: string; modelCallId: string; toolType: string; name: string; arguments: string } | null = null;
    let partialToolCall: { callId: string; argsTextDelta: string } | null = null;

    for (const field of fields) {
      // field 1 = text_delta (TextDeltaUpdate)
      if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const innerFields = parseProtoFields(field.value);
        for (const innerField of innerFields) {
          if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
            text = new TextDecoder().decode(innerField.value);
          }
        }
      }
      // field 2 = tool_call_started (ToolCallStartedUpdate)
      else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
        debugLog("[DEBUG] Found tool_call_started (field 2)!");
        const parsed = parseToolCallStartedUpdate(field.value);
        if (parsed.toolCall) {
          toolCallStarted = {
            callId: parsed.callId,
            modelCallId: parsed.modelCallId,
            toolType: parsed.toolCall.toolType,
            name: parsed.toolCall.name,
            arguments: JSON.stringify(parsed.toolCall.arguments),
          };
        }
      }
      // field 3 = tool_call_completed (ToolCallCompletedUpdate)
      else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
        debugLog("[DEBUG] Found tool_call_completed (field 3)!");
        const parsed = parseToolCallStartedUpdate(field.value); // Same structure as started
        if (parsed.toolCall) {
          toolCallCompleted = {
            callId: parsed.callId,
            modelCallId: parsed.modelCallId,
            toolType: parsed.toolCall.toolType,
            name: parsed.toolCall.name,
            arguments: JSON.stringify(parsed.toolCall.arguments),
          };
        }
      }
      // field 7 = partial_tool_call (PartialToolCallUpdate)
      else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
        debugLog("[DEBUG] Found partial_tool_call (field 7)!");
        const parsed = parsePartialToolCallUpdate(field.value);
        partialToolCall = {
          callId: parsed.callId,
          argsTextDelta: parsed.argsTextDelta,
        };
      }
      // field 8 = token_delta (TokenDeltaUpdate)
      else if (field.fieldNumber === 8 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const tokenFields = parseProtoFields(field.value);
        for (const tField of tokenFields) {
          if (tField.fieldNumber === 1 && tField.wireType === 2 && tField.value instanceof Uint8Array) {
            text = new TextDecoder().decode(tField.value);
          }
        }
      }
      // field 14 = turn_ended (TurnEndedUpdate)
      else if (field.fieldNumber === 14) {
        debugLog("[DEBUG] Found turn_ended (field 14)!");
        isComplete = true;
      }
      // field 13 = heartbeat
      else if (field.fieldNumber === 13) {
        isHeartbeat = true;
      }
    }

    return { text, isComplete, isHeartbeat, toolCallStarted, toolCallCompleted, partialToolCall };
  }

  /**
   * Send a streaming chat request using BidiSse pattern
   */
  async *chatStream(request: AgentChatRequest): AsyncGenerator<AgentStreamChunkType> {
    const metrics = createTimingMetrics();
    const requestId = randomUUID();

    const messageBody = this.buildChatMessage(request);
    metrics.messageBuildMs = Date.now() - metrics.requestStart;

    let appendSeqno = 0n;
    // Heartbeats are frequent; be generous to avoid premature turn cuts
    const HEARTBEAT_IDLE_MS_PROGRESS = 120000; // 2 minutes idle after progress
    const HEARTBEAT_MAX_PROGRESS = 1000; // generous beat budget once progress observed
    const HEARTBEAT_IDLE_MS_NOPROGRESS = 180000; // 3 minutes before first progress
    const HEARTBEAT_MAX_NOPROGRESS = 1000;
    let lastProgressAt = Date.now();
    let heartbeatSinceProgress = 0;
    let hasProgress = false;
    const markProgress = () => {
      heartbeatSinceProgress = 0;
      lastProgressAt = Date.now();
      hasProgress = true;
    };

    // Store for tool result submission
    this.currentRequestId = requestId;
    this.currentAppendSeqno = 0n;

    // Build BidiRequestId message for RunSSE
    const bidiRequestId = encodeBidiRequestId(requestId);
    const envelope = addConnectEnvelope(bidiRequestId);

    // Start the SSE stream
    const sseUrl = `${this.baseUrl}/agent.v1.AgentService/RunSSE`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const ssePromise = fetch(sseUrl, {
        method: "POST",
        headers: this.getHeaders(requestId),
        body: Buffer.from(envelope),
        signal: controller.signal,
      });

      // Send initial message
      await this.bidiAppend(requestId, appendSeqno++, messageBody);
      metrics.firstBidiAppendMs = Date.now() - metrics.requestStart;
      this.currentAppendSeqno = appendSeqno;

      const sseResponse = await ssePromise;
      metrics.sseConnectionMs = Date.now() - metrics.requestStart;

      debugLog(`[TIMING] Request sent: build=${metrics.messageBuildMs}ms, append=${metrics.firstBidiAppendMs}ms, response=${metrics.sseConnectionMs}ms`);

      if (!sseResponse.ok) {
        clearTimeout(timeout);
        const errorText = await sseResponse.text();
        yield { type: "error", error: `SSE stream failed: ${sseResponse.status} - ${errorText}` };
        return;
      }

      if (!sseResponse.body) {
        clearTimeout(timeout);
        yield { type: "error", error: "No response body from SSE stream" };
        return;
      }

      const reader = sseResponse.body.getReader();
      let buffer = new Uint8Array(0);
      let turnEnded = false;
      let firstContentLogged = false;
      let hasStreamedText = false; // Track if we received any text via streaming
      
      // Clear any pending assistant blobs from previous requests
      this.pendingAssistantBlobs = [];

      try {
        while (!turnEnded) {
          const { done, value } = await reader.read();

          if (done) {
            yield { type: "done" };
            break;
          }

          if (!firstContentLogged) {
            metrics.firstChunkMs = Date.now() - metrics.requestStart;
            debugLog(`[TIMING] First chunk received in ${metrics.firstChunkMs}ms`);
            firstContentLogged = true;
          }

          // Append to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          // Parse frames
          let offset = 0;
          while (offset + 5 <= buffer.length) {
            const flags = buffer[offset] ?? 0;
            const b1 = buffer[offset + 1] ?? 0;
            const b2 = buffer[offset + 2] ?? 0;
            const b3 = buffer[offset + 3] ?? 0;
            const b4 = buffer[offset + 4] ?? 0;
            const length = (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;

            if (offset + 5 + length > buffer.length) break;

            const frameData = buffer.slice(offset + 5, offset + 5 + length);
            offset += 5 + length;

            // Check for trailer frame
            if ((flags ?? 0) & 0x80) {
              const trailer = new TextDecoder().decode(frameData);
              debugLog("Received trailer frame:", trailer.slice(0, 200));
              if (trailer.includes("grpc-status:") && !trailer.includes("grpc-status: 0")) {
                const match = trailer.match(/grpc-message:\s*([^\r\n]+)/);
                const errorMsg = decodeURIComponent(match?.[1] ?? "Unknown gRPC error");
                console.error("gRPC error:", errorMsg);
                yield { type: "error", error: errorMsg };
              }
              continue;
            }

            // Parse AgentServerMessage
            metrics.chunkCount++;
            const serverMsgFields = parseProtoFields(frameData);
            debugLog("[DEBUG] Server message fields:", serverMsgFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));

            for (const field of serverMsgFields) {
              try {
                // field 1 = interaction_update
                if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received interaction_update, length:", field.value.length);
                  const parsed = this.parseInteractionUpdate(field.value);

                  // Yield text content
                  if (parsed.text) {
                    if (metrics.firstTextMs === undefined) {
                      metrics.firstTextMs = Date.now() - metrics.requestStart;
                    }
                    metrics.textChunks++;
                    yield { type: "text", content: parsed.text };
                    hasStreamedText = true;
                    markProgress();
                  }

                  // Yield tool call started
                  if (parsed.toolCallStarted) {
                    if (metrics.firstToolCallMs === undefined) {
                      metrics.firstToolCallMs = Date.now() - metrics.requestStart;
                    }
                    metrics.toolCalls++;
                    yield {
                      type: "tool_call_started",
                      toolCall: {
                        callId: parsed.toolCallStarted.callId,
                        modelCallId: parsed.toolCallStarted.modelCallId,
                        toolType: parsed.toolCallStarted.toolType,
                        name: parsed.toolCallStarted.name,
                        arguments: parsed.toolCallStarted.arguments,
                      },
                    };
                    markProgress();
                  }

                  // Yield tool call completed
                  if (parsed.toolCallCompleted) {
                    yield {
                      type: "tool_call_completed",
                      toolCall: {
                        callId: parsed.toolCallCompleted.callId,
                        modelCallId: parsed.toolCallCompleted.modelCallId,
                        toolType: parsed.toolCallCompleted.toolType,
                        name: parsed.toolCallCompleted.name,
                        arguments: parsed.toolCallCompleted.arguments,
                      },
                    };
                    markProgress();
                  }

                  // Yield partial tool call updates
                  if (parsed.partialToolCall) {
                    yield {
                      type: "partial_tool_call",
                      toolCall: {
                        callId: parsed.partialToolCall.callId,
                        modelCallId: undefined,
                        toolType: "partial",
                        name: "partial",
                        arguments: "",
                      },
                      partialArgs: parsed.partialToolCall.argsTextDelta,
                    };
                    markProgress();
                  }

                  if (parsed.isComplete) {
                    metrics.turnEndedMs = Date.now() - metrics.requestStart;
                    turnEnded = true;
                  }

                  // Yield heartbeat events for the server to track
                  if (parsed.isHeartbeat) {
                    metrics.heartbeats++;
                    heartbeatSinceProgress++;
                    const idleMs = Date.now() - lastProgressAt;
                    const idleLimit = hasProgress ? HEARTBEAT_IDLE_MS_PROGRESS : HEARTBEAT_IDLE_MS_NOPROGRESS;
                    const beatLimit = hasProgress ? HEARTBEAT_MAX_PROGRESS : HEARTBEAT_MAX_NOPROGRESS;
                    if (heartbeatSinceProgress >= beatLimit || idleMs >= idleLimit) {
                      console.warn(
                        `[DEBUG] Heartbeat idle for ${idleMs}ms (${heartbeatSinceProgress} beats) - closing stream`
                      );
                      turnEnded = true;
                    } else {
                      yield { type: "heartbeat" };
                    }
                  }
                }

                // field 3 = conversation_checkpoint_update (completion signal)
                // NOTE: Checkpoint does NOT mean we're done! exec_server_message can come AFTER checkpoint.
                // Only end on turn_ended (field 14 in interaction_update) or stream close.
                if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received checkpoint, data length:", field.value.length);
                  // Try to parse checkpoint to see what it contains
                  const checkpointFields = parseProtoFields(field.value);
                  debugLog("[DEBUG] Checkpoint fields:", checkpointFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
                  for (const cf of checkpointFields) {
                    if (cf.wireType === 2 && cf.value instanceof Uint8Array) {
                      try {
                        const text = new TextDecoder().decode(cf.value);
                        if (text.length < 200) {
                          debugLog(`[DEBUG] Checkpoint field ${cf.fieldNumber}: ${text}`);
                        }
                      } catch {}
                    }
                  }
                  yield { type: "checkpoint" };
                  markProgress();
                  // DO NOT set turnEnded here - exec messages may follow!
                }

                // field 2 = exec_server_message (tool execution request)
                if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received exec_server_message (field 2), length:", field.value.length);

                  // Parse the ExecServerMessage
                  const execRequest = parseExecServerMessage(field.value);

                  if (execRequest) {
                    // Log based on type
                    if (execRequest.type === 'mcp') {
                      debugLog("[DEBUG] Parsed MCP exec request:", {
                        id: execRequest.id,
                        name: execRequest.name,
                        toolName: execRequest.toolName,
                        providerIdentifier: execRequest.providerIdentifier,
                        toolCallId: execRequest.toolCallId,
                        args: execRequest.args,
                      });
                    } else {
                      debugLog(`[DEBUG] Parsed ${execRequest.type} exec request:`, execRequest);
                    }

                    // Yield exec_request chunk for the server to handle
                    metrics.execRequests++;
                    yield {
                      type: "exec_request",
                      execRequest,
                    };
                    markProgress();
                  } else {
                    // Log other exec types we don't handle yet
                    const execFields = parseProtoFields(field.value);
                    debugLog("[DEBUG] exec_server_message fields (unhandled):", execFields.map(f => `field${f.fieldNumber}`).join(", "));
                  }
                }

                // field 4 = kv_server_message
                if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  metrics.kvMessages++;
                  const kvMsg = parseKvServerMessage(field.value);
                  debugLog(`[DEBUG] KV message: id=${kvMsg.id}, type=${kvMsg.messageType}, blobId=${kvMsg.blobId ? Buffer.from(kvMsg.blobId).toString('hex').slice(0, 20) : 'none'}...`);
                  appendSeqno = await this.handleKvMessage(kvMsg, requestId, appendSeqno);
                  this.currentAppendSeqno = appendSeqno;
                }

                // field 5 = exec_server_control_message (abort signal from server)
                if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received exec_server_control_message (field 5)!");
                  const controlFields = parseProtoFields(field.value);
                  debugLog("[DEBUG] exec_server_control_message fields:", controlFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
                  
                  // ExecServerControlMessage has field 1 = abort (ExecServerAbort)
                  for (const cf of controlFields) {
                    if (cf.fieldNumber === 1 && cf.wireType === 2 && cf.value instanceof Uint8Array) {
                      debugLog("[DEBUG] Server sent abort signal!");
                      // Parse ExecServerAbort - it has field 1 = id (string)
                      const abortFields = parseProtoFields(cf.value);
                      for (const af of abortFields) {
                        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
                          const abortId = new TextDecoder().decode(af.value);
                          debugLog("[DEBUG] Abort id:", abortId);
                        }
                      }
                      yield { type: "exec_server_abort" };
                    }
                  }
                  markProgress();
                }

                // field 7 = interaction_query (server asking for user approval/input)
                if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  debugLog("[DEBUG] Received interaction_query (field 7)!");
                  const queryFields = parseProtoFields(field.value);
                  debugLog("[DEBUG] interaction_query fields:", queryFields.map(f => `field${f.fieldNumber}:${f.wireType}`).join(", "));
                  
                  // InteractionQuery structure:
                  // field 1 = id (uint32)
                  // field 2 = web_search_request_query (oneof)
                  // field 3 = ask_question_interaction_query (oneof)
                  // field 4 = switch_mode_request_query (oneof)
                  // field 5 = exa_search_request_query (oneof)
                  // field 6 = exa_fetch_request_query (oneof)
                  let queryId = 0;
                  let queryType = 'unknown';
                  
                  for (const qf of queryFields) {
                    if (qf.fieldNumber === 1 && qf.wireType === 0) {
                      queryId = Number(qf.value);
                    } else if (qf.fieldNumber === 2 && qf.wireType === 2) {
                      queryType = 'web_search';
                    } else if (qf.fieldNumber === 3 && qf.wireType === 2) {
                      queryType = 'ask_question';
                    } else if (qf.fieldNumber === 4 && qf.wireType === 2) {
                      queryType = 'switch_mode';
                    } else if (qf.fieldNumber === 5 && qf.wireType === 2) {
                      queryType = 'exa_search';
                    } else if (qf.fieldNumber === 6 && qf.wireType === 2) {
                      queryType = 'exa_fetch';
                    }
                  }
                  
                  debugLog(`[DEBUG] InteractionQuery: id=${queryId}, type=${queryType}`);
                  
                  // Yield the interaction query for the server to handle
                  yield {
                    type: "interaction_query",
                    queryId,
                    queryType,
                  };
                  markProgress();
                }
              } catch (parseErr) {
                const error = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
                console.error("Error parsing field:", field.fieldNumber, error);
                yield { type: "error", error: `Parse error in field ${field.fieldNumber}: ${error.message}` };
              }
            }

            if (turnEnded) {
              break;
            }
          }

          buffer = buffer.slice(offset);
        }

        // Clean exit - check for KV blob assistant responses if no text was streamed
        if (turnEnded) {
          controller.abort(); // Clean up the connection
          logTimingMetrics(metrics);
          
          // Session reuse: If no text was streamed but we have pending assistant blobs,
          // emit them as kv_blob_assistant chunks so the server can use the content
          if (!hasStreamedText && this.pendingAssistantBlobs.length > 0) {
            debugLog(`[DEBUG] No streamed text but found ${this.pendingAssistantBlobs.length} assistant blob(s) - emitting`);
            for (const blob of this.pendingAssistantBlobs) {
              yield { type: "kv_blob_assistant", blobContent: blob.content };
            }
          }
          
          yield { type: "done" };
        }
      } finally {
        reader.releaseLock();
        clearTimeout(timeout);
        this.currentRequestId = null;
      }
    } catch (err: unknown) {
      clearTimeout(timeout);
      this.currentRequestId = null;
      const error = err as Error & { name?: string };
      if (error.name === 'AbortError') {
        // Normal termination after turn ended
        return;
      }
      console.error("Agent stream error:", error.name, error.message, (err as Error).stack);
      yield { type: "error", error: error.message || String(err) };
    }
  }

  /**
   * Send a non-streaming chat request (collects all chunks)
   */
  async chat(request: AgentChatRequest): Promise<string> {
    let result = "";

    for await (const chunk of this.chatStream(request)) {
      if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Unknown error");
      }
      if (chunk.type === "text" && chunk.content) {
        result += chunk.content;
      }
    }

    return result;
  }
}

/**
 * Create an Agent Service client
 */
export function createAgentServiceClient(
  accessToken: string,
  options?: AgentServiceOptions
): AgentServiceClient {
  return new AgentServiceClient(accessToken, options);
}
