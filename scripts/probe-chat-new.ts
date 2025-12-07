import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { addConnectEnvelope, CURSOR_API_URL } from '../src/lib/api/cursor-client.ts';

async function call(method: string) {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('no token');
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'user-agent': 'connect-es/1.4.0',
    'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
    'x-cursor-client-type': 'cli',
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
  } as Record<string, string>;

  // Empty proto payload
  const payload = new Uint8Array(0);
  const envelope = addConnectEnvelope(payload, 0);

  console.log(`Probing AiService/${method}...`);
  const res = await fetch(`${CURSOR_API_URL}/aiserver.v1.AiService/${method}`, {
    method: 'POST',
    headers,
    body: Buffer.from(envelope),
  });
  const text = await res.text();
  console.log(`AiService/${method}`, 'status', res.status);

  console.log(`Probing AgentService/${method}...`);
  const res2 = await fetch(`${CURSOR_API_URL}/agent.v1.AgentService/${method}`, {
    method: 'POST',
    headers,
    body: Buffer.from(envelope),
  });
  const text2 = await res2.text();
  console.log(`AgentService/${method}`, 'status', res2.status);
}

async function main() {
    const methods = [
        'StreamUnifiedChatWithTools',
        'streamUnifiedChatWithTools',
        'StreamUnifiedChat',
        'streamUnifiedChat',
        'StreamUnifiedChatWithToolsSSE',
        'streamUnifiedChatWithToolsSSE',
        'StreamChat',
        'StreamChat2',
        'UnifiedChat',
        'UnifiedChatStream',
    ];

    for (const method of methods) {
        await call(method);
    }
}

main().catch(console.error);
