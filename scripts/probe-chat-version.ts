import { FileCredentialManager } from '../src/lib/storage.ts';
import { randomUUID } from 'node:crypto';
import { addConnectEnvelope, CURSOR_API_URL } from '../src/lib/api/cursor-client.ts';

async function call(method: string, version: string) {
  const cm = new FileCredentialManager();
  const token = await cm.getAccessToken();
  if (!token) throw new Error('no token');
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/connect+json',
    'connect-protocol-version': '1',
    'user-agent': 'connect-es/1.4.0',
    'x-cursor-client-version': version,
    'x-cursor-client-type': 'cli',
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
  } as Record<string, string>;

  const now = Math.floor(Date.now() / 1000);
  const conversationId = randomUUID();
  const requestId = randomUUID();

  const body = {
    conversation: [
      {
        role: 1,
        message: 'Say hello',
        messageId: randomUUID(),
        messageCreatedAt: { seconds: now, nanos: 0 },
        conversationId,
      },
    ],
    modelDetails: { modelId: 'gpt-5' },
    requestId,
    conversationId,
    query: 'Say hello',
  };

  const payload = new TextEncoder().encode(JSON.stringify(body));
  const envelope = addConnectEnvelope(payload, 0);

  const res = await fetch(`${CURSOR_API_URL}/aiserver.v1.AiService/${method}`, {
    method: 'POST',
    headers,
    body: Buffer.from(envelope),
  });
  const text = await res.text();
  console.log(method, version, 'status', res.status, 'ctype', res.headers.get('content-type'));
  console.log(text.slice(0, 200));
}

await call('StreamChat', 'cli-9999.99.99');
