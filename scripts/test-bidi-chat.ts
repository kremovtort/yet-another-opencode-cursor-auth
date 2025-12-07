/**
 * Full bidirectional chat flow with proper exec message handling
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
import { generateChecksum, addConnectEnvelope } from '../src/lib/api/cursor-client.ts';
import { randomUUID } from 'node:crypto';

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
  const fieldTag = (fieldNumber << 3) | 2;
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
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

function encodeInt64Field(fieldNumber: number, value: bigint): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 2;
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

// --- Proto Decoding Helpers ---
function decodeVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  
  return { value, bytesRead };
}

interface ParsedField {
  fieldNumber: number;
  wireType: number;
  value: Uint8Array | number;
}

function parseProtoFields(data: Uint8Array): ParsedField[] {
  const fields: ParsedField[] = [];
  let offset = 0;
  
  while (offset < data.length) {
    const tagInfo = decodeVarint(data, offset);
    offset += tagInfo.bytesRead;
    
    const fieldNumber = tagInfo.value >> 3;
    const wireType = tagInfo.value & 0x7;
    
    if (wireType === 2) {
      const lengthInfo = decodeVarint(data, offset);
      offset += lengthInfo.bytesRead;
      const value = data.slice(offset, offset + lengthInfo.value);
      offset += lengthInfo.value;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 0) {
      const valueInfo = decodeVarint(data, offset);
      offset += valueInfo.bytesRead;
      fields.push({ fieldNumber, wireType, value: valueInfo.value });
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  
  return fields;
}

// --- Message Types ---
interface ExecServerMessage {
  id: number;
  execId?: string;
  messageType: string;
  spanContext?: { traceId: string; spanId: string };
}

function parseExecServerMessage(data: Uint8Array): ExecServerMessage | null {
  const fields = parseProtoFields(data);
  const result: ExecServerMessage = { id: 0, messageType: 'unknown' };
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = field.value as number;
    } else if (field.fieldNumber === 15 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.execId = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 19 && field.wireType === 2 && field.value instanceof Uint8Array) {
      // SpanContext
      const spanFields = parseProtoFields(field.value);
      const spanContext: { traceId: string; spanId: string } = { traceId: '', spanId: '' };
      for (const sf of spanFields) {
        if (sf.fieldNumber === 1 && sf.wireType === 2 && sf.value instanceof Uint8Array) {
          spanContext.traceId = new TextDecoder().decode(sf.value);
        } else if (sf.fieldNumber === 2 && sf.wireType === 2 && sf.value instanceof Uint8Array) {
          spanContext.spanId = new TextDecoder().decode(sf.value);
        }
      }
      result.spanContext = spanContext;
    } else if (field.wireType === 2 && typeof field.fieldNumber === 'number') {
      // One of the message types
      const typeMap: Record<number, string> = {
        2: 'shell_args',
        3: 'write_args',
        4: 'delete_args',
        5: 'grep_args',
        7: 'read_args',
        8: 'ls_args',
        9: 'diagnostics_args',
        10: 'request_context_args',
        11: 'mcp_args',
        14: 'shell_stream_args',
        16: 'background_shell_spawn_args',
        17: 'list_mcp_resources_exec_args',
        18: 'read_mcp_resource_exec_args',
        20: 'fetch_args',
        21: 'record_screen_args',
        22: 'computer_use_args',
      };
      if (typeMap[field.fieldNumber]) {
        result.messageType = typeMap[field.fieldNumber]!;
      }
    }
  }
  
  return result;
}

// --- Build Response Messages ---

/**
 * Build RequestContextResult with minimal context
 * RequestContextResult:
 *   field 1: success (RequestContextSuccess)
 * RequestContextSuccess:
 *   field 1: request_context (RequestContext)
 * RequestContext:
 *   field 4: env (RequestContextEnv)
 *   field 11: git_repos (repeated GitRepoInfo)
 */
function buildRequestContextResult(): Uint8Array {
  // RequestContextEnv
  // field 1: os_version (string)
  // field 2: workspace_paths (repeated string) 
  // field 3: shell (string)
  // field 5: sandbox_enabled (bool)
  // field 10: time_zone (string)
  const workspacePath = process.cwd();
  const env = concatBytes(
    encodeStringField(1, `darwin 24.0.0`),      // os_version
    encodeStringField(2, workspacePath),         // workspace_paths (first)
    encodeStringField(3, '/bin/zsh'),            // shell
    // field 5 (sandbox_enabled) - skip, defaults to false
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),  // time_zone
    encodeStringField(11, workspacePath),        // project_folder
  );
  
  // RequestContext
  // field 4: env
  // field 11: git_repos (can be empty)
  const requestContext = concatBytes(
    encodeMessageField(4, env),
  );
  
  // RequestContextSuccess
  // field 1: request_context
  const success = encodeMessageField(1, requestContext);
  
  // RequestContextResult
  // field 1: success
  return encodeMessageField(1, success);
}

/**
 * Build ExecClientMessage
 * ExecClientMessage:
 *   field 1: id (uint32)
 *   field 15: exec_id (string)
 *   field 10: request_context_result (RequestContextResult)
 */
function buildExecClientMessage(id: number, execId: string, resultType: string, result: Uint8Array): Uint8Array {
  // Map result type to field number
  const fieldMap: Record<string, number> = {
    'request_context_result': 10,
    'shell_result': 2,
    'write_result': 3,
    'delete_result': 4,
    'grep_result': 5,
    'read_result': 7,
    'ls_result': 8,
    'diagnostics_result': 9,
    'mcp_result': 11,
  };
  
  const fieldNumber = fieldMap[resultType] ?? 10;
  
  return concatBytes(
    encodeUint32Field(1, id),
    execId ? encodeStringField(15, execId) : new Uint8Array(0),
    encodeMessageField(fieldNumber, result)
  );
}

/**
 * Build AgentClientMessage with exec_client_message
 * AgentClientMessage:
 *   field 2: exec_client_message (ExecClientMessage)
 */
function buildAgentClientMessageWithExec(execClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(2, execClientMessage);
}

// --- KV Message Handling ---

/**
 * Parse KvServerMessage
 * KvServerMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_args (GetBlobArgs)
 *   field 3: set_blob_args (SetBlobArgs)
 * 
 * GetBlobArgs:
 *   field 1: blob_id (bytes)
 * 
 * SetBlobArgs:
 *   field 1: blob_id (bytes)
 *   field 2: blob_data (bytes)
 */
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
      // Parse GetBlobArgs
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        }
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.messageType = 'set_blob_args';
      // Parse SetBlobArgs
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

/**
 * Build KvClientMessage
 * KvClientMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_result (GetBlobResult)
 *   field 3: set_blob_result (SetBlobResult)
 * 
 * GetBlobResult:
 *   field 1: blob_data (bytes, optional)
 * 
 * SetBlobResult:
 *   field 1: error (Error, optional)
 */
function buildGetBlobResult(blobData?: Uint8Array): Uint8Array {
  if (!blobData) {
    return new Uint8Array(0); // Empty = not found
  }
  return encodeMessageField(1, blobData);
}

function buildSetBlobResult(errorMessage?: string): Uint8Array {
  if (!errorMessage) {
    return new Uint8Array(0); // No error
  }
  // Error message: field 1 = message (string)
  const errorProto = encodeStringField(1, errorMessage);
  return encodeMessageField(1, errorProto);
}

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

// Simple in-memory blob store for the session
const blobStore = new Map<string, Uint8Array>();

function blobIdToKey(blobId: Uint8Array): string {
  return Buffer.from(blobId).toString('hex');
}

// --- BidiAppend ---
async function bidiAppend(
  requestId: string, 
  appendSeqno: bigint, 
  data: Uint8Array,
  headers: Record<string, string>
): Promise<void> {
  const hexData = Buffer.from(data).toString("hex");
  const bidiRequestIdMsg = encodeStringField(1, requestId);
  const bidiAppendRequest = concatBytes(
    encodeStringField(1, hexData),
    encodeMessageField(2, bidiRequestIdMsg),
    encodeInt64Field(3, appendSeqno)
  );
  
  const response = await fetch("https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend", {
    method: "POST",
    headers,
    body: Buffer.from(addConnectEnvelope(bidiAppendRequest)),
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`BidiAppend failed: ${response.status} - ${text}`);
  }
}

// --- Main ---
async function main() {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('No token - please authenticate first');

  const checksum = generateChecksum(token);
  const requestId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  
  console.log('Request ID:', requestId);
  console.log('Conversation ID:', conversationId);
  
  const headers = {
    "authorization": `Bearer ${token}`,
    "content-type": "application/grpc-web+proto",
    "user-agent": "connect-es/1.4.0",
    "x-cursor-checksum": checksum,
    "x-cursor-client-version": "cli-2025.11.25-d5b3271",
    "x-cursor-client-type": "cli",
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "x-ghost-mode": "true",
    "x-request-id": requestId,
  };
  
  // Build RequestContextEnv
  // field 1: os_version, field 2: workspace_paths (repeated), field 3: shell,
  // field 10: time_zone, field 11: project_folder
  const workspacePath = process.cwd();
  const requestContextEnv = concatBytes(
    encodeStringField(1, `darwin 24.0.0`),           // os_version
    encodeStringField(2, workspacePath),              // workspace_paths
    encodeStringField(3, '/bin/zsh'),                 // shell
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),  // time_zone
    encodeStringField(11, workspacePath),             // project_folder
  );
  
  // Build RequestContext
  // field 4: env
  const requestContext = encodeMessageField(4, requestContextEnv);
  
  // Build UserMessage
  // field 1: text, field 2: message_id, field 4: mode
  const userMessage = concatBytes(
    encodeStringField(1, "Write a haiku about programming."),
    encodeStringField(2, messageId),
    encodeInt32Field(4, 1)  // mode = AGENT (try 1 instead of ASK=2)
  );
  
  // Build UserMessageAction
  // field 1: user_message, field 2: request_context
  const userMessageAction = concatBytes(
    encodeMessageField(1, userMessage),
    encodeMessageField(2, requestContext)
  );
  
  // Build ConversationAction
  // field 1: user_message_action
  const conversationAction = encodeMessageField(1, userMessageAction);
  
  const modelDetails = encodeStringField(1, "gpt-4o");
  const emptyConvState = new Uint8Array(0);
  const agentRunRequest = concatBytes(
    encodeMessageField(1, emptyConvState),
    encodeMessageField(2, conversationAction),
    encodeMessageField(3, modelDetails),
    encodeStringField(5, conversationId)
  );
  const agentClientMessage = encodeMessageField(1, agentRunRequest);
  
  // Start SSE stream
  console.log('\n=== Starting RunSSE stream ===');
  const bidiRequestId = encodeStringField(1, requestId);
  const sseEnvelope = addConnectEnvelope(bidiRequestId);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.log('\n=== Timeout ===');
    controller.abort();
  }, 60000);
  
  const ssePromise = fetch("https://api2.cursor.sh/agent.v1.AgentService/RunSSE", {
    method: "POST",
    headers,
    body: Buffer.from(sseEnvelope),
    signal: controller.signal,
  });
  
  // Send initial message
  console.log('=== Sending initial BidiAppend ===');
  let appendSeqno = 0n;
  await bidiAppend(requestId, appendSeqno++, agentClientMessage, headers);
  console.log('Initial message sent');
  
  // Process SSE stream
  try {
    const sseResponse = await ssePromise;
    console.log('SSE status:', sseResponse.status);
    
    if (!sseResponse.body) {
      console.log('No body!');
      return;
    }
    
    const reader = sseResponse.body.getReader();
    let buffer = new Uint8Array(0);
    let fullText = '';
    let turnEnded = false;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('\nStream done!');
        break;
      }
      
      // Reset activity timer on any data received
      
      // Append to buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;
      
      // Parse frames
      let offset = 0;
      while (offset + 5 <= buffer.length) {
        const flags = buffer[offset];
        const length = (buffer[offset + 1]! << 24) | (buffer[offset + 2]! << 16) | 
                       (buffer[offset + 3]! << 8) | buffer[offset + 4]!;
        
        if (offset + 5 + length > buffer.length) break;
        
        const frameData = buffer.slice(offset + 5, offset + 5 + length);
        offset += 5 + length;
        
        if ((flags ?? 0) & 0x80) {
          // Trailer
          const trailer = new TextDecoder().decode(frameData);
          console.log('\nTrailer:', trailer);
          continue;
        }
        
        // Parse AgentServerMessage
        const serverMsgFields = parseProtoFields(frameData);
        
        // Log all top-level fields for debugging
        const topLevelNames: Record<number, string> = {
          1: 'interaction_update',
          2: 'exec_server_message',
          3: 'conversation_checkpoint_update',
          4: 'kv_server_message',
          5: 'exec_server_control_message',
          7: 'interaction_query',
        };
        
        // Debug: log raw frame data hex
        console.log(`\n[FRAME len=${frameData.length}] ${Buffer.from(frameData).toString('hex').slice(0, 100)}...`);
        
        for (const f of serverMsgFields) {
          if (!topLevelNames[f.fieldNumber]) {
            console.log(`\n[unknown_server_msg_field_${f.fieldNumber}]`);
          }
        }
        
        for (const field of serverMsgFields) {
          // field 1 = interaction_update
          if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
            const interactionFields = parseProtoFields(field.value);
            for (const iField of interactionFields) {
              // Log all interaction field types we see
              const interactionTypes: Record<number, string> = {
                1: 'text_delta',
                2: 'tool_call_started',
                3: 'tool_call_completed',
                4: 'thinking_delta',
                5: 'thinking_completed',
                6: 'user_message_appended',
                7: 'partial_tool_call',
                8: 'token_delta',
                9: 'summary',
                10: 'summary_started',
                11: 'summary_completed',
                12: 'shell_output_delta',
                13: 'heartbeat',
                14: 'turn_ended',
                15: 'tool_call_delta',
                16: 'step_started',
              };
              const iFieldName = interactionTypes[iField.fieldNumber] || `unknown_${iField.fieldNumber}`;
              
              // field 1 = text_delta
              if (iField.fieldNumber === 1 && iField.wireType === 2 && iField.value instanceof Uint8Array) {
                const deltaFields = parseProtoFields(iField.value);
                for (const dField of deltaFields) {
                  if (dField.fieldNumber === 1 && dField.wireType === 2 && dField.value instanceof Uint8Array) {
                    const text = new TextDecoder().decode(dField.value);
                    process.stdout.write(text);
                    fullText += text;
                  }
                }
              }
              // field 4 = thinking_delta
              else if (iField.fieldNumber === 4 && iField.wireType === 2 && iField.value instanceof Uint8Array) {
                const deltaFields = parseProtoFields(iField.value);
                for (const dField of deltaFields) {
                  if (dField.fieldNumber === 1 && dField.wireType === 2 && dField.value instanceof Uint8Array) {
                    const text = new TextDecoder().decode(dField.value);
                    process.stdout.write(`[thinking: ${text}]`);
                  }
                }
              }
              // field 8 = token_delta - contains actual text tokens
              else if (iField.fieldNumber === 8 && iField.wireType === 2 && iField.value instanceof Uint8Array) {
                const tokenFields = parseProtoFields(iField.value);
                for (const tField of tokenFields) {
                  // field 1 = tokens (repeated string)
                  if (tField.fieldNumber === 1 && tField.wireType === 2 && tField.value instanceof Uint8Array) {
                    const text = new TextDecoder().decode(tField.value);
                    process.stdout.write(text);
                    fullText += text;
                  }
                }
              }
              // field 13 = heartbeat
              else if (iField.fieldNumber === 13) {
                // Heartbeat - just log it
                // console.log('\n[heartbeat]');
              }
              // field 14 = turn_ended
              else if (iField.fieldNumber === 14) {
                console.log('\n[turn_ended] - received!');
                turnEnded = true;
              }
              // Log other fields we don't handle - with value info
              else {
                const valueInfo = iField.wireType === 0 ? `value=${iField.value}` : 
                  iField.value instanceof Uint8Array ? `bytes(${iField.value.length})` : 'unknown';
                console.log(`\n[interaction_update.${iFieldName}] ${valueInfo}`);
              }
            }
          }
          
          // field 2 = exec_server_message
          if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
            const execMsg = parseExecServerMessage(field.value);
            if (execMsg) {
              console.log(`\n[exec_server_message] type=${execMsg.messageType}, id=${execMsg.id}, execId=${execMsg.execId || 'N/A'}`);
              
              // Handle request_context_args
              if (execMsg.messageType === 'request_context_args') {
                console.log('  -> Responding with RequestContextResult');
                
                const result = buildRequestContextResult();
                const execClientMsg = buildExecClientMessage(
                  execMsg.id, 
                  execMsg.execId || '', 
                  'request_context_result', 
                  result
                );
                const responseMsg = buildAgentClientMessageWithExec(execClientMsg);
                
                await bidiAppend(requestId, appendSeqno++, responseMsg, headers);
                console.log('  -> Sent response');
              }
            }
          }
          
          // field 3 = conversation_checkpoint_update
          if (field.fieldNumber === 3 && field.wireType === 2) {
            console.log('\n[conversation_checkpoint_update] - response complete');
            turnEnded = true;  // This indicates the response is done
          }
          
          // field 7 = interaction_query
          if (field.fieldNumber === 7 && field.wireType === 2) {
            console.log('\n[interaction_query] - server asking for user input');
          }
          
          // field 4 = kv_server_message
          if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
            const kvMsg = parseKvServerMessage(field.value);
            console.log(`\n[kv_server_message] type=${kvMsg.messageType}, id=${kvMsg.id}, blobId=${kvMsg.blobId ? Buffer.from(kvMsg.blobId).toString('hex').slice(0, 32) + '...' : 'N/A'}`);
            
            if (kvMsg.messageType === 'get_blob_args' && kvMsg.blobId) {
              // Look up blob in our in-memory store
              const key = blobIdToKey(kvMsg.blobId);
              const data = blobStore.get(key);
              console.log(`  -> GetBlob: key=${key.slice(0, 16)}..., found=${!!data}`);
              
              const result = buildGetBlobResult(data);
              const kvClientMsg = buildKvClientMessage(kvMsg.id, 'get_blob_result', result);
              const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
              
              await bidiAppend(requestId, appendSeqno++, responseMsg, headers);
              console.log('  -> Sent GetBlobResult');
            } else if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
              // Store blob in our in-memory store
              const key = blobIdToKey(kvMsg.blobId);
              blobStore.set(key, kvMsg.blobData);
              console.log(`  -> SetBlob: key=${key.slice(0, 16)}..., size=${kvMsg.blobData.length}`);
              
              const result = buildSetBlobResult(); // No error
              const kvClientMsg = buildKvClientMessage(kvMsg.id, 'set_blob_result', result);
              const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
              
              await bidiAppend(requestId, appendSeqno++, responseMsg, headers);
              console.log('  -> Sent SetBlobResult');
            }
          }
        }
      }
      
      buffer = buffer.slice(offset);
      
      // If turn ended, we can break out of the loop
      if (turnEnded) {
        console.log('Turn ended, closing stream');
        controller.abort(); // Abort the fetch to clean up
        break;
      }
    }
    
    console.log('\n\n=== Full Response ===');
    console.log(fullText);
    
    reader.releaseLock();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log('Aborted due to timeout');
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(console.error);
