/**
 * Test the BidiSse flow - it works without the envelope!
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
    } else {
      break;
    }
  }
  
  return fields;
}

// Extract text from AgentServerMessage
// AgentServerMessage has oneof message:
// - interaction_update: field 1
// - interaction_query: field 2  
// - conversation_checkpoint_update: field 3
// etc.
function extractTextFromAgentServerMessage(data: Uint8Array): { type: string; text?: string } | null {
  const fields = parseProtoFields(data);
  
  for (const field of fields) {
    const fieldName = {
      1: 'interaction_update',
      2: 'interaction_query',
      3: 'conversation_checkpoint_update',
      4: 'exec_server_message',
      5: 'exec_server_control_message',
      6: 'kv_server_message',
    }[field.fieldNumber] ?? `field_${field.fieldNumber}`;
    
    // field 1 = interaction_update
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const interactionFields = parseProtoFields(field.value);
      for (const iField of interactionFields) {
        // field 1 = text_delta, field 4 = thinking_delta
        if ((iField.fieldNumber === 1 || iField.fieldNumber === 4) && 
            iField.wireType === 2 && iField.value instanceof Uint8Array) {
          const deltaFields = parseProtoFields(iField.value);
          for (const dField of deltaFields) {
            // field 1 = text
            if (dField.fieldNumber === 1 && dField.wireType === 2 && dField.value instanceof Uint8Array) {
              return { type: fieldName, text: new TextDecoder().decode(dField.value) };
            }
          }
        }
        // Also look for heartbeat (field 6)
        if (iField.fieldNumber === 6) {
          return { type: 'heartbeat' };
        }
      }
      return { type: fieldName };
    }
    
    // For other message types, just return the type
    if (field.wireType === 2) {
      return { type: fieldName };
    }
  }
  
  return null;
}

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
  
  // Build headers
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
  
  // Build BidiRequestId (raw protobuf, no envelope)
  const bidiRequestId = encodeStringField(1, requestId);
  console.log('BidiRequestId:', Buffer.from(bidiRequestId).toString('hex'));
  
  // Build AgentClientMessage for chat
  const userMessage = concatBytes(
    encodeStringField(1, "Say hello in one word."),  // text
    encodeStringField(2, messageId),                  // message_id
    encodeInt32Field(4, 2)                            // mode = ASK (2)
  );
  const userMessageAction = encodeMessageField(1, userMessage);
  const conversationAction = encodeMessageField(1, userMessageAction);
  const modelDetails = encodeStringField(1, "claude-3.5-sonnet");
  const emptyConvState = new Uint8Array(0);
  const agentRunRequest = concatBytes(
    encodeMessageField(1, emptyConvState),  // conversation_state (empty)
    encodeMessageField(2, conversationAction),
    encodeMessageField(3, modelDetails),
    encodeStringField(5, conversationId)
  );
  const agentClientMessage = encodeMessageField(1, agentRunRequest);
  
  console.log('AgentClientMessage length:', agentClientMessage.length);
  
  // Build BidiAppendRequest
  const hexData = Buffer.from(agentClientMessage).toString("hex");
  const bidiRequestIdForAppend = encodeStringField(1, requestId);
  const bidiAppendRequest = concatBytes(
    encodeStringField(1, hexData),                    // data (hex)
    encodeMessageField(2, bidiRequestIdForAppend),   // request_id
    encodeInt64Field(3, 0n)                           // append_seqno
  );
  
  console.log('BidiAppendRequest length:', bidiAppendRequest.length);
  
  // Start SSE stream (don't await - let it run in background)
  console.log('\n=== Starting RunSSE stream ===');
  
  // The SSE endpoint needs Connect's frame envelope (5-byte header)
  const sseEnvelope = addConnectEnvelope(bidiRequestId);
  console.log('SSE envelope:', Buffer.from(sseEnvelope).toString('hex'));
  
  const ssePromise = fetch("https://api2.cursor.sh/agent.v1.AgentService/RunSSE", {
    method: "POST",
    headers,
    body: Buffer.from(sseEnvelope),  // With envelope for server-streaming
  });
  
  // Immediately send BidiAppend
  console.log('\n=== Sending BidiAppend ===');
  
  const appendResponse = await fetch("https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend", {
    method: "POST",
    headers,
    body: Buffer.from(addConnectEnvelope(bidiAppendRequest)),  // With envelope for unary calls
  });
  
  console.log('BidiAppend status:', appendResponse.status);
  if (!appendResponse.ok) {
    const text = await appendResponse.text();
    console.log('BidiAppend error:', text);
  } else {
    console.log('BidiAppend success!');
  }
  
  // Now wait for SSE response
  console.log('\n=== Waiting for SSE response ===');
  const sseResponse = await ssePromise;
  console.log('SSE status:', sseResponse.status);
  console.log('SSE headers:', Object.fromEntries(sseResponse.headers.entries()));
  
  if (!sseResponse.body) {
    console.log('No body!');
    return;
  }
  
  const reader = sseResponse.body.getReader();
  let chunks = 0;
  const startTime = Date.now();
  let fullBuffer = new Uint8Array(0);
  
  while (Date.now() - startTime < 60000) {  // 60 second timeout
    const { done, value } = await reader.read();
    if (done) {
      console.log('\nStream done!');
      break;
    }
    
    chunks++;
    console.log(`\nChunk ${chunks}: ${value.length} bytes`);
    
    // Append to full buffer
    const newBuffer = new Uint8Array(fullBuffer.length + value.length);
    newBuffer.set(fullBuffer);
    newBuffer.set(value, fullBuffer.length);
    fullBuffer = newBuffer;
    
    // Parse all frames in the buffer
    let offset = 0;
    while (offset + 5 <= fullBuffer.length) {
      const flags = fullBuffer[offset];
      const length = (fullBuffer[offset + 1]! << 24) | (fullBuffer[offset + 2]! << 16) | 
                     (fullBuffer[offset + 3]! << 8) | fullBuffer[offset + 4]!;
      
      if (offset + 5 + length > fullBuffer.length) {
        // Incomplete frame, wait for more data
        break;
      }
      
      const frameData = fullBuffer.slice(offset + 5, offset + 5 + length);
      offset += 5 + length;
      
      if ((flags ?? 0) & 0x80) {
        // Trailer frame
        const trailer = new TextDecoder().decode(frameData);
        console.log('Trailer:', trailer);
      } else {
        // Data frame - try to extract text
        const result = extractTextFromAgentServerMessage(frameData);
        if (result) {
          if (result.text) {
            process.stdout.write(result.text);
          } else {
            console.log(`[${result.type}]`);
          }
        } else {
          console.log('Frame (unknown):', Buffer.from(frameData).toString('hex').slice(0, 100));
        }
      }
    }
    
    // Keep only unprocessed part
    fullBuffer = fullBuffer.slice(offset);
    
    if (chunks > 100) {
      console.log('\nMax chunks reached');
      break;
    }
  }
  
  reader.releaseLock();
}

main().catch(console.error);
