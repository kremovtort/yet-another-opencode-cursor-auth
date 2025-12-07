/**
 * Test StreamChat endpoint with a proper request body
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { 
  addConnectEnvelope, 
  CURSOR_API_URL, 
  generateChecksum,
  encodeChatRequest,
  parseStreamChunks
} from '../src/lib/api/cursor-client.ts';

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

  // Build a proper chat request
  const chatRequest = {
    model: 'claude-3.5-sonnet',
    messages: [
      { role: 'user' as const, content: 'Say hello in one word.' }
    ]
  };

  console.log('Building chat request with message...');
  const messageBody = encodeChatRequest(chatRequest);
  console.log(`Message body size: ${messageBody.length} bytes`);
  console.log(`Message hex: ${Buffer.from(messageBody).toString('hex').slice(0, 200)}...`);
  
  const envelope = addConnectEnvelope(messageBody);
  console.log(`Envelope size: ${envelope.length} bytes`);

  // Try StreamChat
  console.log('\n--- Testing StreamChat with proper message ---');
  const res = await fetch(`${CURSOR_API_URL}/aiserver.v1.AiService/StreamChat`, {
    method: 'POST',
    headers,
    body: Buffer.from(envelope),
  });

  console.log(`Status: ${res.status}`);
  console.log(`Headers:`, Object.fromEntries(res.headers.entries()));

  if (res.body) {
    const buffer = new Uint8Array(await res.arrayBuffer());
    console.log(`Response size: ${buffer.length} bytes`);
    
    const chunks = parseStreamChunks(buffer);
    console.log(`Parsed ${chunks.length} chunks`);
    
    for (const chunk of chunks) {
      if (chunk.type === 'delta') {
        console.log('Content:', chunk.content);
      } else if (chunk.type === 'error') {
        console.log('Error:', chunk.error);
      }
    }
  }
}

main().catch(console.error);
