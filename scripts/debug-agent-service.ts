/**
 * Debug the Agent Service endpoints
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { addConnectEnvelope, generateChecksum, CURSOR_API_URL } from '../src/lib/api/cursor-client.ts';

// Simple proto encoder
function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  if (!value) return new Uint8Array(0);
  const fieldTag = (fieldNumber << 3) | 2;
  const encoded = new TextEncoder().encode(value);
  const length = encodeVarint(encoded.length);
  const result = new Uint8Array(1 + length.length + encoded.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(encoded, 1 + length.length);
  return result;
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 127) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return new Uint8Array(bytes);
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

function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
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

async function testEndpoint(url: string, headers: Record<string, string>, body: Uint8Array, label: string) {
  console.log(`\n--- ${label} ---`);
  console.log(`URL: ${url}`);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: Buffer.from(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    
    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);
    console.log(`grpc-status: ${res.headers.get('grpc-status')}`);
    console.log(`grpc-message: ${res.headers.get('grpc-message')}`);
    
    if (res.body) {
      const reader = res.body.getReader();
      let totalBytes = 0;
      const chunks: Uint8Array[] = [];
      
      const readTimeout = setTimeout(() => {
        reader.cancel();
      }, 5000);
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          chunks.push(value);
          if (totalBytes > 10000) {
            console.log(`Received ${totalBytes}+ bytes, stopping...`);
            break;
          }
        }
      } catch (e: any) {
        console.log(`Read error: ${e.message}`);
      } finally {
        clearTimeout(readTimeout);
        reader.releaseLock();
      }
      
      if (chunks.length > 0) {
        const combined = Buffer.concat(chunks);
        console.log(`Total bytes: ${totalBytes}`);
        console.log(`First 200 bytes (hex): ${combined.slice(0, 200).toString('hex')}`);
        
        // Try to decode text
        try {
          const text = combined.toString('utf-8');
          if (text.length < 1000 && /^[\x20-\x7E\n\r\t]*$/.test(text.slice(0, 100))) {
            console.log(`Text: ${text.slice(0, 500)}`);
          }
        } catch {}
      }
    }
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.log('Request timed out');
    } else {
      console.log(`Error: ${err.message}`);
    }
  }
}

async function main() {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('No token');

  const checksum = generateChecksum(token);
  
  // Build a minimal AgentClientMessage with run_request
  // AgentClientMessage.run_request (field 1) -> AgentRunRequest
  // AgentRunRequest.action (field 2) -> ConversationAction
  // ConversationAction.user_message_action (field 1) -> UserMessageAction
  // UserMessageAction.user_message (field 1) -> UserMessage
  // UserMessage.text (field 1), message_id (field 2), mode (field 4)
  
  const userMessage = concatBytes(
    encodeStringField(1, "Hello"),
    encodeStringField(2, randomUUID()),
    encodeInt32Field(4, 2) // ASK mode
  );
  const userMessageAction = encodeMessageField(1, userMessage);
  const conversationAction = encodeMessageField(1, userMessageAction);
  
  // ModelDetails: model_id (field 1)
  const modelDetails = encodeStringField(1, "claude-sonnet-4-20250514");
  
  // AgentRunRequest
  const agentRunRequest = concatBytes(
    encodeMessageField(2, conversationAction), // action
    encodeMessageField(3, modelDetails),       // model_details
    encodeStringField(5, randomUUID()),        // conversation_id
  );
  
  // AgentClientMessage
  const agentClientMessage = encodeMessageField(1, agentRunRequest);
  
  // Wrap in connect envelope
  const envelope = addConnectEnvelope(agentClientMessage);
  
  console.log(`Message size: ${agentClientMessage.length} bytes`);
  console.log(`Envelope size: ${envelope.length} bytes`);
  console.log(`Message hex: ${Buffer.from(agentClientMessage).toString('hex')}`);
  
  // Test with grpc-web content type
  const grpcWebHeaders = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/grpc-web+proto',
    'user-agent': 'connect-es/1.4.0',
    'x-cursor-checksum': checksum,
    'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
    'x-cursor-client-type': 'cli',
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
  } as Record<string, string>;

  // Test connect+proto content type
  const connectHeaders = {
    ...grpcWebHeaders,
    'content-type': 'application/connect+proto',
    'connect-accept-encoding': 'gzip,br',
    'connect-protocol-version': '1',
  };

  const endpoints = [
    { url: `${CURSOR_API_URL}/agent.v1.AgentService/Run`, headers: grpcWebHeaders, label: 'api2 Run (grpc-web)' },
    { url: `${CURSOR_API_URL}/agent.v1.AgentService/Run`, headers: connectHeaders, label: 'api2 Run (connect)' },
    { url: `${CURSOR_API_URL}/agent.v1.AgentService/RunSSE`, headers: grpcWebHeaders, label: 'api2 RunSSE (grpc-web)' },
    { url: 'https://agent.api5.cursor.sh/agent.v1.AgentService/Run', headers: grpcWebHeaders, label: 'agent.api5 Run (grpc-web)' },
    { url: 'https://agentn.api5.cursor.sh/agent.v1.AgentService/Run', headers: grpcWebHeaders, label: 'agentn.api5 Run (grpc-web)' },
  ];

  // First test empty payload to check endpoint health
  console.log('\n=== Testing with empty payload ===');
  const emptyEnvelope = addConnectEnvelope(new Uint8Array(0), 0);
  await testEndpoint(`${CURSOR_API_URL}/agent.v1.AgentService/Run`, grpcWebHeaders, emptyEnvelope, 'Empty Run (grpc-web)');

  console.log('\n=== Testing with actual message ===');
  for (const ep of endpoints) {
    await testEndpoint(ep.url, ep.headers, envelope, ep.label);
  }
}

main().catch(console.error);
