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

// Cursor API URL (main API)
export const CURSOR_API_URL = "https://api2.cursor.sh";

// Agent backends
export const AGENT_PRIVACY_URL = "https://agent.api5.cursor.sh";
export const AGENT_NON_PRIVACY_URL = "https://agentn.api5.cursor.sh";

// Agent modes
export enum AgentMode {
  UNSPECIFIED = 0,
  AGENT = 1,
  ASK = 2,
  PLAN = 3,
  DEBUG = 4,
  TRIAGE = 5,
}

// --- Protobuf Encoding Helpers ---

function encodeVarint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  if (!value) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 2; // wire type 2 = length-delimited
  const encoded = new TextEncoder().encode(value);
  const length = encodeVarint(encoded.length);
  
  const result = new Uint8Array(1 + length.length + encoded.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(encoded, 1 + length.length);
  
  return result;
}

function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  const encoded = encodeVarint(value);
  
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  
  return result;
}

function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  const encoded = encodeVarint(value);
  
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  
  return result;
}

function encodeInt64Field(fieldNumber: number, value: bigint): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 0; // wire type 0 = varint
  const encoded = encodeVarint(value);
  
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  
  return result;
}

function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 2; // wire type 2 = length-delimited
  const length = encodeVarint(data.length);
  
  const result = new Uint8Array(1 + length.length + data.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(data, 1 + length.length);
  
  return result;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
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
    encodeStringField(1, `darwin 24.0.0`),
    encodeStringField(2, workspacePath),
    encodeStringField(3, '/bin/zsh'),
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),
    encodeStringField(11, workspacePath),
  );
}

/**
 * Build RequestContext
 * field 4: env (RequestContextEnv)
 */
function buildRequestContext(workspacePath?: string): Uint8Array {
  const env = buildRequestContextEnv(workspacePath);
  return encodeMessageField(4, env);
}

/**
 * Encode UserMessage
 * - text: field 1 (string)
 * - message_id: field 2 (string)
 * - mode: field 4 (enum/int32)
 */
function encodeUserMessage(text: string, messageId: string, mode: AgentMode = AgentMode.ASK): Uint8Array {
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
 * Encode AgentRunRequest
 * - conversation_state: field 1 (ConversationStateStructure) - required, empty for new conversation
 * - action: field 2 (ConversationAction)
 * - model_details: field 3 (ModelDetails)
 * - conversation_id: field 5 (string, optional)
 */
function encodeAgentRunRequest(
  action: Uint8Array,
  modelDetails: Uint8Array,
  conversationId?: string
): Uint8Array {
  const conversationState = encodeEmptyConversationState();
  
  return concatBytes(
    encodeMessageField(1, conversationState),
    encodeMessageField(2, action),
    encodeMessageField(3, modelDetails),
    conversationId ? encodeStringField(5, conversationId) : new Uint8Array(0)
  );
}

/**
 * Encode AgentClientMessage with run_request
 * - run_request: field 1 (AgentRunRequest)
 */
function encodeAgentClientMessage(runRequest: Uint8Array): Uint8Array {
  return encodeMessageField(1, runRequest);
}

/**
 * Build KvClientMessage
 * KvClientMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_result (GetBlobResult)
 *   field 3: set_blob_result (SetBlobResult)
 */
function buildKvClientMessage(id: number, resultType: 'get_blob_result' | 'set_blob_result', result: Uint8Array): Uint8Array {
  const fieldNumber = resultType === 'get_blob_result' ? 2 : 3;
  return concatBytes(
    encodeUint32Field(1, id),
    encodeMessageField(fieldNumber, result)
  );
}

/**
 * Build AgentClientMessage with kv_client_message
 * AgentClientMessage:
 *   field 3: kv_client_message (KvClientMessage)
 */
function buildAgentClientMessageWithKv(kvClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(3, kvClientMessage);
}

// --- Response Parsing ---

interface ParsedField {
  fieldNumber: number;
  wireType: number;
  value: Uint8Array | number | bigint;
}

function decodeVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  
  return { value, bytesRead };
}

function parseProtoFields(data: Uint8Array): ParsedField[] {
  const fields: ParsedField[] = [];
  let offset = 0;
  
  while (offset < data.length) {
    const tagInfo = decodeVarint(data, offset);
    offset += tagInfo.bytesRead;
    
    const fieldNumber = tagInfo.value >> 3;
    const wireType = tagInfo.value & 0x7;
    
    if (wireType === 2) { // length-delimited
      const lengthInfo = decodeVarint(data, offset);
      offset += lengthInfo.bytesRead;
      const value = data.slice(offset, offset + lengthInfo.value);
      offset += lengthInfo.value;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 0) { // varint
      const valueInfo = decodeVarint(data, offset);
      offset += valueInfo.bytesRead;
      fields.push({ fieldNumber, wireType, value: valueInfo.value });
    } else if (wireType === 1) { // 64-bit
      const value = data.slice(offset, offset + 8);
      offset += 8;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 5) { // 32-bit
      const value = data.slice(offset, offset + 4);
      offset += 4;
      fields.push({ fieldNumber, wireType, value });
    } else {
      break;
    }
  }
  
  return fields;
}

// --- KV Message Parsing ---

interface KvServerMessage {
  id: number;
  messageType: 'get_blob_args' | 'set_blob_args' | 'unknown';
  blobId?: Uint8Array;
  blobData?: Uint8Array;
}

function parseKvServerMessage(data: Uint8Array): KvServerMessage {
  const fields = parseProtoFields(data);
  const result: KvServerMessage = { id: 0, messageType: 'unknown' };
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = field.value as number;
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.messageType = 'get_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        }
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.messageType = 'set_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        } else if (af.fieldNumber === 2 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobData = af.value;
        }
      }
    }
  }
  
  return result;
}

// --- Stream Chunk Types ---

export interface AgentStreamChunk {
  type: "text" | "thinking" | "token" | "checkpoint" | "done" | "error";
  content?: string;
  error?: string;
}

// --- Agent Service Client ---

export interface AgentServiceOptions {
  baseUrl?: string;
  privacyMode?: boolean;
  workspacePath?: string;
}

export interface AgentChatRequest {
  message: string;
  model?: string;
  mode?: AgentMode;
  conversationId?: string;
}

export class AgentServiceClient {
  private baseUrl: string;
  private accessToken: string;
  private workspacePath: string;
  private blobStore: Map<string, Uint8Array>;

  constructor(accessToken: string, options: AgentServiceOptions = {}) {
    this.accessToken = accessToken;
    this.baseUrl = options.baseUrl ?? CURSOR_API_URL;
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.blobStore = new Map();
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
      "x-ghost-mode": "true",
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
    const requestContext = buildRequestContext(this.workspacePath);
    
    // Build the message hierarchy
    const userMessage = encodeUserMessage(request.message, messageId, mode);
    const userMessageAction = encodeUserMessageAction(userMessage, requestContext);
    const conversationAction = encodeConversationAction(userMessageAction);
    const modelDetails = encodeModelDetails(model);
    const agentRunRequest = encodeAgentRunRequest(conversationAction, modelDetails, conversationId);
    const agentClientMessage = encodeAgentClientMessage(agentRunRequest);

    return agentClientMessage;
  }

  /**
   * Call BidiAppend to send a client message
   */
  private async bidiAppend(requestId: string, appendSeqno: bigint, data: Uint8Array): Promise<void> {
    const hexData = Buffer.from(data).toString("hex");
    const appendRequest = encodeBidiAppendRequest(hexData, requestId, appendSeqno);
    const envelope = addConnectEnvelope(appendRequest);
    
    const url = `${this.baseUrl}/aiserver.v1.BidiService/BidiAppend`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(requestId),
      body: Buffer.from(envelope),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Handle KV server message and send response
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
    } else if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
      const key = this.blobIdToKey(kvMsg.blobId);
      this.blobStore.set(key, kvMsg.blobData);
      
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
   * Extract text from interaction_update
   */
  private extractTextFromInteractionUpdate(data: Uint8Array): { text: string | null; isComplete: boolean } {
    const fields = parseProtoFields(data);
    let text: string | null = null;
    let isComplete = false;
    
    for (const field of fields) {
      // field 1 = text_delta
      if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const innerFields = parseProtoFields(field.value);
        for (const innerField of innerFields) {
          if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
            text = new TextDecoder().decode(innerField.value);
          }
        }
      }
      // field 8 = token_delta
      else if (field.fieldNumber === 8 && field.wireType === 2 && field.value instanceof Uint8Array) {
        const tokenFields = parseProtoFields(field.value);
        for (const tField of tokenFields) {
          if (tField.fieldNumber === 1 && tField.wireType === 2 && tField.value instanceof Uint8Array) {
            text = new TextDecoder().decode(tField.value);
          }
        }
      }
      // field 14 = turn_ended
      else if (field.fieldNumber === 14) {
        isComplete = true;
      }
    }
    
    return { text, isComplete };
  }

  /**
   * Send a streaming chat request using BidiSse pattern
   */
  async *chatStream(request: AgentChatRequest): AsyncGenerator<AgentStreamChunk> {
    const requestId = randomUUID();
    const messageBody = this.buildChatMessage(request);
    let appendSeqno = 0n;

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

      const sseResponse = await ssePromise;

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

      try {
        while (!turnEnded) {
          const { done, value } = await reader.read();
          
          if (done) {
            yield { type: "done" };
            break;
          }

          // Append to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          // Parse frames
          let offset = 0;
          while (offset + 5 <= buffer.length) {
            const flags = buffer[offset];
            const length = (buffer[offset + 1]! << 24) |
                          (buffer[offset + 2]! << 16) |
                          (buffer[offset + 3]! << 8) |
                          buffer[offset + 4]!;
            
            if (offset + 5 + length > buffer.length) break;
            
            const frameData = buffer.slice(offset + 5, offset + 5 + length);
            offset += 5 + length;

            // Check for trailer frame
            if ((flags ?? 0) & 0x80) {
              const trailer = new TextDecoder().decode(frameData);
              if (trailer.includes("grpc-status:") && !trailer.includes("grpc-status: 0")) {
                const match = trailer.match(/grpc-message:\s*([^\r\n]+)/);
                yield { type: "error", error: decodeURIComponent(match?.[1] ?? trailer) };
              }
              continue;
            }

            // Parse AgentServerMessage
            const serverMsgFields = parseProtoFields(frameData);
            
            for (const field of serverMsgFields) {
              // field 1 = interaction_update
              if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
                const { text, isComplete } = this.extractTextFromInteractionUpdate(field.value);
                if (text) {
                  yield { type: "text", content: text };
                }
                if (isComplete) {
                  turnEnded = true;
                }
              }
              
              // field 3 = conversation_checkpoint_update (completion signal)
              if (field.fieldNumber === 3 && field.wireType === 2) {
                yield { type: "checkpoint" };
                turnEnded = true;
              }
              
              // field 4 = kv_server_message
              if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
                const kvMsg = parseKvServerMessage(field.value);
                appendSeqno = await this.handleKvMessage(kvMsg, requestId, appendSeqno);
              }
            }
          }
          
          buffer = buffer.slice(offset);
        }

        // Clean exit
        if (turnEnded) {
          controller.abort(); // Clean up the connection
          yield { type: "done" };
        }
      } finally {
        reader.releaseLock();
        clearTimeout(timeout);
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        // Normal termination after turn ended
        return;
      }
      yield { type: "error", error: err.message };
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
