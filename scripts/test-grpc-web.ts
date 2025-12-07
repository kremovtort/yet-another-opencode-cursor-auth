/**
 * Test various endpoints with grpc-web content type
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { addConnectEnvelope, generateChecksum, CURSOR_API_URL, encodeChatRequest } from '../src/lib/api/cursor-client.ts';

async function main() {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('no token');

  const checksum = generateChecksum(token);

  function makeHeaders() {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/grpc-web+proto',
      'user-agent': 'connect-es/1.4.0',
      'x-cursor-checksum': checksum,
      'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
      'x-cursor-client-type': 'cli',
      'x-ghost-mode': 'true',
      'x-request-id': randomUUID(),
    } as Record<string, string>;
  }

  const emptyPayload = addConnectEnvelope(new Uint8Array(0), 0);

  // Test unary endpoints
  console.log('=== Testing Unary Endpoints ===\n');
  
  const unaryEndpoints = [
    '/aiserver.v1.AiService/GetUsableModels',
    '/aiserver.v1.AiService/GetDefaultModelForCli',
    '/aiserver.v1.AiService/AvailableModels',
    '/aiserver.v1.AiService/HealthCheck',
    '/aiserver.v1.AiService/GetUserInfo',
    '/agent.v1.AgentService/GetUsableModels',
    '/agent.v1.AgentService/GetDefaultModelForCli',
    '/agent.v1.AgentService/NameAgent',
  ];

  for (const endpoint of unaryEndpoints) {
    console.log(`Testing: ${endpoint}`);
    try {
      const res = await fetch(`${CURSOR_API_URL}${endpoint}`, {
        method: 'POST',
        headers: makeHeaders(),
        body: Buffer.from(emptyPayload),
      });
      console.log(`  Status: ${res.status}`);
      if (res.status === 200) {
        const buf = await res.arrayBuffer();
        console.log(`  Response size: ${buf.byteLength} bytes`);
        // Try to decode
        if (buf.byteLength > 5) {
          const bytes = new Uint8Array(buf);
          const flags = bytes[0];
          const length = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
          console.log(`  gRPC frame: flags=${flags}, length=${length}`);
        }
      } else {
        const text = await res.text();
        console.log(`  Response: ${text.slice(0, 200)}`);
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
    console.log('');
  }

  // Test StreamChat with grpc-web content type
  console.log('\n=== Testing StreamChat ===\n');
  
  const chatRequest = {
    model: 'claude-3.5-sonnet',
    messages: [
      { role: 'user' as const, content: 'Say hello in one word.' }
    ]
  };

  const messageBody = encodeChatRequest(chatRequest);
  const envelope = addConnectEnvelope(messageBody);

  console.log('Testing StreamChat with proper message...');
  try {
    const res = await fetch(`${CURSOR_API_URL}/aiserver.v1.AiService/StreamChat`, {
      method: 'POST',
      headers: makeHeaders(),
      body: Buffer.from(envelope),
    });
    console.log(`Status: ${res.status}`);
    
    if (res.status === 200) {
      const buffer = new Uint8Array(await res.arrayBuffer());
      console.log(`Response size: ${buffer.length} bytes`);
      
      // Parse gRPC-web frames
      let offset = 0;
      while (offset + 5 <= buffer.length) {
        const flags = buffer[offset];
        const length = (buffer[offset + 1] << 24) |
                       (buffer[offset + 2] << 16) |
                       (buffer[offset + 3] << 8) |
                       buffer[offset + 4];
        offset += 5;
        
        console.log(`Frame: flags=${flags}, length=${length}`);
        
        if (offset + length <= buffer.length) {
          const data = buffer.slice(offset, offset + length);
          // Try to decode as text
          try {
            const text = new TextDecoder().decode(data);
            // Only show if it looks like text
            if (text.length < 500 && /^[\x20-\x7E\n\r\t]*$/.test(text.slice(0, 100))) {
              console.log(`  Text: ${text.slice(0, 200)}`);
            }
          } catch {}
          offset += length;
        } else {
          break;
        }
      }
    } else {
      const text = await res.text();
      console.log(`Response: ${text.slice(0, 500)}`);
    }
  } catch (err: any) {
    console.log(`Error: ${err.message}`);
  }
}

main().catch(console.error);
