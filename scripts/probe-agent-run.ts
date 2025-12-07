import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { addConnectEnvelope, CURSOR_API_URL, generateChecksum } from '../src/lib/api/cursor-client.ts';

/**
 * Test the AgentService endpoints with proper timeout handling
 */

async function testEndpoint(url: string, headers: Record<string, string>, body: Uint8Array, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: Buffer.from(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    
    console.log(`Status: ${res.status}`);
    const contentType = res.headers.get('content-type');
    console.log(`Content-Type: ${contentType}`);
    
    if (res.status === 200) {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 0) {
        const bytes = new Uint8Array(buffer);
        // Check if it's a connect-proto response
        if (bytes.length >= 5) {
          const flags = bytes[0];
          const length = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
          console.log(`Connect envelope: flags=${flags}, length=${length}`);
          if (length > 0 && bytes.length >= 5 + length) {
            const messageData = bytes.slice(5, 5 + length);
            console.log(`Message hex (first 100): ${Buffer.from(messageData.slice(0, 100)).toString('hex')}`);
            // Try text decode
            try {
              const text = new TextDecoder().decode(messageData);
              if (text.length < 500) {
                console.log(`Message text: ${text}`);
              }
            } catch {}
          }
        }
      }
      console.log(`Response size: ${buffer.byteLength} bytes`);
    } else {
      const text = await res.text();
      console.log(`Response: ${text.slice(0, 500)}`);
    }
    return res.status;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.log(`Timeout after ${timeoutMs}ms (possibly waiting for stream)`);
      return -1;
    }
    console.log(`Error: ${err.message}`);
    return -2;
  }
}

async function main() {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('no token');

  const checksum = generateChecksum(token);
  const requestId = randomUUID();

  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    'connect-accept-encoding': 'gzip,br',
    'connect-protocol-version': '1',
    'user-agent': 'connect-es/1.4.0',
    'x-cursor-checksum': checksum,
    'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
    'x-cursor-client-type': 'cli',
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'x-ghost-mode': 'true',
    'x-request-id': requestId,
  } as Record<string, string>;

  // Test unary endpoints first
  const unaryEndpoints = [
    '/agent.v1.AgentService/GetUsableModels',
    '/agent.v1.AgentService/GetDefaultModelForCli',
    '/aiserver.v1.AiService/GetUsableModels',
    '/aiserver.v1.AiService/GetDefaultModelForCli',
    '/aiserver.v1.AiService/AvailableModels',
    '/aiserver.v1.AiService/GetUserInfo',
    '/aiserver.v1.AiService/HealthCheck',
  ];

  // Empty proto payload
  const emptyPayload = addConnectEnvelope(new Uint8Array(0), 0);

  console.log('=== Testing Unary Endpoints ===\n');
  for (const endpoint of unaryEndpoints) {
    console.log(`\n--- ${endpoint} ---`);
    await testEndpoint(`${CURSOR_API_URL}${endpoint}`, headers, emptyPayload);
  }

  // Now test stream endpoints
  console.log('\n\n=== Testing Stream Endpoints ===\n');
  
  // Test StreamChat with empty payload
  console.log('\n--- /aiserver.v1.AiService/StreamChat (empty) ---');
  await testEndpoint(`${CURSOR_API_URL}/aiserver.v1.AiService/StreamChat`, headers, emptyPayload);

  // Test AgentService Run/RunSSE
  console.log('\n--- /agent.v1.AgentService/Run (empty) ---');
  await testEndpoint(`${CURSOR_API_URL}/agent.v1.AgentService/Run`, headers, emptyPayload);

  console.log('\n--- /agent.v1.AgentService/RunSSE (empty) ---');
  await testEndpoint(`${CURSOR_API_URL}/agent.v1.AgentService/RunSSE`, headers, emptyPayload, 3000);

  // Test BidiService
  console.log('\n--- /aiserver.v1.BidiService/BidiAppend (empty) ---');
  await testEndpoint(`${CURSOR_API_URL}/aiserver.v1.BidiService/BidiAppend`, headers, emptyPayload);
}

main().catch(console.error);
