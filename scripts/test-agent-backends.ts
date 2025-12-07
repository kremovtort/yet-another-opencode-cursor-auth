/**
 * Test the AgentService endpoints on the correct backend URLs
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { addConnectEnvelope, generateChecksum } from '../src/lib/api/cursor-client.ts';

const AGENT_BACKEND_PRIVACY = "https://agent.api5.cursor.sh";
const AGENT_BACKEND_NON_PRIVACY = "https://agentn.api5.cursor.sh";
const REGULAR_BACKEND = "https://api2.cursor.sh";

async function testEndpoint(baseUrl: string, endpoint: string, headers: Record<string, string>, body: Uint8Array, timeoutMs = 5000) {
  const url = `${baseUrl}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    console.log(`Testing: ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: Buffer.from(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    
    console.log(`  Status: ${res.status}`);
    
    if (res.status === 200) {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 0) {
        const bytes = new Uint8Array(buffer);
        if (bytes.length >= 5) {
          const flags = bytes[0];
          const length = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
          console.log(`  Connect envelope: flags=${flags}, length=${length}`);
          if (length > 0 && bytes.length >= 5 + length) {
            const messageData = bytes.slice(5, 5 + length);
            // Try text decode
            try {
              const text = new TextDecoder().decode(messageData);
              if (text.length < 500) {
                console.log(`  Message text: ${text}`);
              } else {
                console.log(`  Message text (truncated): ${text.slice(0, 200)}...`);
              }
            } catch {}
          }
        }
      }
      console.log(`  Response size: ${buffer.byteLength} bytes`);
    } else {
      const text = await res.text();
      console.log(`  Response: ${text.slice(0, 300)}`);
    }
    return res.status;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.log(`  Timeout after ${timeoutMs}ms`);
      return -1;
    }
    console.log(`  Error: ${err.message}`);
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
    'x-cursor-streaming': 'true', // Signal SSE support
  } as Record<string, string>;

  const emptyPayload = addConnectEnvelope(new Uint8Array(0), 0);

  const backends = [
    { name: 'Regular', url: REGULAR_BACKEND },
    { name: 'Agent (privacy)', url: AGENT_BACKEND_PRIVACY },
    { name: 'Agent (non-privacy)', url: AGENT_BACKEND_NON_PRIVACY },
  ];

  const endpoints = [
    '/agent.v1.AgentService/GetUsableModels',
    '/agent.v1.AgentService/GetDefaultModelForCli',
    '/agent.v1.AgentService/NameAgent',
    '/agent.v1.AgentService/Run',
    '/agent.v1.AgentService/RunSSE',
    '/aiserver.v1.AiService/GetUsableModels',
    '/aiserver.v1.AiService/GetDefaultModelForCli',
    '/aiserver.v1.AiService/NameAgent',
    '/aiserver.v1.BidiService/BidiAppend',
  ];

  for (const backend of backends) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Backend: ${backend.name} (${backend.url})`);
    console.log('='.repeat(60));
    
    for (const endpoint of endpoints) {
      console.log('');
      await testEndpoint(backend.url, endpoint, headers, emptyPayload, 3000);
    }
  }
}

main().catch(console.error);
